import { describe, expect, test } from "bun:test";
import { renderTable, type Column } from "../../../commands/table";

interface Row {
  name: string;
  size: string;
}

const columns: Column<Row>[] = [
  { header: "Name", value: (row) => row.name },
  { header: "Size", value: (row) => row.size, align: "right" },
];

describe("rendering a table", () => {
  test("aligns columns to their widest cell", () => {
    const table = renderTable(
      [
        { name: "short", size: "1M" },
        { name: "much-longer-name", size: "400K" },
      ],
      columns,
    );

    expect(table.split("\n")).toEqual([
      "Name              Size",
      "──────────────────────",
      "short               1M",
      "much-longer-name  400K",
    ]);
  });

  test("a header wider than its cells still sets the width", () => {
    const table = renderTable([{ name: "a", size: "1" }], columns);

    expect(table.split("\n")).toEqual(["Name  Size", "──────────", "a        1"]);
  });

  test("leaves no trailing whitespace on a left-aligned last column", () => {
    const table = renderTable(
      [
        { name: "a", size: "x" },
        { name: "b", size: "yyyy" },
      ],
      [
        { header: "Name", value: (row) => row.name },
        { header: "Size", value: (row) => row.size },
      ],
    );

    for (const line of table.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  test("renders headers alone when there are no rows", () => {
    expect(renderTable([], columns).split("\n")).toEqual(["Name  Size", "──────────"]);
  });

  test("no columns is an empty string, not a stray rule", () => {
    expect(renderTable([{ name: "a", size: "1" }], [])).toBe("");
  });
});
