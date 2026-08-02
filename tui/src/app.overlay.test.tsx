import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import chalk from "chalk";
import { render } from "ink";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { App } from "./app";
import { store } from "./store/ui-store";
import { colors, dimmedColors } from "./styles/theme";
import type { HomeScreenData } from "./components/HomeScreen";

/**
 * A dialog floats over the app instead of replacing it, so these assert on the
 * rendered frame: the work behind the panel has to still be there, and it has to
 * be drawn in the faded palette while the panel keeps the lit one.
 */

// ink colours through this same chalk singleton, and a piped test stream would
// otherwise be detected as not supporting colour — leaving nothing to assert on.
chalk.level = 3;

class Capture extends Writable {
  isTTY = true;
  columns = 84;
  rows = 24;
  frames: string[] = [];
  override _write(chunk: unknown, _encoding: unknown, done: () => void) {
    this.frames.push(String(chunk));
    done();
  }
  /** Every frame concatenated, escape codes intact. */
  raw() {
    return this.frames.join("");
  }
  text() {
    return this.raw().replace(new RegExp("\\u001B\\[[0-9;?]*[A-Za-z]", "g"), "");
  }
  /** Foreground colours ink actually emitted, as hex. */
  foregrounds() {
    const matches = this.raw().match(/\[38;2;\d+;\d+;\d+m/g) ?? [];
    return new Set(
      matches.map((code) => {
        const channels = code.match(/\d+/g)!.slice(2).map(Number);
        return `#${channels
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("")}`;
      }),
    );
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() { return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() { return this.queue.shift() ?? null; }
  ref() {}
  unref() {}
  press(sequence: string) {
    this.queue.push(sequence);
    this.emit("readable");
  }
}

const homeScreen: HomeScreenData = {
  logoWord: "WOOPCODE",
  subtitle: "AI software engineering agent",
  promptExamples: ["Explain this repository"],
  capabilities: ["Build"],
  repository: "woop-code",
  branch: "main",
  providerName: "Gemini",
  provider: "Gemini 2.5 Flash Lite",
};

const controller = {
  isBusy: () => false,
  cancel: () => {},
  setModel: () => true,
  getModel: () => "gemini-2.5-flash-lite",
  run: async () => {},
} as never;

function mount() {
  const stdout = new Capture();
  const stdin = new FakeStdin();
  const instance = render(
    <App controller={controller} onExit={async () => {}} homeScreen={homeScreen} />,
    {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
      // Ink writes only the final frame when it detects CI, which leaves
      // `frames` empty and every assertion below with nothing to read. These
      // tests are about what a terminal draws, so they ask for the terminal's
      // behaviour explicitly rather than depending on where they run — the same
      // reason chalk's colour level is forced above.
      interactive: true,
    },
  );
  return { stdout, stdin, unmount: () => instance.unmount() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const TRANSCRIPT = "explain the readme";

describe("dialogs float over the app", () => {
  beforeEach(() => {
    store.clearTimeline();
    store.closeModelPicker();
    store.addUserMessage(TRANSCRIPT);
  });

  test("keeps the transcript on screen behind the model picker", async () => {
    const app = mount();
    store.openModelPicker();
    await settle();

    // Before, the dialog replaced the main content and the screen went black.
    expect(app.stdout.text()).toContain(TRANSCRIPT);
    expect(app.stdout.text()).toContain("Select model");
    app.unmount();
  });

  test("keeps the transcript on screen behind a command approval", async () => {
    const app = mount();
    const approval = store.setPendingCommand({
      id: "cmd-1",
      command: "bun test",
      toolName: "run_tests",
    });
    await settle();

    expect(app.stdout.text()).toContain(TRANSCRIPT);
    expect(app.stdout.text()).toContain("Run tests");

    store.rejectPendingCommand();
    await expect(approval).resolves.toBe(false);
    app.unmount();
  });

  test("keeps the transcript on screen behind a question", async () => {
    const app = mount();
    const answer = store.setPendingQuestion({ id: "q-1", questions: ["Which database?"] });
    await settle();

    expect(app.stdout.text()).toContain(TRANSCRIPT);
    expect(app.stdout.text()).toContain("Which database?");

    store.cancelPendingQuestion();
    await expect(answer).resolves.toBeNull();
    app.unmount();
  });

  test("draws the background faded and the panel lit", async () => {
    const app = mount();
    store.openModelPicker();
    await settle();

    const emitted = app.stdout.foregrounds();
    // Both palettes on screen at once is the whole point: dimmed behind, lit in
    // front. Either one missing means the layers are not separated.
    expect(emitted).toContain(dimmedColors.textBase);
    expect(emitted).toContain(colors.textStrong);
    app.unmount();
  });

  test("uses only the lit palette when no dialog is open", async () => {
    const app = mount();
    await settle();

    const emitted = app.stdout.foregrounds();
    expect(emitted).toContain(colors.textBase);
    expect(emitted).not.toContain(dimmedColors.textBase);
    app.unmount();
  });
});
