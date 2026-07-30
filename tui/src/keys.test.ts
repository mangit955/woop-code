import { describe, expect, test } from "bun:test";
import { resolveCancelKey } from "./keys";

describe("Ctrl+C intent", () => {
  test("stops the running turn, modal or not", () => {
    // The reported bug: a turn parked on an approval modal could not be
    // cancelled, because the only handler had unmounted with the composer.
    expect(resolveCancelKey({ busy: true, modal: true })).toBe("cancel-request");
    expect(resolveCancelKey({ busy: true, modal: false })).toBe("cancel-request");
  });

  test("closes an idle modal instead of quitting the session", () => {
    expect(resolveCancelKey({ busy: false, modal: true })).toBe("dismiss-modal");
  });

  test("exits when there is nothing to stop or close", () => {
    expect(resolveCancelKey({ busy: false, modal: false })).toBe("exit");
  });

  test("never exits while work is in flight", () => {
    for (const modal of [true, false]) {
      expect(resolveCancelKey({ busy: true, modal })).not.toBe("exit");
    }
  });
});
