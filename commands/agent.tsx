import { Command } from "commander";
import { getConfig } from "../config/config";
import type { AgentCallbacks, TurnSummary } from "../config/types";
import { App, store } from "../tui/src";
import { render } from "ink";
import { AgentController } from "./agentController";
import { ACTIVE_PROVIDER_MODELS, DEFAULT_MODEL_ID, getModelDisplayName } from "../config/client";
import type { HomeScreenData } from "../tui/src/components/HomeScreen";
import { ensureProviderConfigured } from "../onboarding";
import { registerCommands } from "./slash";
import { isCommandTool, summarizeToolOutput } from "../tui/src/tool-display";
import { parseApprovalMode } from "../runtime/approval";
import { createEventLog, now } from "../runtime/eventLog";
import { IterationBudgetExhaustedError } from "../config/runtime";
import { VERSION } from "../config/version";
import { PassThrough } from "stream";

/** How long a terminal notice stays on the status bar before reverting to Ready. */
const ERROR_STATUS_MS = 3000;
const CANCEL_STATUS_MS = 1000;

export interface RunAgentOptions {
  /** Non-empty value switches the agent to a single headless turn. */
  prompt?: string;
  /** Headless only: approve tool edits/commands automatically (default true). */
  autoApprove?: boolean;
  /** Overrides the stored model for this run only. */
  model?: string;
  /** Headless only: path to write a JSONL record of the run to. */
  events?: string;
}

export const agentCommand = new Command("agent")
  .description("Runs the agent")
  .option("-p, --prompt <prompt>", "run a single prompt headlessly and exit", "")
  .option("--no-auto-approve", "with --prompt, reject tool edits and commands instead of approving them")
  .option("-m, --model <model>", "model id to use for this run")
  .option("--events <path>", "with --prompt, write a JSONL record of the run to this path")
  .action(runAgent);

/**
 * Entry point for both `woopcode` and `woopcode agent`. With `--prompt` the
 * agent runs one non-interactive turn and exits; otherwise it launches the TUI.
 */
export async function runAgent(options: RunAgentOptions = {}, command?: Command) {
  // `woopcode -p` records the value on the root program and `woopcode agent -p`
  // on the subcommand, so consult both.
  const globals = command?.optsWithGlobals?.() as RunAgentOptions | undefined;
  const prompt = (options.prompt || globals?.prompt || "").trim();
  const autoApprove =
    options.autoApprove !== false && globals?.autoApprove !== false;
  const model = options.model || globals?.model;
  const events = options.events || globals?.events;

  if (prompt) {
    return runHeadless(prompt, autoApprove, { model, events });
  }

  return runInteractive(model);
}

/**
 * Resolves the model for a run: an explicit flag wins, then the stored
 * selection, then the built-in default. The flag is deliberately not written
 * back to the config — a one-off override, including one from a benchmark
 * harness, must not mutate the user's saved preference.
 */
async function resolveModel(override: string | undefined): Promise<string> {
  if (override?.trim()) return override.trim();
  const config = await getConfig();
  return config.selectedModel ?? DEFAULT_MODEL_ID;
}

