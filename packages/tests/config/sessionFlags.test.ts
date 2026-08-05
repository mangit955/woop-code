import { describe, test, expect } from "bun:test";
import { sessionOptionsFrom } from "../../../commands/agent";

/**
 * The mapping from command-line flags to what the controller resolves.
 *
 * Pure and worth testing on its own: the two entry points differ in one default
 * and getting it backwards is invisible until someone loses a conversation.
 */
describe("sessionOptionsFrom", () => {
  test("a bare interactive launch continues where you left off", () => {
    // The documented promise, now scoped to the project you are in.
    expect(sessionOptionsFrom({}, "interactive").continueLatest).toBe(true);
  });

  test("a bare headless run starts its own session", () => {
    // -p used to inherit whatever the interactive session was doing, which a
    // scripted caller cannot see coming and could not opt out of.
    expect(sessionOptionsFrom({}, "headless").continueLatest).toBe(false);
  });

  test("--continue asks for it explicitly, headlessly too", () => {
    expect(sessionOptionsFrom({ continue: true }, "headless").continueLatest).toBe(true);
  });

  test("--new overrides the interactive default", () => {
    expect(sessionOptionsFrom({ new: true }, "interactive").continueLatest).toBe(false);
  });

  test("--resume <ref> resolves a reference instead of continuing", () => {
    const options = sessionOptionsFrom({ resume: "auth-work" }, "interactive");

    expect(options.sessionRef).toBe("auth-work");
    expect(options.continueLatest).toBe(false);
    expect(options.openPicker).toBe(false);
  });

  test("surrounding whitespace on a reference is ignored", () => {
    expect(sessionOptionsFrom({ resume: "  auth-work  " }, "interactive").sessionRef).toBe(
      "auth-work",
    );
  });

  test("a bare --resume opens the picker rather than quietly continuing", () => {
    // The option takes an optional value, and with none it used to be
    // indistinguishable from --continue — advertising a choice it never gave.
    const options = sessionOptionsFrom({ resume: true }, "interactive");

    expect(options.openPicker).toBe(true);
    expect(options.sessionRef).toBeUndefined();
  });

  test("a bare --resume is refused headlessly, where nobody can pick", () => {
    expect(() => sessionOptionsFrom({ resume: true }, "headless")).toThrow(
      "--resume needs a session id",
    );
  });

  test("--fork-session is carried through", () => {
    expect(sessionOptionsFrom({ forkSession: true }, "interactive").fork).toBe(true);
  });

  test("--no-session-persistence turns persistence off", () => {
    expect(sessionOptionsFrom({ sessionPersistence: false }, "headless").persist).toBe(false);
  });

  test("persistence is on by default", () => {
    expect(sessionOptionsFrom({}, "headless").persist).toBe(true);
  });

  test("--name is passed on, and an empty one is not", () => {
    expect(sessionOptionsFrom({ name: "auth-work" }, "interactive").name).toBe("auth-work");
    expect(sessionOptionsFrom({ name: "" }, "interactive").name).toBeUndefined();
  });
});
