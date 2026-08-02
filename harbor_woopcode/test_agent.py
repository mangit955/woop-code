"""Tests for the WoopCode Harbor agent.

Run with::

    PYTHONPATH=. python3 -m pytest harbor_woopcode/test_agent.py -q

These cover the pure logic -- event parsing, trajectory conversion, and
environment construction. Install and run are exercised end to end by an actual
``harbor run``; see harbor_woopcode/README.md.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harbor.models.agent.context import AgentContext
from harbor_woopcode import WoopCode

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def write_events(logs_dir: Path, events: list[dict]) -> None:
    path = logs_dir / "woopcode-events.jsonl"
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")


def make_agent(logs_dir: Path, **kwargs) -> WoopCode:
    kwargs.setdefault("model_name", "google/gemini-3.5-flash-lite")
    return WoopCode(logs_dir=logs_dir, **kwargs)


SIMPLE_RUN = [
    {
        "type": "run_start",
        "ts": "2026-01-01T00:00:00.000Z",
        "model": "gemini-3.5-flash-lite",
        "version": "0.6.1",
        "prompt": "make hello.txt",
    },
    {
        "type": "tool_call",
        "ts": "2026-01-01T00:00:01.000Z",
        "id": "t1",
        "name": "create_file",
        "arguments": {"path": "hello.txt"},
    },
    {
        "type": "tool_result",
        "ts": "2026-01-01T00:00:02.000Z",
        "id": "t1",
        "name": "create_file",
        "output": "Created file",
    },
    {"type": "text", "ts": "2026-01-01T00:00:03.000Z", "text": "Done"},
    {"type": "run_end", "ts": "2026-01-01T00:00:04.000Z", "ok": True},
]


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------


def test_agent_is_importable_by_harbor(tmp_path: Path) -> None:
    """Harbor resolves custom agents by import path; this is that contract."""
    from harbor.agents.base import BaseAgent
    from harbor.utils.import_path import import_class

    cls = import_class("harbor_woopcode:WoopCode", base=BaseAgent, label="agent")
    assert cls is WoopCode
    assert cls.name() == "woopcode"


def test_model_name_is_split_into_provider_and_model(tmp_path: Path) -> None:
    info = make_agent(tmp_path).to_agent_info()
    assert info.model_info is not None
    assert info.model_info.provider == "google"
    assert info.model_info.name == "gemini-3.5-flash-lite"


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------


def test_env_disables_the_onboarding_wizard(tmp_path: Path) -> None:
    """Without this the CLI would block on input Harbor can never supply."""
    assert make_agent(tmp_path)._build_env()["WOOPCODE_NON_INTERACTIVE"] == "1"


def test_env_raises_the_iteration_budget(tmp_path: Path) -> None:
    env = make_agent(tmp_path, max_iterations=99)._build_env()
    assert env["WOOPCODE_MAX_ITERATIONS"] == "99"


def test_env_forwards_only_the_provider_key(tmp_path: Path) -> None:
    agent = make_agent(
        tmp_path,
        extra_env={"GEMINI_API_KEY": "g", "OPENAI_API_KEY": "o"},
    )
    env = agent._build_env()
    assert env["GEMINI_API_KEY"] == "g"
    assert "OPENAI_API_KEY" not in env
    assert env["WOOPCODE_PROVIDER"] == "google"


def test_env_without_a_provider_prefix_forwards_all_known_keys(
    tmp_path: Path,
) -> None:
    agent = WoopCode(
        logs_dir=tmp_path,
        model_name="gemini-3.5-flash-lite",
        extra_env={"OPENAI_API_KEY": "o"},
    )
    assert agent._build_env()["OPENAI_API_KEY"] == "o"


# --------------------------------------------------------------------------
# Error classification
# --------------------------------------------------------------------------


class _Result:
    """Stand-in for an ExecResult from a failed command."""

    def __init__(self, stdout: str = "", stderr: str = "") -> None:
        self.return_code = 1
        self.stdout = stdout
        self.stderr = stderr


def classify(tmp_path: Path, output: str):
    return make_agent(tmp_path)._classify_exec_error("cmd", _Result(output))


def test_rate_limits_are_classified_for_retry(tmp_path: Path) -> None:
    """Harbor's --retry-include targets these by name; misclassifying a
    transient limit as a crash books it as a real task failure."""
    from harbor.agents.installed.base import ApiRateLimitError

    assert isinstance(
        classify(tmp_path, "Rate limit exceeded RESOURCE_EXHAUSTED"),
        ApiRateLimitError,
    )


def test_missing_credentials_are_classified(tmp_path: Path) -> None:
    from harbor.agents.installed.base import AgentAuthenticationError

    assert isinstance(
        classify(tmp_path, "No provider is configured and there is no terminal"),
        AgentAuthenticationError,
    )


def test_base_class_patterns_are_not_discarded(tmp_path: Path) -> None:
    """ERROR_PATTERNS is a class attribute: assigning a bare list would drop
    Harbor's own classifications and report them as unclassified crashes."""
    from harbor.agents.installed.base import NetworkConnectionError

    assert isinstance(
        classify(tmp_path, "curl: (18) Transferred a partial file"),
        NetworkConnectionError,
    )


