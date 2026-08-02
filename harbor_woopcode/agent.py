"""Harbor agent that runs the WoopCode CLI inside a task environment.

Architecture
------------
WoopCode is a local, terminal-native coding agent that owns its own model loop
and tool execution. Harbor's ``BaseInstalledAgent`` is the contract built for
exactly that shape: Harbor provisions a container, this class installs the CLI
into it, then invokes the CLI once per task with the instruction as the prompt.
Harbor never sees the model calls -- that is the point. Benchmarking WoopCode
means benchmarking *WoopCode's* loop, so the harness must stay outside it.

The CLI is invoked in its headless single-turn mode (``woopcode -p``), which
runs to completion without a TUI and exits with a status code. Alongside the
human-readable stdout it writes a JSONL event log, which this class converts
into a Harbor ATIF trajectory so per-step tool calls show up in ``harbor view``
and the analysis tooling.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiRateLimitError,
    ApiUsageLimitError,
    BaseInstalledAgent,
    CliFlag,
    ContextWindowExceededError,
    ErrorPattern,
    ModelNotFoundError,
    NetworkConnectionError,
    UnknownApiError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json

#: Filename of the JSONL event log, written by the CLI's ``--events`` flag.
#: Lives under the agent log directory, which Harbor mounts from the host, so
#: the file is readable after the trial without an extra download step.
_EVENTS_FILENAME = "woopcode-events.jsonl"

#: Filename capturing the CLI's combined stdout/stderr, kept for debugging a
#: run whose event log is empty (an install problem, an immediate crash).
_STDOUT_FILENAME = "woopcode.txt"

#: In-environment directory Harbor mounts to the host-side ``logs_dir``.
_ENV_AGENT_LOG_DIR = "/logs/agent"

#: CLI exit code meaning "ran out of iterations"; see ``commands/agent.tsx``.
_EXIT_BUDGET_EXHAUSTED = 2

#: Attempts at the Bun install before giving up; the upstream download is
#: large and fails intermittently.
_BUN_INSTALL_ATTEMPTS = 3

#: Ceiling for the in-container Bun install step.
_BUN_INSTALL_TIMEOUT_SEC = 300

#: Ceiling for the one-off host-side download that populates the Bun cache.
#: Generous because it happens once per machine, not once per trial.
_BUN_DOWNLOAD_TIMEOUT_SEC = 900

#: Iteration budget for benchmark runs. WoopCode's interactive default (20) is
#: sized for a human watching their quota; a benchmark task gets one shot with
#: no follow-up turn, so it needs a much larger budget to be measured fairly.
_DEFAULT_MAX_ITERATIONS = 200

#: API-key variables forwarded from the host, keyed by the provider prefix in
#: Harbor's ``--model provider/name``. WoopCode reads these directly (see
#: ``config/envCredentials.ts``), so no config file has to exist in the
#: container -- which matters because every trial gets a fresh one.
_PROVIDER_KEY_VARS: dict[str, list[str]] = {
    "google": [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ],
    "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
}

#: Forwarded regardless of provider, so a key set without a ``provider/``
#: prefix on ``--model`` still reaches the CLI.
_ALWAYS_FORWARDED = ["WOOPCODE_API_KEY", "WOOPCODE_PROVIDER", "GEMINI_API_KEY"]


class WoopCode(BaseInstalledAgent):
    """Runs the ``woopcode`` CLI as a Harbor agent.

    Configuration (via ``--ak key=value`` on ``harbor run``):
        version: npm version spec to install (default ``latest``). Pin this for
            reproducible benchmark numbers.
        source_dir: host path to a WoopCode checkout to install instead of the
            published package. Use when benchmarking uncommitted changes.
        auto_approve: whether the agent may apply edits and run commands without
            asking (default ``True``). A benchmark has no human to approve, so
            turning this off makes almost every task fail by construction.
        max_iterations: loop budget for a single task (default
            ``_DEFAULT_MAX_ITERATIONS``).
    """

    # The CLI emits a structured event log that this class converts to ATIF.
    SUPPORTS_ATIF: bool = True

    # WoopCode's headless mode starts a fresh conversation each invocation and
    # has no session-continuation flag, so multi-step resume is unsupported.
    # Declaring this honestly makes Harbor fall back to fresh sessions rather
    # than silently losing context between steps.
    SUPPORTS_RESUME: bool = False

    # install() uses apt-get and POSIX shell.
    SUPPORTS_WINDOWS: bool = False

    _INSTALL_CHECK_COMMAND = (
        'export PATH="$HOME/.bun/bin:$PATH"; command -v woopcode >/dev/null 2>&1'
    )
    _INSTALL_VERSION_COMMAND = (
        'export PATH="$HOME/.bun/bin:$PATH"; woopcode --version'
    )

    CLI_FLAGS = [
        # Harbor's `-m provider/model` is split by BaseAgent; the bare model id
        # is passed through in run(). This flag exists so a run can override the
        # model without going through Harbor's model plumbing.
        CliFlag("model_id", cli="-m", type="str"),
    ]

    # Classifies a failed run into a specific exception type. Harbor's retry
    # policy targets these by name (`--retry-include ApiRateLimitError`), which
    # is what keeps a transient provider blip from being scored as a real
    # task failure.
    #
    # The base class's patterns are kept: this is a class attribute, so
    # assigning a bare list would silently discard Harbor's own classifications
    # (curl transport failures, generic provider errors) and report them as
    # unclassified agent crashes.
    ERROR_PATTERNS = [
        *BaseInstalledAgent.ERROR_PATTERNS,
        ErrorPattern(r"429|rate.?limit|RESOURCE_EXHAUSTED", ApiRateLimitError),
        ErrorPattern(r"quota exceeded|billing|usage limit", ApiUsageLimitError),
        ErrorPattern(
            r"API key not valid|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED"
            r"|No provider is configured",
            AgentAuthenticationError,
        ),
        ErrorPattern(
            r"not found for API version|is not supported|NOT_FOUND.*model"
            r"|Unknown provider",
            ModelNotFoundError,
        ),
        ErrorPattern(
            r"context length|token count.*exceeds|input is too long",
            ContextWindowExceededError,
        ),
        ErrorPattern(
            r"ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|TLS|certificate",
            NetworkConnectionError,
        ),
        ErrorPattern(r"INTERNAL|UNAVAILABLE|5\d\d error", UnknownApiError),
    ]

    def __init__(
        self,
        *args: Any,
        source_dir: str | None = None,
        auto_approve: bool = True,
        max_iterations: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._source_dir = source_dir
        self._auto_approve = auto_approve
        self._max_iterations = max_iterations or _DEFAULT_MAX_ITERATIONS
        # Captured in run() so the trajectory can open with the user turn; the
        # event log records the prompt too, but run() has the rendered form
        # after any prompt template has been applied.
        self._instruction: str | None = None

    @staticmethod
    @override
    def name() -> str:
        # Not a member of Harbor's AgentName enum -- this agent is registered by
        # import path, so the name is only used for reporting.
        return "woopcode"

    @override
    def get_version_command(self) -> str | None:
        return self._INSTALL_VERSION_COMMAND

    # ------------------------------------------------------------------
    # Install
    # ------------------------------------------------------------------

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Install Bun and the WoopCode CLI into the environment.

        WoopCode's entrypoint has a ``#!/usr/bin/env bun`` shebang and uses
        Bun-native APIs, so Bun is a hard runtime requirement rather than a
        build-time choice -- Node cannot run this CLI.
        """
        # unzip is required by Bun's installer; curl fetches it. ca-certificates
        # is needed for the TLS calls the agent itself makes later.
        await self.exec_as_root(
            environment,
            command=(
                # Harbor allows 360s for the whole of agent setup, and
                # `apt-get update` alone can consume a large share of it. Most
                # task images already ship curl and unzip, so the package step
                # only runs when something is actually missing.
                "if command -v curl >/dev/null 2>&1 && "
                "command -v unzip >/dev/null 2>&1; then "
                'echo "[harbor] curl and unzip already present"; '
                "else "
                "apt-get update && "
                "apt-get install -y --no-install-recommends "
                "curl unzip ca-certificates; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        await self._install_bun(environment)

        if self._source_dir:
            await self._install_from_source(environment)
        else:
            await self._install_from_registry(environment)

        # Bun installs global binaries to ~/.bun/bin, which is not on PATH for
        # a non-login shell. Symlinking into /usr/local/bin means every later
        # command can call `woopcode` plainly, including any the task itself
        # runs, without each one re-exporting PATH.
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                'BUN_BIN="$(getent passwd '
                f"{shlex.quote(str(environment.default_user or 'root'))}"
                ' | cut -d: -f6)/.bun/bin"; '
                'ln -sf "$BUN_BIN/woopcode" /usr/local/bin/woopcode; '
                'ln -sf "$BUN_BIN/bun" /usr/local/bin/bun; '
                "woopcode --version"
            ),
        )

    def _cached_bun_zip(self, arch: str) -> Path:
        """Return a host-cached Bun release zip for *arch*, downloading once.

        Every trial gets a fresh container, so installing Bun from the network
        each time means re-downloading ~40MB per task -- 89 times for a full
        terminal-bench-2 run. That is slow and, as observed in testing, flaky
        enough to fail trials outright before the agent runs. Fetching once on
        the host and pushing the bytes into each container removes the
        per-trial network dependency entirely.
        """
        cache_dir = Path.home() / ".cache" / "harbor-woopcode"
        cache_dir.mkdir(parents=True, exist_ok=True)
        zip_path = cache_dir / f"bun-linux-{arch}.zip"

        # A previous interrupted download can leave a truncated file behind;
        # treat anything implausibly small as absent rather than shipping a
        # corrupt archive into every container.
        if zip_path.exists() and zip_path.stat().st_size > 1_000_000:
            return zip_path

        url = (
            "https://github.com/oven-sh/bun/releases/latest/download/"
            f"bun-linux-{arch}.zip"
        )
        self.logger.debug(f"Caching Bun for {arch} from {url}")
        tmp_path = zip_path.with_suffix(".zip.partial")
        subprocess.run(
            [
                "curl", "-fsSL", "--retry", "3", "--retry-all-errors",
                "--connect-timeout", "30", "-o", str(tmp_path), url,
            ],
            check=True,
            capture_output=True,
            timeout=_BUN_DOWNLOAD_TIMEOUT_SEC,
        )
        # Rename only after a complete download, so the cache never holds a
        # partial file that later runs would trust.
        tmp_path.replace(zip_path)
        return zip_path

    async def _install_bun(self, environment: BaseEnvironment) -> None:
        """Install the Bun runtime, preferring the host cache.

        WoopCode's entrypoint has a ``#!/usr/bin/env bun`` shebang and uses
        Bun-native APIs, so Bun is a hard runtime requirement -- Node cannot run
        this CLI.
        """
        probe = await self._exec(
            environment,
            command=(
                'if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; '
                'then echo present; else uname -m; fi'
            ),
        )
        marker = (probe.stdout or "").strip().splitlines()[-1:] or [""]
        if marker[0] == "present":
            return

        arch = {"x86_64": "x64", "aarch64": "aarch64", "arm64": "aarch64"}.get(
            marker[0]
        )

        if arch:
            try:
                zip_path = self._cached_bun_zip(arch)
                await self._install_bun_from_zip(environment, zip_path)
                return
            except Exception as exc:
                # The cache is an optimisation, not a requirement. Fall back to
                # the official installer rather than failing the trial.
                self.logger.debug(
                    f"Cached Bun install failed ({exc}); using the network installer"
                )

        await self._install_bun_from_network(environment)

    async def _install_bun_from_zip(
        self, environment: BaseEnvironment, zip_path: Path
    ) -> None:
        """Push a cached Bun release into the environment and unpack it."""
        await self.exec_as_agent(
            environment, command='mkdir -p "$HOME/.bun/bin"'
        )
        await environment.upload_file(zip_path, "/tmp/bun.zip")
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "rm -rf /tmp/bun-unzip && mkdir -p /tmp/bun-unzip && "
                "unzip -q -o /tmp/bun.zip -d /tmp/bun-unzip && "
                # The archive nests the binary under a platform-named folder
                # whose exact name tracks the release, so locate it rather than
                # hard-coding a path that a future release would break.
                'BUN_BIN="$(find /tmp/bun-unzip -type f -name bun | head -1)"; '
                '[ -n "$BUN_BIN" ] || { echo "bun not found in archive"; exit 1; }; '
                'install -m 0755 "$BUN_BIN" "$HOME/.bun/bin/bun"; '
                "rm -rf /tmp/bun-unzip /tmp/bun.zip; "
                '"$HOME/.bun/bin/bun" --version'
            ),
            timeout_sec=_BUN_INSTALL_TIMEOUT_SEC,
        )

    async def _install_bun_from_network(
        self, environment: BaseEnvironment
    ) -> None:
        """Install Bun with the official installer, retrying transient failures.

        The download fails intermittently (`curl: (18) Transferred a partial
        file`), and a failed install aborts the trial before the agent ever
        runs -- an infrastructure flake scored as an agent failure.
        """
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export PATH="$HOME/.bun/bin:$PATH"; '
                f"for attempt in $(seq 1 {_BUN_INSTALL_ATTEMPTS}); do "
                "curl -fsSL --retry 2 --retry-all-errors --connect-timeout 15 "
                "https://bun.sh/install | bash && break; "
                'echo "[harbor] bun install attempt $attempt failed; retrying"; '
                'rm -rf "$HOME/.bun"; sleep 2; '
                "done; "
                'export PATH="$HOME/.bun/bin:$PATH"; bun --version'
            ),
            timeout_sec=_BUN_INSTALL_TIMEOUT_SEC,
        )

    async def _install_from_registry(self, environment: BaseEnvironment) -> None:
        """Install the published ``woopcode`` package from npm."""
        spec = f"woopcode@{self._version}" if self._version else "woopcode@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export PATH="$HOME/.bun/bin:$PATH"; '
                f"bun install -g {shlex.quote(spec)}"
            ),
        )

    async def _install_from_source(self, environment: BaseEnvironment) -> None:
        """Install from a host checkout, for benchmarking unreleased changes.

        This is what makes it possible to measure a change before publishing
        it; without it, every experiment would need an npm release first.

        The tree is shipped as a single tarball rather than a directory upload.
        ``node_modules`` and ``.git`` are excluded because they are large and,
        in the case of ``node_modules``, may hold host-architecture binaries
        that would not run in the container -- dependencies are resolved inside
        the container instead.
        """
        assert self._source_dir is not None
        source = Path(self._source_dir).expanduser().resolve()
        if not (source / "package.json").exists():
            raise RuntimeError(
                f"source_dir {source} does not look like a WoopCode checkout "
                "(no package.json)"
            )

        target = "/opt/woopcode-src"

        with tempfile.TemporaryDirectory() as tmp:
            tarball = Path(tmp) / "woopcode-src.tar.gz"
            subprocess.run(
                [
                    "tar",
                    "-czf",
                    str(tarball),
                    "--exclude=./node_modules",
                    "--exclude=./.git",
                    "--exclude=./jobs",
                    "-C",
                    str(source),
                    ".",
                ],
                check=True,
                capture_output=True,
            )
            await self.exec_as_root(
                environment, command=f"mkdir -p {target} && chmod 0777 {target}"
            )
            await environment.upload_file(tarball, f"{target}/src.tar.gz")

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export PATH="$HOME/.bun/bin:$PATH"; '
                f"cd {target} && tar -xzf src.tar.gz && rm -f src.tar.gz && "
                # `bun install` (not --production): the CLI's entrypoint is
                # TypeScript executed directly by Bun, so type-only packages in
                # devDependencies must be resolvable at run time.
                f"bun install && bun install -g {target} && "
                'woopcode --version'
            ),
        )

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------

    def _build_env(self) -> dict[str, str]:
        """Collect the environment the CLI needs, forwarded from the host.

        Credentials are passed as environment variables rather than written to
        a config file so no secret is persisted in the container image or in
        the trial's log mount.
        """
        env: dict[str, str] = {}

        names = list(_ALWAYS_FORWARDED)
        provider = self._parsed_model_provider
        if provider:
            names.extend(_PROVIDER_KEY_VARS.get(provider, []))
        else:
            # Without a provider prefix, forward every key we know about and
            # let the CLI pick by its own precedence order.
            for keys in _PROVIDER_KEY_VARS.values():
                names.extend(keys)

        for name in dict.fromkeys(names):
            value = self._get_env(name)
            if value:
                env[name] = value

        if provider and "WOOPCODE_PROVIDER" not in env:
            env["WOOPCODE_PROVIDER"] = provider

        # Suppresses the onboarding wizard. Without it, an unconfigured run
        # would render an Ink UI into a pipe and block until Harbor's agent
        # timeout, turning a credential mistake into a silent 20-minute stall.
        env["WOOPCODE_NON_INTERACTIVE"] = "1"

        # Keeps config writes inside the mounted log dir, so a container with a
        # read-only or absent HOME still starts.
        env["XDG_CONFIG_HOME"] = f"{_ENV_AGENT_LOG_DIR}/woopcode-config"

        # Raise the loop budget well above the interactive default; see
        # _DEFAULT_MAX_ITERATIONS.
        env["WOOPCODE_MAX_ITERATIONS"] = str(self._max_iterations)

        return env

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._instruction = instruction

        env = self._build_env()
        events_path = f"{_ENV_AGENT_LOG_DIR}/{_EVENTS_FILENAME}"
        stdout_path = f"{_ENV_AGENT_LOG_DIR}/{_STDOUT_FILENAME}"

        parts = ["woopcode", "-p", shlex.quote(instruction)]

        # Harbor's `-m provider/model`; the CLI wants the bare model id.
        model_id = self._resolved_flags.get("model_id") or self._parsed_model_name
        if model_id:
            parts += ["-m", shlex.quote(str(model_id))]

        parts += ["--events", events_path]
        if not self._auto_approve:
            parts.append("--no-auto-approve")

        command = " ".join(parts)
        rc_path = f"{_ENV_AGENT_LOG_DIR}/woopcode.rc"

        # Exit code 2 means the CLI ran out of iterations. That is an ordinary
        # benchmark outcome -- the agent worked and did not finish -- so it is
        # mapped to success here and left to the verifier to score. Raising
        # instead would book it as a Harbor exception, which would remove the
        # trial from the mean and overstate the agent's measured accuracy.
        #
        # The exit code has to be captured inside the pipeline because the
        # pipe's own status is tee's. `</dev/null` guarantees the CLI can never
        # block on stdin, and `stdbuf -oL tee` streams line-by-line so a run
        # killed at the timeout still leaves a partial transcript on disk
        # rather than losing it in a pipe buffer.
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {_ENV_AGENT_LOG_DIR}; "
                f"{{ {command} 2>&1 </dev/null; echo $? >{rc_path}; }} "
                f"| stdbuf -oL tee {stdout_path}; "
                f'rc="$(cat {rc_path} 2>/dev/null || echo 1)"; '
                f'if [ "$rc" = "{_EXIT_BUDGET_EXHAUSTED}" ]; then '
                'echo "[harbor] woopcode stopped at its iteration budget"; '
                "exit 0; fi; "
                'exit "$rc"'
            ),
            env=env,
        )

    # ------------------------------------------------------------------
    # Trajectory
    # ------------------------------------------------------------------

    def _read_events(self) -> list[dict[str, Any]]:
        """Read the JSONL event log written by the CLI.

        Malformed lines are skipped rather than fatal: the log is a diagnostic
        artifact, and a truncated final line (the normal result of a run killed
        mid-write at a timeout) must not discard the steps before it.
        """
        path = self.logs_dir / _EVENTS_FILENAME
        if not path.exists():
            return []

        events: list[dict[str, Any]] = []
        for line in path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events

    @staticmethod
    def _aggregate_usage(events: list[dict[str, Any]]) -> dict[str, Any]:
        """Sum the per-iteration token counts the CLI reports.

        Every count is the provider's own, so summing them is exact. An
        iteration whose provider reported nothing contributes nothing, and a
        run where none reported leaves the totals ``None`` rather than zero --
        Harbor's aggregates cannot tell 'free' from 'unknown', so an absent
        measurement has to stay absent.

        Prompt tokens are summed across iterations, which double-counts the
        conversation on purpose: it is what the run actually paid, and paying
        repeatedly for the same context is the cost the loop's context handling
        is judged on.
        """
        totals: dict[str, int] = {}
        segments: dict[str, int] = {}
        iterations = 0

        for event in events:
            if event.get("type") != "iteration":
                continue
            iterations += 1

            usage = event.get("usage")
            if isinstance(usage, dict):
                for source, target in (
                    ("promptTokens", "prompt"),
                    ("completionTokens", "completion"),
                    ("cachedTokens", "cached"),
                ):
                    value = usage.get(source)
                    if isinstance(value, int):
                        totals[target] = totals.get(target, 0) + value

            measured = event.get("segments")
            if isinstance(measured, dict):
                for name, value in measured.items():
                    if isinstance(value, int):
                        segments[name] = segments.get(name, 0) + value

        return {
            "iterations": iterations,
            "prompt_tokens": totals.get("prompt"),
            "completion_tokens": totals.get("completion"),
            "cached_tokens": totals.get("cached"),
            # Mean characters per iteration, which is what identifies the
            # segment that grows; the totals above carry the absolute cost.
            "mean_segment_chars": {
                name: round(total / iterations)
                for name, total in segments.items()
            }
            if iterations
            else {},
        }

    @staticmethod
    def _valid_timestamp(value: Any) -> str | None:
        """Return *value* if it is an ISO 8601 instant, else None.

        ATIF validates timestamps, so a single malformed one would otherwise
        abort the whole conversion and lose an entire run's trajectory. A step
        with no timestamp is a far smaller loss than no trajectory at all.
        """
        if not isinstance(value, str):
            return None
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return value

    def _build_trajectory(self, events: list[dict[str, Any]]) -> Trajectory | None:
        """Convert CLI events into an ATIF trajectory.

        Text deltas are coalesced and flushed at each tool call, so one step
        holds the assistant's message together with the calls it made and their
        results -- the unit Harbor's viewer and analysis tools expect.
        """
        start = next((e for e in events if e.get("type") == "run_start"), {})
        model_name = start.get("model") or self._parsed_model_name

        steps: list[Step] = []
        # ATIF step ids are 1-indexed and must be contiguous; Trajectory
        # validates this on serialisation.
        step_id = 1

        if self._instruction or start.get("prompt"):
            steps.append(
                Step(
                    step_id=step_id,
                    source="user",
                    timestamp=self._valid_timestamp(start.get("ts")),
                    message=self._instruction or start.get("prompt", ""),
                )
            )
            step_id += 1

        pending_text: list[str] = []
        pending_calls: list[ToolCall] = []
        results_by_id: dict[str, ObservationResult] = {}
        last_ts: str | None = self._valid_timestamp(start.get("ts"))

        def flush() -> None:
            nonlocal step_id, pending_text, pending_calls
            if not pending_text and not pending_calls:
                return
            observation = None
            if pending_calls:
                results = [
                    results_by_id[c.tool_call_id]
                    for c in pending_calls
                    if c.tool_call_id in results_by_id
                ]
                if results:
                    observation = Observation(results=results)
            steps.append(
                Step(
                    step_id=step_id,
                    source="agent",
                    timestamp=last_ts,
                    model_name=model_name,
                    message="".join(pending_text),
                    tool_calls=pending_calls or None,
                    observation=observation,
                )
            )
            step_id += 1
            pending_text = []
            pending_calls = []

        for event in events:
            kind = event.get("type")
            last_ts = self._valid_timestamp(event.get("ts")) or last_ts

            if kind == "text":
                pending_text.append(event.get("text", ""))
            elif kind == "tool_call":
                pending_calls.append(
                    ToolCall(
                        tool_call_id=str(event.get("id", "")),
                        function_name=str(event.get("name", "")),
                        arguments=event.get("arguments") or {},
                    )
                )
            elif kind in ("tool_result", "tool_error"):
                call_id = str(event.get("id", ""))
                content = (
                    event.get("output")
                    if kind == "tool_result"
                    else f"ERROR: {event.get('error', '')}"
                )
                results_by_id[call_id] = ObservationResult(
                    source_call_id=call_id, content=content
                )
                # A completed tool round closes the step it belongs to.
                if any(c.tool_call_id == call_id for c in pending_calls):
                    if all(c.tool_call_id in results_by_id for c in pending_calls):
                        flush()
            elif kind == "error":
                pending_text.append(f"\n[error] {event.get('message', '')}")

        flush()

        if not steps:
            return None

        usage = self._aggregate_usage(events)

        return Trajectory(
            agent=Agent(
                name=self.name(),
                version=start.get("version") or self.version() or "unknown",
                model_name=model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_steps=len(steps),
                total_prompt_tokens=usage["prompt_tokens"],
                total_completion_tokens=usage["completion_tokens"],
                total_cached_tokens=usage["cached_tokens"],
                # Cost stays unset: pricing is per-model and lives outside this
                # repository, so deriving it here would be a guess.
            ),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Write the ATIF trajectory and record run metadata.

        Token counts come from the CLI's per-iteration ``iteration`` events,
        which carry the provider's own figures. A run whose provider reported
        none leaves them unset rather than zero: Harbor's aggregates cannot
        distinguish 'free' from 'unknown', so a missing measurement has to stay
        missing. Cost is always unset -- pricing is per-model and lives outside
        this repository.
        """
        events = self._read_events()
        if not events:
            return

        try:
            trajectory = self._build_trajectory(events)
        except Exception:
            self.logger.exception("Failed to convert woopcode events to trajectory")
            return

        if trajectory is None:
            return

        path = self.logs_dir / "trajectory.json"
        try:
            path.write_text(format_trajectory_json(trajectory.to_json_dict()))
        except OSError as exc:
            self.logger.debug(f"Failed to write trajectory file {path}: {exc}")

        end = next(
            (e for e in reversed(events) if e.get("type") == "run_end"),
            None,
        )
        usage = self._aggregate_usage(events)
        summary = (end or {}).get("summary") or {}

        context.n_input_tokens = usage["prompt_tokens"]
        context.n_output_tokens = usage["completion_tokens"]
        context.n_cache_tokens = usage["cached_tokens"]

        context.metadata = {
            **(context.metadata or {}),
            "woopcode_events": len(events),
            "woopcode_completed": bool(end and end.get("ok")),
            "woopcode_tool_calls": sum(
                1 for e in events if e.get("type") == "tool_call"
            ),
            "woopcode_iterations": usage["iterations"],
            # Separates a slow run from a flaky one. A trial that retried its
            # way to an answer scored the same as one that never stumbled, and
            # the difference only shows up here.
            "woopcode_retries": sum(1 for e in events if e.get("type") == "retry"),
            "woopcode_mean_segment_chars": usage["mean_segment_chars"],
            # Whether the run finished having changed files without running
            # anything afterwards. Absent on a run from a CLI that predates the
            # summary, which is not the same as False.
            "woopcode_unverified_edits": summary.get("unverifiedEdits"),
        }