/** Runs a single turn without the TUI, streaming the answer to stdout. */
async function runHeadless(
  prompt: string,
  autoApprove: boolean,
  options: { model?: string; events?: string } = {},
) {
  registerCommands();
  const { provider, apiKey } = await ensureProviderConfigured();

  const selectedModel = await resolveModel(options.model);
  store.setSelectedModel(selectedModel);
  store.setNonInteractive({ autoApprove });

  const log = createEventLog(options.events);
  log.write({
    type: "run_start",
    ts: now(),
    model: selectedModel,
    version: VERSION,
    prompt,
  });

  let failed = false;
  let budgetExhausted = false;
  let summary: TurnSummary | undefined;

  const callbacks: AgentCallbacks = {
    onStatus(status) {
      log.write({ type: "status", ts: now(), text: status });
      // Efficiency notices are the only statuses worth surfacing headlessly.
      if (status.startsWith("⚠️")) process.stderr.write(`${status}\n`);
    },
    onUsage(iteration) {
      log.write({
        type: "iteration",
        ts: now(),
        n: iteration.iteration,
        usage: iteration.usage,
        segments: iteration.segments,
        toolCalls: iteration.toolCalls,
        durationMs: iteration.durationMs,
      });
    },
    onRetry(retry) {
      log.write({
        type: "retry",
        ts: now(),
        attempt: retry.attempt,
        delayMs: retry.delayMs,
        reason: retry.reason,
        error: retry.error,
      });
    },
    onTurnSummary(turn) {
      // Held rather than written here: it belongs on run_end, which is written
      // after the controller has finished and the exit status is known.
      summary = turn;
    },
    onToolStart(tool) {
      log.write({
        type: "tool_call",
        ts: now(),
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      });
      process.stderr.write(`• ${tool.name}\n`);
    },
    onToolFinish(tool) {
      log.write({
        type: "tool_result",
        ts: now(),
        id: tool.id,
        name: tool.name,
        output: tool.output,
      });
    },
    onToolError(tool) {
      log.write({
        type: "tool_error",
        ts: now(),
        id: tool.id,
        name: tool.name,
        error: tool.error,
      });
      process.stderr.write(`✖ ${tool.name} failed: ${tool.error}\n`);
    },
    onToolBlocked(tool) {
      log.write({
        type: "tool_blocked",
        ts: now(),
        id: tool.id,
        name: tool.name,
        reason: tool.error,
      });
      process.stderr.write(`⊘ ${tool.name} refused: ${tool.error}\n`);
    },
    onText(text) {
      log.write({ type: "text", ts: now(), text });
      process.stdout.write(text);
    },
    onError(error) {
      failed = true;
      if (error instanceof IterationBudgetExhaustedError) budgetExhausted = true;
      log.write({ type: "error", ts: now(), message: error.message });
      process.stderr.write(`✖ ${error.message}\n`);
    },
  };

  const controller = new AgentController(provider, apiKey, selectedModel, callbacks);
  await controller.initialize();

  const onSigint = () => {
    controller.cancel();
  };
  process.once("SIGINT", onSigint);

  try {
    await controller.run(prompt);
  } catch (error) {
    failed = true;
    if (error instanceof IterationBudgetExhaustedError) budgetExhausted = true;
    const message = error instanceof Error ? error.message : String(error);
    log.write({ type: "error", ts: now(), message });
    process.stderr.write(`✖ ${message}\n`);
  } finally {
    process.off("SIGINT", onSigint);
    await controller.dispose();
  }

  log.write({ type: "run_end", ts: now(), ok: !failed, summary });
  process.stdout.write("\n");
  // Exit codes are a contract with automated callers:
  //   0 - the turn completed
  //   2 - the loop ran out of iterations; work may be partially done, and the
  //       caller should judge the result rather than treat this as a crash
  //   1 - anything else went wrong
  process.exit(failed ? (budgetExhausted ? EXIT_BUDGET_EXHAUSTED : 1) : 0);
}

/** See the exit-code contract in `runHeadless`. */
export const EXIT_BUDGET_EXHAUSTED = 2;