# --------------------------------------------------------------------------
# Event parsing
# --------------------------------------------------------------------------


def test_missing_event_log_yields_no_events(tmp_path: Path) -> None:
    assert make_agent(tmp_path)._read_events() == []


def test_truncated_final_line_is_skipped(tmp_path: Path) -> None:
    """A run killed mid-write must not discard the steps before it."""
    path = tmp_path / "woopcode-events.jsonl"
    path.write_text(
        json.dumps(SIMPLE_RUN[0]) + "\n" + '{"type": "tool_call", "id": "t1"'
    )

    events = make_agent(tmp_path)._read_events()
    assert [e["type"] for e in events] == ["run_start"]


def test_blank_lines_are_ignored(tmp_path: Path) -> None:
    path = tmp_path / "woopcode-events.jsonl"
    path.write_text(f"\n{json.dumps(SIMPLE_RUN[0])}\n\n")
    assert len(make_agent(tmp_path)._read_events()) == 1


# --------------------------------------------------------------------------
# Trajectory conversion
# --------------------------------------------------------------------------


def test_trajectory_has_user_then_agent_steps(tmp_path: Path) -> None:
    trajectory = make_agent(tmp_path)._build_trajectory(SIMPLE_RUN)
    assert trajectory is not None

    sources = [s.source for s in trajectory.steps]
    assert sources[0] == "user"
    assert set(sources[1:]) == {"agent"}


def test_step_ids_are_contiguous_from_one(tmp_path: Path) -> None:
    """ATIF requires this; Trajectory validates it on serialisation."""
    trajectory = make_agent(tmp_path)._build_trajectory(SIMPLE_RUN)
    assert trajectory is not None
    assert [s.step_id for s in trajectory.steps] == list(
        range(1, len(trajectory.steps) + 1)
    )
    trajectory.to_json_dict()  # raises if the sequence is wrong


def test_tool_call_and_result_share_a_step(tmp_path: Path) -> None:
    trajectory = make_agent(tmp_path)._build_trajectory(SIMPLE_RUN)
    assert trajectory is not None

    step = next(s for s in trajectory.steps if s.tool_calls)
    assert step.tool_calls is not None
    assert step.tool_calls[0].function_name == "create_file"
    assert step.observation is not None
    assert step.observation.results[0].source_call_id == "t1"


