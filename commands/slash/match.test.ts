import { describe, expect, test, beforeAll } from "bun:test";
import { matchCommands } from "./match";
import { registerCommands } from "./commands";

beforeAll(() => {
  registerCommands();
});

describe("slash command matching", () => {
  test("offers nothing until a slash is typed", () => {
    expect(matchCommands("")).toEqual([]);
    expect(matchCommands("explain this repo")).toEqual([]);
  });

  test("offers everything for a bare slash", () => {
    const all = matchCommands("/");

    expect(all.length).toBeGreaterThan(1);
    expect(all.map((command) => command.name)).toContain("help");
  });

  test("filters by name prefix", () => {
    expect(matchCommands("/log").map((command) => command.name).sort()).toEqual([
      "login",
      "logout",
    ]);
  });

  test("filters by alias prefix too", () => {
    // "/m" is the alias for models, so it has to survive the filter.
    expect(matchCommands("/m").map((command) => command.name)).toContain("models");
  });

  test("is case insensitive and ignores surrounding space", () => {
    expect(matchCommands("/HELP").map((command) => command.name)).toEqual(["help"]);
    expect(matchCommands("/ help ").map((command) => command.name)).toEqual(["help"]);
  });

  test("offers nothing for an unknown command", () => {
    expect(matchCommands("/zzz")).toEqual([]);
  });
});