/** Runs the interactive TUI agent. */
async function runInteractive(modelOverride?: string) {
  // Register slash commands
  registerCommands();

  // Ensure provider is configured (launches onboarding if needed)
  const { provider, apiKey } = await ensureProviderConfigured();

  const config = await getConfig();
  const selectedModel = await resolveModel(modelOverride);
  store.setSelectedModel(selectedModel);
  store.setApprovalMode(parseApprovalMode(config.approvalMode));

  const callbacks: AgentCallbacks = {
    onStatus(status) {
      // Runtime notices (such as iteration-budget warnings) are informational,
      // not terminal states. Keep the activity indicator truthful while a turn
      // is still in progress, and show the notice itself in the transcript so
      // it is not swallowed.
      if (status.startsWith("⚠️")) {
        store.addSystemMessage(status);
        store.setStatus("Thinking...");
        return;
      }

      store.setStatus(status);
    },

    onToolStart(tool) {
      store.finishAssistantMessage();
      store.startTool(tool);
      store.setStatus("Working...");
    },

    onToolFinish(tool) {
      store.finishTool(tool.id, {
        summary: summarizeToolOutput(tool.name, tool.output),
        // Command tools render as a shell block, so their output is kept.
        output: isCommandTool(tool.name) ? tool.output : undefined,
      });
      // A tool result is sent back to the model for the next step. The turn is
      // still active until onDone, so never show Ready here.
      store.setStatus("Thinking...");
    },

    onToolError(tool) {
      store.failTool(tool.id, isCommandTool(tool.name) ? tool.error : undefined);
      store.addSystemMessage(`${tool.name} failed: ${tool.error}`);
      store.setStatus("Thinking...");
    },

    // No system message: the row already says it, and a refusal is the mode
    // working rather than news. The agent is still mid-turn, writing its plan.
    onToolBlocked(tool) {
      store.blockTool(tool.id, tool.error);
      store.setStatus("Thinking...");
    },

    onText(text) {
      store.appendAssistantText(text);
    },

    onDone() {
      //console.log("onDone received");
      store.finishAssistantMessage();
      store.setStatus("Ready");
    },

    onError(error) {
      store.finishAssistantMessage();
      // Long enough to read, and superseded the moment anything else happens —
      // including the next turn starting.
      store.setTransientStatus(`Error: ${error.message}`, ERROR_STATUS_MS);
    },

    onCancel() {
      store.finishAssistantMessage();
      store.setTransientStatus("Cancelled", CANCEL_STATUS_MS);
    },
  };
  const controller = new AgentController(provider, apiKey, selectedModel, callbacks);
  await controller.initialize();
  const homeScreen = await buildHomeScreen(provider, selectedModel);

  const customStdin = new PassThrough() as any;
  customStdin.ref = () => {
    process.stdin.ref?.();
  };
  customStdin.unref = () => {
    process.stdin.unref?.();
  };
  customStdin.setRawMode = (mode: boolean) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(mode);
    }
  };
  customStdin.isTTY = process.stdin.isTTY;

  const MOUSE_REGEX = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let pendingScrollLines = 0;
  let scrollFrame: ReturnType<typeof setTimeout> | undefined;

  const queueScroll = (lines: number) => {
    pendingScrollLines += lines;
    if (scrollFrame) return;

    // Trackpads can emit several wheel reports in a single display frame.
    // Coalescing them prevents Ink from repainting the full transcript for
    // every individual report.
    scrollFrame = setTimeout(() => {
      if (store.getState().pendingEdit) {
        // The diff is a normal top-to-bottom viewport, unlike the
        // bottom-anchored conversation timeline.
        store.scrollPendingEditBy(-pendingScrollLines);
      } else {
        store.scrollBy(pendingScrollLines);
      }
      pendingScrollLines = 0;
      scrollFrame = undefined;
    }, 16);
  };

  const onData = (data: Buffer) => {
    const str = data.toString();
    let hasMouse = false;
    let match;
    while ((match = MOUSE_REGEX.exec(str)) !== null) {
      hasMouse = true;
      const button = Number(match[1]);
      const isPress = match[4] === "M";
      if (isPress) {
        if (button === 64) {
          queueScroll(1);
        } else if (button === 65) {
          queueScroll(-1);
        }
      }
    }

    if (hasMouse) {
      const remainingStr = str.replace(MOUSE_REGEX, "");
      if (remainingStr.length > 0) {
        customStdin.write(Buffer.from(remainingStr));
      }
    } else {
      customStdin.write(data);
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.on("data", onData);
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  }

  const { unmount } = render(
    <App controller={controller} onExit={handleExit} homeScreen={homeScreen} />,
    { stdin: customStdin, exitOnCtrlC: false }
  );

  let exiting = false;

  async function handleExit() {
    if (exiting) return;
    exiting = true;

    if (process.stdin.isTTY) {
      process.stdin.off("data", onData);
      process.stdout.write("\x1b[?1006l\x1b[?1000l");
    }
    if (scrollFrame) clearTimeout(scrollFrame);

    store.clearPendingEdit();
    store.clearPendingCommand();
    store.cancelPendingQuestion();
    controller.cancel();
    await controller.dispose();
    unmount();
    process.exit(0);
  }

  process.once("SIGINT", () => {
    void handleExit();
  });
}

async function buildHomeScreen(provider: string, model: string): Promise<HomeScreenData> {
  const repository =
    process.cwd().split("/").filter(Boolean).at(-1) ?? "workspace";
  const branch = await getBranch();
  const providerLabel = provider === "google" ? "Gemini" : titleCase(provider);

  return {
    logoWord: "WOOPCODE",
    subtitle: "AI software engineering agent",
    promptExamples: [
      "Explain this repository",
      "Review recent changes",
      "Find duplicate code",
      "Generate tests",
      "Optimize performance",
      "Add authentication",
    ],
    capabilities: [
      "Build",
      "Plan",
      "Review",
      "Explain",
      "Refactor",
      "Debug",
      "Test",
      "Document",
    ],
    repository,
    branch,
    providerName: providerLabel,
    // getModelDisplayName resolves through the whole catalog now, so every
    // provider's models name themselves; the Google-only branch this replaced
    // fell back to a hardcoded label for anything else.
    provider: getModelDisplayName(model) ?? providerLabel,
  };
}

async function getBranch(): Promise<string> {
  try {
    const branch = (await Bun.$`git branch --show-current`.text()).trim();
    return branch || "detached";
  } catch {
    return "not a git repository";
  }
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
