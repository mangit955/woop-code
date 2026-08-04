import { describe, expect, test } from "bun:test";
import { PromptHistory } from "./history";

describe("prompt history", () => {
  test("walks back through what was submitted, newest first", () => {
    const history = new PromptHistory();
    history.push("first");
    history.push("second");

    expect(history.previous("")).toBe("second");
    expect(history.previous("")).toBe("first");
  });

  test("stops at the oldest entry rather than wrapping round", () => {
    const history = new PromptHistory();
    history.push("only");

    expect(history.previous("")).toBe("only");
    expect(history.previous("")).toBeNull();
  });

  test("gives back the half-typed line at the bottom of the walk", () => {
    const history = new PromptHistory();
    history.push("run the tests");

    expect(history.previous("what I was typ")).toBe("run the tests");
    expect(history.next()).toBe("what I was typ");
    expect(history.isWalking()).toBe(false);
  });

  test("↓ does nothing when the composer is showing the user's own text", () => {
    const history = new PromptHistory();
    history.push("something");

    expect(history.next()).toBeNull();
  });

  test("submitting ends the walk, so ↑ starts from the newest again", () => {
    const history = new PromptHistory();
    history.push("first");
    history.push("second");
    history.previous("");
    history.previous("");

    history.push("third");
    expect(history.isWalking()).toBe(false);
    expect(history.previous("")).toBe("third");
  });

  test("ignores blank submissions and immediate repeats", () => {
    const history = new PromptHistory();
    history.push("same");
    history.push("   ");
    history.push("same");

    expect(history.previous("")).toBe("same");
    expect(history.previous("")).toBeNull();
  });

  test("is empty until something is submitted, so ↑ can fall back to scrolling", () => {
    const history = new PromptHistory();
    expect(history.isEmpty()).toBe(true);
    expect(history.previous("")).toBeNull();

    history.push("now it is not");
    expect(history.isEmpty()).toBe(false);
  });
});
