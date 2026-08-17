import { describe, expect, test, beforeEach } from "bun:test";
import chalk from "chalk";
import { render } from "ink";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { App } from "./app";
import { store } from "./store/ui-store";
import type { HomeScreenData } from "./components/HomeScreen";
import type { SessionMode } from "../../runtime/planMode";
import { colors } from "./styles/theme";

/** Theme tokens are written in mixed case; extracted codes are not. */
const hex = (value: string) => value.toLowerCase();

/**
 * Tab, as a real keystroke through a real ink render.
 *
 * Worth doing at this level rather than by calling the store: the claim being
 * tested is that the key reaches the composer at all. `ink-text-input` returns
 * early on Tab and the composer stops listening while a dialog is open, and both
 * of those are somebody else's code that could change under us.
 */

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
  text() {
    return this.frames.join("").replace(new RegExp("\\u001B\\[[0-9;?]*[A-Za-z]", "g"), "");
  }
  /** Foreground colours actually emitted in the latest frame, as hex. */
  lastForegrounds() {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const frame = this.frames[index]!;
      if (frame.replace(new RegExp("\\u001B\\[[0-9;?]*[A-Za-z]", "g"), "").trim() === "") {
        continue;
      }
      const matches = frame.match(/\[38;2;\d+;\d+;\d+m/g) ?? [];
      return new Set(
        matches.map((code) => {
          const channels = code.match(/\d+/g)!.slice(2).map(Number);
          return `#${channels
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")}`;
        }),
      );
    }
    return new Set<string>();
  }
  /**
   * The most recent frame with content in it, which is what the terminal is
   * showing. Ink's last write is often only cursor and clear codes, so it
   * strips to an empty string — asserting on that reads as "nothing rendered"
   * when in fact the previous frame is on screen.
   */
  lastFrame() {
    const strip = (frame: string) =>
      frame.replace(new RegExp("\\u001B\\[[0-9;?]*[A-Za-z]", "g"), "");

    for (let index = this.frames.length - 1; index >= 0; index--) {
      const stripped = strip(this.frames[index]!);
      if (stripped.trim() !== "") return stripped;
    }
    return "";
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

const TAB = "\t";

const homeScreen: HomeScreenData = {
  logoWord: "WOOPCODE",
  subtitle: "AI software engineering agent",
  promptExamples: ["Explain this repository"],
  capabilities: ["Build", "Plan"],
  branch: "main",
  providerName: "Gemini",
};

/** Only the surface the composer touches, with the mode it actually holds. */
function fakeController() {
  let mode: SessionMode = "build";

  return {
    isBusy: () => false,
    cancel: () => {},
    setModel: () => true,
    getModel: () => "gemini-2.5-flash-lite",
    run: async () => {},
    getSessionMode: () => mode,
    isPlanMode: () => mode === "plan",
    setSessionMode: (next: SessionMode) => {
      mode = next;
    },
    toggleSessionMode: () => {
      mode = mode === "plan" ? "build" : "plan";
      return mode;
    },
  };
}

function mount(controller: ReturnType<typeof fakeController>) {
  const stdout = new Capture();
  const stdin = new FakeStdin();
  const instance = render(
    <App controller={controller as never} onExit={async () => {}} homeScreen={homeScreen} />,
    {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
      // Ink writes only its final frame when it detects CI, which would leave
      // every assertion here reading an empty string on a runner.
      interactive: true,
    },
  );

  return { stdout, stdin, unmount: () => instance.unmount() };
}

/**
 * Wait for what the test is about to be true, rather than for a fixed duration.
 *
 * A 120ms sleep stood here and was enough on an idle machine and not enough on a
 * busy one: a real ink render of the composer took most of that budget, so a
 * machine also running a full `bun test` (this suite is what `prepublishOnly`
 * runs, during a publish) read a half-drawn frame and went red on the first
 * assertion — at ~130ms, the sleep plus overhead. The same trap is documented on
 * `waitForFrame` in app.overlay.test.tsx, which is where this pattern comes from.
 */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${description} did not happen within 5s`);
}

const waitForFrame = (app: { stdout: Capture }, needle: string) =>
  waitFor(() => app.stdout.lastFrame().includes(needle), `${JSON.stringify(needle)} in the frame`);

/** The composer is mounted and drawing once its own hint is on screen. */
const waitForReady = (app: { stdout: Capture }) => waitForFrame(app, "tab ");

/** Only for asserting something did *not* happen, where there is no frame to wait for. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

describe("Tab cycles Build and Plan", () => {
  beforeEach(() => {
    store.clearTimeline();
    store.closeModelPicker();
    store.closeApprovalPicker();
    store.setSessionMode("build");
    // The composer only renders its label row outside the home screen.
    store.addUserMessage("explain the readme");
  });

  test("a Tab press switches the controller and the store together", async () => {
    const controller = fakeController();
    const app = mount(controller);
    await waitForReady(app);

    app.stdin.press(TAB);
    await waitFor(() => controller.getSessionMode() === "plan", "the controller reaching plan");

    expect(controller.getSessionMode()).toBe("plan");
    expect(store.getState().sessionMode).toBe("plan");

    app.stdin.press(TAB);
    await waitFor(() => controller.getSessionMode() === "build", "the controller reaching build");

    expect(controller.getSessionMode()).toBe("build");
    expect(store.getState().sessionMode).toBe("build");

    app.unmount();
  });

  test("the mode is on screen, and the hint points the other way", async () => {
    const controller = fakeController();
    const app = mount(controller);
    await waitForFrame(app, "tab plan");

    expect(app.stdout.lastFrame()).toContain("tab plan");

    app.stdin.press(TAB);
    await waitForFrame(app, "tab build");

    const frame = app.stdout.lastFrame();
    expect(frame).toContain("Plan");
    expect(frame).toContain("tab build");

    app.unmount();
  });

  test("Tab does not type into the composer", async () => {
    const controller = fakeController();
    const app = mount(controller);
    await waitForReady(app);

    app.stdin.press(TAB);
    await waitFor(() => store.getState().sessionMode === "plan", "the store reaching plan");

    // ink-text-input ignores Tab; if that ever changes, a stray tab character
    // would land in the prompt and be submitted with whatever follows.
    expect(store.getState().sessionMode).toBe("plan");
    expect(app.stdout.lastFrame()).not.toContain("\t");

    app.unmount();
  });

  test("the mode's colour is on screen, and only in that mode", async () => {
    const controller = fakeController();
    const app = mount(controller);
    await waitForFrame(app, "tab plan");

    // The bar, the label and the caret all read one helper, so the mode's colour
    // being absent means none of them followed the mode.
    expect(app.stdout.lastForegrounds()).not.toContain(hex(colors.agentPlan));
    expect(app.stdout.lastForegrounds()).toContain(hex(colors.primary));

    app.stdin.press(TAB);
    await waitForFrame(app, "tab build");

    expect(app.stdout.lastForegrounds()).toContain(hex(colors.agentPlan));

    app.stdin.press(TAB);
    await waitForFrame(app, "tab plan");

    expect(app.stdout.lastForegrounds()).not.toContain(hex(colors.agentPlan));

    app.unmount();
  });

  test("a dialog owns Tab while it is open", async () => {
    const controller = fakeController();
    const app = mount(controller);
    // Waited for before the dialog opens, so a composer that never mounted
    // cannot pass this by leaving the mode untouched for the wrong reason.
    await waitForReady(app);

    store.openModelPicker();
    await settle();

    app.stdin.press(TAB);
    await settle();

    // The composer stops taking keystrokes under a dialog, so the mode must not
    // change behind it.
    expect(controller.getSessionMode()).toBe("build");
    expect(store.getState().sessionMode).toBe("build");

    store.closeModelPicker();
    app.unmount();
  });
});