def test_tool_errors_are_recorded_as_observations(tmp_path: Path) -> None:
    events = [
        SIMPLE_RUN[0],
        {"type": "tool_call", "ts": "2026-01-01T00:00:05.000Z", "id": "e1", "name": "read_file",
         "arguments": {}},
        {"type": "tool_error", "ts": "2026-01-01T00:00:05.000Z", "id": "e1", "name": "read_file",
         "error": "does not exist"},
    ]
    trajectory = make_agent(tmp_path)._build_trajectory(events)
    assert trajectory is not None

    step = next(s for s in trajectory.steps if s.tool_calls)
    assert step.observation is not None
    assert "does not exist" in str(step.observation.results[0].content)


def test_text_deltas_are_coalesced(tmp_path: Path) -> None:
    events = [
        SIMPLE_RUN[0],
        {"type": "text", "ts": "2026-01-01T00:00:05.000Z", "text": "Hello "},
        {"type": "text", "ts": "2026-01-01T00:00:05.000Z", "text": "world"},
    ]
    trajectory = make_agent(tmp_path)._build_trajectory(events)
    assert trajectory is not None
    assert trajectory.steps[-1].message == "Hello world"


def test_empty_events_yield_no_trajectory(tmp_path: Path) -> None:
    assert make_agent(tmp_path)._build_trajectory([]) is None


def test_a_malformed_timestamp_does_not_lose_the_trajectory(
    tmp_path: Path,
) -> None:
    """ATIF validates timestamps; dropping one beats discarding the run."""
    events = [
        SIMPLE_RUN[0],
        {"type": "text", "ts": "not-a-timestamp", "text": "still recorded"},
    ]
    trajectory = make_agent(tmp_path)._build_trajectory(events)

    assert trajectory is not None
    assert trajectory.steps[-1].message == "still recorded"
    trajectory.to_json_dict()  # would raise if an invalid ts leaked through


def test_a_non_string_timestamp_is_dropped(tmp_path: Path) -> None:
    events = [{"type": "text", "ts": 12345, "text": "hi"}]
    trajectory = make_agent(tmp_path)._build_trajectory(events)

    assert trajectory is not None
    assert trajectory.steps[-1].timestamp is None


# --------------------------------------------------------------------------
# Context population
# --------------------------------------------------------------------------


def test_populate_context_writes_a_trajectory_file(tmp_path: Path) -> None:
    write_events(tmp_path, SIMPLE_RUN)
    agent = make_agent(tmp_path)

    context = AgentContext()
    agent.populate_context_post_run(context)

    written = json.loads((tmp_path / "trajectory.json").read_text())
    assert written["schema_version"].startswith("ATIF")
    assert written["agent"]["name"] == "woopcode"


def test_populate_context_records_run_metadata(tmp_path: Path) -> None:
    write_events(tmp_path, SIMPLE_RUN)
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["woopcode_completed"] is True
    assert context.metadata["woopcode_tool_calls"] == 1


def test_incomplete_run_is_marked_not_completed(tmp_path: Path) -> None:
    write_events(tmp_path, SIMPLE_RUN[:-1])  # no run_end
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["woopcode_completed"] is False


def test_token_metrics_are_left_unset(tmp_path: Path) -> None:
    """Reporting a fabricated zero would corrupt Harbor's cost aggregates."""
    write_events(tmp_path, SIMPLE_RUN)
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)

    assert context.n_input_tokens is None
    assert context.cost_usd is None


def test_populate_context_without_events_is_a_no_op(tmp_path: Path) -> None:
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)

    assert context.metadata is None
    assert not (tmp_path / "trajectory.json").exists()


# --------------------------------------------------------------------------
# Capability flags
# --------------------------------------------------------------------------


def test_resume_is_declared_unsupported(tmp_path: Path) -> None:
    """The CLI has no session-continuation flag; claiming otherwise would make
    Harbor silently drop context between steps."""
    assert WoopCode.SUPPORTS_RESUME is False

    with pytest.raises(NotImplementedError):
        import asyncio

        asyncio.run(
            make_agent(tmp_path).resume("x", None, AgentContext())  # type: ignore[arg-type]
        )
