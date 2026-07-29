import { Command } from "commander";
import { getConfig } from "../config/config";
import type { AgentCallbacks } from "../config/types";
import { App, store } from "../tui/src";
import { render } from "ink";
import { AgentController } from "./agentController";
import { ACTIVE_PROVIDER_MODELS, DEFAULT_MODEL_ID, getModelDisplayName } from "../config/client";
import type { HomeScreenData } from "../tui/src/components/HomeScreen";
import { ensureProviderConfigured } from "../onboarding";
import { registerCommands } from "./slash";
import { PassThrough } from "stream";

export interface RunAgentOptions {
  /** Non-empty value switches the agent to a single headless turn. */
  prompt?: string;
  /** Headless only: approve tool edits/commands automatically (default true). */
  autoApprove?: boolean;
}

export const agentCommand = new Command("agent")
  .description("Runs the agent")
  .option("-p, --prompt <prompt>", "run a single prompt headlessly and exit", "")
  .option("--no-auto-approve", "with --prompt, reject tool edits and commands instead of approving them")
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

  if (prompt) {
    return runHeadless(prompt, autoApprove);
  }

  return runInteractive();
}

/** Runs a single turn without the TUI, streaming the answer to stdout. */
async function runHeadless(prompt: string, autoApprove: boolean) {
  registerCommands();
  const { provider, apiKey } = await ensureProviderConfigured();

  const config = await getConfig();
  const selectedModel = config.selectedModel ?? DEFAULT_MODEL_ID;
  store.setSelectedModel(selectedModel);
  store.setNonInteractive({ autoApprove });

  let failed = false;

  const callbacks: AgentCallbacks = {
    onToolStart(tool) {
      process.stderr.write(`• ${tool.name}\n`);
    },
    onToolError(tool) {
      process.stderr.write(`✖ ${tool.name} failed: ${tool.error}\n`);
    },
    onText(text) {
      process.stdout.write(text);
    },
    onError(error) {
      failed = true;
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
    process.stderr.write(
      `✖ ${error instanceof Error ? error.message : String(error)}\n`
    );
  } finally {
    process.off("SIGINT", onSigint);
    await controller.dispose();
  }

  process.stdout.write("\n");
  process.exit(failed ? 1 : 0);
}

/** Runs the interactive TUI agent. */
async function runInteractive() {
  // Register slash commands
  registerCommands();

  // Ensure provider is configured (launches onboarding if needed)
  const { provider, apiKey } = await ensureProviderConfigured();

  let cancelStatusTimeout: ReturnType<typeof setTimeout> | undefined;
  const config = await getConfig();
  const selectedModel = config.selectedModel ?? DEFAULT_MODEL_ID;
  store.setSelectedModel(selectedModel);

  const callbacks: AgentCallbacks = {
    onStatus(status) {
      if (cancelStatusTimeout) {
        clearTimeout(cancelStatusTimeout);
        cancelStatusTimeout = undefined;
      }
      // Runtime notices (such as iteration-budget warnings) are informational,
      // not terminal states. Keep the activity indicator truthful while a turn
      // is still in progress.
      store.setStatus(status.startsWith("⚠️") ? "Thinking..." : status);
    },

    onToolStart(tool) {
      store.finishAssistantMessage();
      store.startTool(tool);
      store.setStatus("Working...");
    },

    onToolFinish(tool) {
      store.finishTool(tool.id);
      // A tool result is sent back to the model for the next step. The turn is
      // still active until onDone, so never show Ready here.
      store.setStatus("Thinking...");
    },

    onToolError(tool) {
      store.failTool(tool.id);
      store.addSystemMessage(`${tool.name} failed: ${tool.error}`);
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
      store.setStatus(`Error: ${error.message}`);
      
      // Clear error status after a few seconds so user can continue
      if (cancelStatusTimeout) {
        clearTimeout(cancelStatusTimeout);
      }
      cancelStatusTimeout = setTimeout(() => {
        store.setStatus("Ready");
      }, 3000); // Show error for 3 seconds then reset
    },

    onCancel() {
      store.finishAssistantMessage();
      store.setStatus("Cancelled");

      cancelStatusTimeout = setTimeout(() => {
        store.setStatus("Ready");
      }, 1000);
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
    provider: provider === "google" ? getModelDisplayName(model) ?? providerLabel : ACTIVE_PROVIDER_MODELS[provider] ?? providerLabel,
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
