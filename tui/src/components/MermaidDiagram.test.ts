import { describe, expect, test } from "bun:test";
import { formatMermaid } from "./MermaidDiagram";

describe("formatMermaid", () => {
  test("renders flowchart links as terminal arrows", () => {
    const diagram = formatMermaid("graph TD\n  User[User] -->|request| API[API]\n  API --> DB[(Database)]");

    expect(diagram.kind).toBe("flowchart");
    expect(diagram.lines).toEqual([
      "  User ── request ──▶ API",
      "  API ─────────▶ Database",
    ]);
  });

  test("renders sequence messages", () => {
    const diagram = formatMermaid("sequenceDiagram\n  Client->>Server: Fetch data");

    expect(diagram.kind).toBe("sequence");
    expect(diagram.lines).toEqual(["  Client ──▶ Server: Fetch data"]);
  });
});
