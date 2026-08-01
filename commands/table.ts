/**
 * The CLI's table.
 *
 * `console.table` was doing this job, and it reads as debug output: it prints an
 * index column nobody asked for, quotes strings, and boxes everything in heavy
 * rules. This renders the shape the terminal tools users already know — a header,
 * a rule, aligned columns — so `models`, `providers list` and whatever comes
 * after them look like one product rather than three utilities.
 *
 * Columns describe themselves. A caller supplies a header and a way to read one
 * cell out of a row; widths, padding and alignment follow from the data.
 */

export interface Column<Row> {
  readonly header: string;
  readonly value: (row: Row) => string;
  /** Right-aligned suits counts and sizes. Default left. */
  readonly align?: "left" | "right";
}

/** Space between columns. Two reads as a column break without a divider. */
const GAP = "  ";

export function renderTable<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string {
  if (columns.length === 0) return "";

  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => row[index]!.length), 0),
  );

  const header = joinCells(
    columns.map((column) => column.header),
    columns,
    widths,
  );

  // Spans the header only: a rule as wide as the widest cell would draw
  // attention to the whitespace instead of the columns.
  const rule = "─".repeat(header.length);

  return [header, rule, ...cells.map((row) => joinCells(row, columns, widths))].join("\n");
}

function joinCells<Row>(
  values: readonly string[],
  columns: readonly Column<Row>[],
  widths: readonly number[],
): string {
  return values
    .map((value, index) => {
      const width = widths[index]!;
      if (columns[index]!.align === "right") return value.padStart(width, " ");
      // A left-aligned last column is left unpadded: trailing spaces are
      // invisible until someone copies a row out of the terminal.
      return index === values.length - 1 ? value : value.padEnd(width, " ");
    })
    .join(GAP);
}
