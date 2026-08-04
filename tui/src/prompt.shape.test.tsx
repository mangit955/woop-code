import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import chalk from "chalk";
import { render } from "ink";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { Prompt } from "./prompt";
import { store } from "./store/ui-store";
import { colors } from "./styles/theme";
import type { SessionMode } from "../../runtime/planMode";

/** Theme tokens are written in mixed case; extracted codes are not. */
const hex = (value: string) => value.toLowerCase();

/**
 * The composer's shape, row by row.
 *
 * The card is four rows with a one-column bar on every one of them, and nothing
 * below it. It used to carry a fifth: the outer box drew a bottom border in
 * `#000000`, invisible against the background but occupying a row, so the block
 * continued past where the bar stopped and the card read as detached from its
 * own edge. Nothing but a rendered frame can catch that — the colour is the
 * background colour, so it is invisible to a human reading the diff too.
 */

chalk.level = 3;

const ESC = new RegExp("\\u001B\\[[0-9;?]*[A-Za-z]", "g");

class Capture extends Writable {
  isTTY = true;
  columns = 56;
  rows = 20;
  frames: string[] = [];
  override _write(chunk: unknown, _encoding: unknown, done: () => void) {
    this.frames.push(String(chunk));
    done();
  }
  /** The latest frame with content, split into lines with escapes stripped. */
  lines() {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const stripped = this.frames[index]!.replace(ESC, "");
      if (stripped.trim() !== "") {
        // A trailing newline is not a row.
        return stripped.replace(/\n$/, "").split("\n");
      }
    }
    return [];
  }
  lastForegrounds() {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const frame = this.frames[index]!;
      if (frame.replace(ESC, "").trim() === "") continue;
      const matches = frame.match(/\[38;2;\d+;\d+;\d+m/g) ?? [];
      return new Set(
        matches.map((code) => {
          const channels = code.match(/\d+/g)!.slice(2).map(Number);
          return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
        }),
      );
    }
    return new Set<string>();
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode() { return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
  read() { return null; }
  ref() {}
  unref() {}
}

const controller = {
  isBusy: () => false,
  cancel: () => {},
  setModel: () => true,
  getModel: () => "gemini-3.5-flash-lite",
  run: async () => {},
  getSessionMode: () => "build" as SessionMode,
  isPlanMode: () => false,
  setSessionMode: () => {},
  toggleSessionMode: () => "plan" as SessionMode,
} as never;

function renderComposer() {
  const stdout = new Capture();
  const instance = render(
    <Prompt
      controller={controller}
      onExit={async () => {}}
      value=""
      placeholder="Find duplicate code"
      onValueChange={() => {}}
      modelName="Gemini 3.5 Flash Lite"
      variant="block"
      showProvider
      inputActive
    />,
    {
      stdout: stdout as never,
      stdin: new FakeStdin() as never,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: true,
    },
  );

  return { stdout, unmount: () => instance.unmount() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("the composer card", () => {
  beforeEach(() => {
    store.setSessionMode("build");
  });

  test("is four rows, and nothing follows it", async () => {
    const composer = renderComposer();
    await settle();

    const lines = composer.stdout.lines();

    expect(lines).toHaveLength(4);
    // The last row is the mode label; the bar stops level with it.
    expect(lines.at(-1)).toContain("Build ·");

    composer.unmount();
  });

  test("carries a one-column bar on every row", async () => {
    const composer = renderComposer();
    await settle();

    for (const line of composer.stdout.lines()) {
      expect(line.startsWith("│")).toBe(true);
      // One column, not two: the bar's width is part of the design and a solid
      // block would read as a different component.
      expect(line[1]).not.toBe("│");
    }

    composer.unmount();
  });

  test("draws the bar in the mode's colour", async () => {
    const composer = renderComposer();
    await settle();
    expect(composer.stdout.lastForegrounds()).toContain(hex(colors.primary));
    composer.unmount();

    store.setSessionMode("plan");
    const planning = renderComposer();
    await settle();

    const emitted = planning.stdout.lastForegrounds();
    expect(emitted).toContain(hex(colors.agentPlan));
    // Bar and label share one colour, so the periwinkle is gone entirely rather
    // than the two disagreeing the way they did when only the label followed.
    expect(emitted).not.toContain(hex(colors.primary));
    expect(planning.stdout.lines().at(-1)).toContain("Plan ·");

    planning.unmount();
  });
});
