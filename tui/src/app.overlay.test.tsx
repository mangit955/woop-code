import { describe, expect, test, beforeEach } from "bun:test";
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
  branch: "main",
  providerName: "Gemini",
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

/**
 * Wait for the frame to contain what the test is about, rather than for a fixed
 * duration. The 1000-item transcript took 83–117ms to draw against the old 120ms
 * sleep, so a loaded CI runner read a half-drawn frame and went red.
 */
async function waitForFrame(app: { stdout: Capture }, needle: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (app.stdout.text().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${JSON.stringify(needle)} in the frame after 10s`);
}

/** Only for asserting something did *not* happen, where there is no frame to wait for. */
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
    await waitForFrame(app, "Select model");

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
    await waitForFrame(app, "Run tests");

    expect(app.stdout.text()).toContain(TRANSCRIPT);
    expect(app.stdout.text()).toContain("Run tests");

    store.rejectPendingCommand();
    await expect(approval).resolves.toBe(false);
    app.unmount();
  });

  test("keeps the transcript on screen behind a question", async () => {
    const app = mount();
    const answer = store.setPendingQuestion({ id: "q-1", questions: ["Which database?"] });
    await waitForFrame(app, "Which database?");

    expect(app.stdout.text()).toContain(TRANSCRIPT);
    expect(app.stdout.text()).toContain("Which database?");

    store.cancelPendingQuestion();
    await expect(answer).resolves.toBeNull();
    app.unmount();
  });

  test("draws the background faded and the panel lit", async () => {
    const app = mount();
    store.openModelPicker();
    await waitForFrame(app, "Select model");

    const emitted = app.stdout.foregrounds();
    // Both palettes on screen at once is the whole point: dimmed behind, lit in
    // front. Either one missing means the layers are not separated.
    expect(emitted).toContain(dimmedColors.textBase);
    expect(emitted).toContain(colors.textStrong);
    app.unmount();
  });

  test("uses only the lit palette when no dialog is open", async () => {
    const app = mount();
    await waitForFrame(app, TRANSCRIPT);

    const emitted = app.stdout.foregrounds();
    expect(emitted).toContain(colors.textBase);
    expect(emitted).not.toContain(dimmedColors.textBase);
    app.unmount();
  });
});

/**
 * The diff answers `a` and `r` as well as Enter and Esc. Ink reports a chord's
 * letter as plain input with a modifier flag set — parse-keypress builds the
 * name from the control byte and sets `ctrl` — so an unguarded comparison
 * against `input` makes Ctrl+A apply the edit and Ctrl+R reject it. Ctrl+A is
 * start-of-line in readline, which is a very ordinary thing to press.
 *
 * These render the real App and push the literal control byte, because the bug
 * is about what reaches a mounted handler rather than about a decision.
 */
const CTRL_A = "";
const CTRL_R = "";
const ENTER = "\r";
const ESC = "";

function pendingEdit(id: string) {
  return {
    id,
    filePath: "notes.txt",
    oldContent: "before",
    newContent: "after",
    diff: "--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-before\n+after\n",
    toolCallId: `call-${id}`,
  };
}

describe("a chord never answers the diff", () => {
  beforeEach(() => {
    store.clearTimeline();
    // An empty timeline renders the home screen, where there is no DiffPreview
    // to press a key at.
    store.addUserMessage(TRANSCRIPT);
  });

  /**
   * `clearPendingEdit` rejects the waiting promise with "Edit cancelled", so a
   * test that deliberately leaves an edit unanswered has to absorb that or it
   * surfaces as an unhandled rejection in whichever test runs next.
   */
  function leaveUnanswered(id: string) {
    const decision = store.setPendingEdit(pendingEdit(id));
    decision.catch(() => {});
    return decision;
  }

  test("Ctrl+A leaves the edit pending instead of applying it", async () => {
    const app = mount();
    leaveUnanswered("ctrl-a");
    // The diff has to be on screen before the key is pressed, or there is no
    // mounted handler to ignore it and the assertion below passes for no reason.
    await waitForFrame(app, "notes.txt");

    app.stdin.press(CTRL_A);
    await settle();

    expect(store.getState().pendingEdit).not.toBeNull();
    app.unmount();
    store.clearPendingEdit();
  });

  test("Ctrl+R leaves the edit pending instead of rejecting it", async () => {
    const app = mount();
    leaveUnanswered("ctrl-r");
    await waitForFrame(app, "notes.txt");

    app.stdin.press(CTRL_R);
    await settle();

    expect(store.getState().pendingEdit).not.toBeNull();
    app.unmount();
    store.clearPendingEdit();
  });

  test("Enter still applies the edit", async () => {
    const app = mount();
    const decision = store.setPendingEdit(pendingEdit("enter"));
    await waitForFrame(app, "notes.txt");

    app.stdin.press(ENTER);

    expect(await decision).toBe(true);
    expect(store.getState().pendingEdit).toBeNull();
    app.unmount();
  });

  test("Esc still rejects the edit", async () => {
    const app = mount();
    const decision = store.setPendingEdit(pendingEdit("esc"));
    await waitForFrame(app, "notes.txt");

    app.stdin.press(ESC);

    expect(await decision).toBe(false);
    expect(store.getState().pendingEdit).toBeNull();
    app.unmount();
  });
});

/**
 * The diff used to split the screen with the transcript, both halves free to
 * shrink. Measured at 80x30 with a 200-line diff pending, a 200-item transcript
 * left the diff two rows and a 1000-item one left it none: no diff body, and no
 * footer either, while Enter still applied the edit. Approving a write with
 * nothing on screen to judge is the failure that layout allowed, and only a
 * rendered frame can catch it — every unit underneath was behaving correctly.
 */
describe("the diff owns the screen while it is being judged", () => {
  beforeEach(() => {
    store.clearTimeline();
  });

  function longEdit() {
    const body = Array.from({ length: 200 }, (_, line) => `+added line ${line}`);
    return {
      id: "long",
      filePath: "runtime/loop.ts",
      oldContent: "before",
      newContent: "after",
      diff: ["--- runtime/loop.ts", "+++ runtime/loop.ts", "@@ -1 +1 @@", ...body].join("\n"),
      toolCallId: "call-long",
    };
  }

  test("shows the change and how to answer it, whatever is behind it", async () => {
    for (const transcriptLength of [1, 200, 1000]) {
      store.clearTimeline();
      for (let index = 0; index < transcriptLength; index += 1) {
        store.addUserMessage(`message ${index}`);
      }

      const app = mount();
      const decision = store.setPendingEdit(longEdit());
      // The 1000-item case is the one that overran a fixed sleep on CI.
      await waitForFrame(app, "added line 0");

      const frame = app.stdout.text();
      expect(frame).toContain("runtime/loop.ts");
      // The body, not just the header that names the file.
      expect(frame).toContain("added line 0");
      // And the way out, which went missing at the same time the body did.
      expect(frame).toContain("reject");
      expect(frame).toContain("apply");

      store.rejectPendingEdit();
      await expect(decision).resolves.toBe(false);
      app.unmount();
    }
  });
});
