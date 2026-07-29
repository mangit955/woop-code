import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { VERSION } from "../../../config/version";

const repoRoot = join(import.meta.dir, "../../..");
const packageVersion = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).version as string;

function sourceOf(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("version reporting", () => {
  test("VERSION matches package.json", () => {
    expect(VERSION).toBe(packageVersion);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("no surface restates a version literal", () => {
    // A hard-coded version is how `--version` drifted to 0.1.0 while the
    // package was on 0.5.0; every reporter must derive it instead.
    const surfaces = [
      "cli.ts",
      "commands/slash/commands.ts",
      "tui/src/components/HomeFooter.tsx",
    ];

    for (const surface of surfaces) {
      expect(sourceOf(surface)).not.toMatch(/["'`]\d+\.\d+\.\d+["'`]/);
    }
  });

  test("every reporter uses the shared constant", () => {
    expect(sourceOf("cli.ts")).toContain(".version(VERSION)");
    expect(sourceOf("commands/slash/commands.ts")).toContain("Woopcode v${VERSION}");
    expect(sourceOf("commands/slash/commands.ts")).toContain("Version: ${VERSION}");
    expect(sourceOf("tui/src/components/HomeFooter.tsx")).toContain("{VERSION}");
  });

  test("the home screen does not read the user's package.json", () => {
    const footer = sourceOf("tui/src/components/HomeFooter.tsx");

    expect(footer).not.toContain("process.cwd(), \"package.json\"");
    expect(footer).not.toContain("readFileSync");
  });
});
