import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { App } from "../app";
import { store } from "../store/ui-store";
import type { HomeScreenData } from "../components/HomeScreen";

/**
 * These render the real App and push a literal Ctrl+C byte through stdin, which
 * is the only way to prove the key is reachable: the regression was not a wrong
 * decision, it was a handler that had unmounted. A unit test of the decision
 * function cannot see that.
 */

const CTRL_C = "";

class NullStdout extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  override _write(_chunk: unknown, _encoding: unknown, done: () => void) {
    done();
  }
}

/**
 * Ink 7 pulls input with `readable` + `read()` rather than listening for
 * `data`, so the fake has to queue chunks and announce them the same way.
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  read() {
    return this.queue.shift() ?? null;
  }
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

function mountApp({ busy }: { busy: boolean }) {
  const calls = { cancel: 0, exit: 0 };
  const controller = {
    isBusy: () => busy,
    cancel: () => {
      calls.cancel++;
    },
    setModel: () => true,
    getModel: () => "gemini-2.5-flash-lite",
    run: async () => {},
  } as never;

  const stdin = new FakeStdin();
  const instance = render(
    <App
      controller={controller}
      onExit={async () => {
        calls.exit++;
      }}
      homeScreen={homeScreen}
    />,
    {
      stdin: stdin as never,
      stdout: new NullStdout() as never,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  return { calls, stdin, unmount: () => instance.unmount() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("Ctrl+C reaches the app while a modal is open", () => {
  beforeEach(() => {
    store.clearTimeline();
    store.closeModelPicker();
    // A transcript keeps the app off the home screen, matching a live turn.
    store.addUserMessage("explain this repository");
  });

  test("cancels a turn parked on an edit approval", async () => {
    const app = mountApp({ busy: true });
    const approval = store.setPendingEdit({
      id: "edit-1",
      filePath: "cli.ts",
      oldContent: "a",
      newContent: "b",
      diff: "",
      toolCallId: "tool-1",
    });
    await settle();

    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.cancel).toBe(1);
    expect(app.calls.exit).toBe(0);

    // The real controller.cancel() also clears pending approvals; this stub only
    // counts the call, so settle the promise rather than leaking it to the next test.
    store.rejectPendingEdit();
    await expect(approval).resolves.toBe(false);
    app.unmount();
  });

  test("cancels a turn parked on a command approval", async () => {
    const app = mountApp({ busy: true });
    const approval = store.setPendingCommand({
      id: "cmd-1",
      command: "bun test",
      toolName: "run_tests",
    });
    await settle();

    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.cancel).toBe(1);

    store.rejectPendingCommand();
    await expect(approval).resolves.toBe(false);
    app.unmount();
  });

  test("cancels a turn parked on a question", async () => {
    const app = mountApp({ busy: true });
    const answer = store.setPendingQuestion({ id: "q-1", questions: ["Which database?"] });
    await settle();

    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.cancel).toBe(1);

    store.cancelPendingQuestion();
    await expect(answer).resolves.toBeNull();
    app.unmount();
  });

  test("cancels a turn while the model picker is open", async () => {
    const app = mountApp({ busy: true });
    store.openModelPicker();
    await settle();

    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.cancel).toBe(1);
    app.unmount();
  });

  test("still cancels from the composer, where it always worked", async () => {
    const app = mountApp({ busy: true });
    await settle();

    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.cancel).toBe(1);
    app.unmount();
  });

  test("handles one press once, not once per mounted handler", async () => {
    const app = mountApp({ busy: true });
    await settle();

    app.stdin.press(CTRL_C);
    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.cancel).toBe(2);
    app.unmount();
  });

  test("closes an idle modal and exits on the next press", async () => {
    const app = mountApp({ busy: false });
    store.openModelPicker();
    await settle();

    app.stdin.press(CTRL_C);
    await settle();
    expect(store.getState().modelPickerOpen).toBe(false);
    expect(app.calls.exit).toBe(0);

    app.stdin.press(CTRL_C);
    await settle();
    expect(app.calls.exit).toBe(1);
    app.unmount();
  });

  test("exits only once however many times it is pressed", async () => {
    const app = mountApp({ busy: false });
    await settle();

    app.stdin.press(CTRL_C);
    app.stdin.press(CTRL_C);
    app.stdin.press(CTRL_C);
    await settle();

    expect(app.calls.exit).toBe(1);
    app.unmount();
  });
});

describe("modal shortcuts ignore chords", () => {
  beforeEach(() => {
    store.clearTimeline();
    store.closeModelPicker();
    store.addUserMessage("run the tests");
  });

  test("Ctrl+A does not approve a pending command", async () => {
    const app = mountApp({ busy: true });
    const approval = store.setPendingCommand({
      id: "cmd-1",
      command: "bun test",
      toolName: "run_tests",
    });
    await settle();

    // Ink reports Ctrl+A as input "a" with the ctrl flag set.
    app.stdin.press("");
    await settle();

    expect(store.getState().pendingCommand).not.toBeNull();

    store.rejectPendingCommand();
    await expect(approval).resolves.toBe(false);
    app.unmount();
  });

  test("an unmodified 'a' still approves it", async () => {
    const app = mountApp({ busy: true });
    const approval = store.setPendingCommand({
      id: "cmd-2",
      command: "bun test",
      toolName: "run_tests",
    });
    await settle();

    app.stdin.press("a");
    await settle();

    await expect(approval).resolves.toBe(true);
    expect(store.getState().pendingCommand).toBeNull();
    app.unmount();
  });
});
