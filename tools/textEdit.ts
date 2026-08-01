/**
 * The semantics of a text replacement, with no filesystem and no UI.
 *
 * Kept apart from `editFile.ts` because "which occurrence did the caller mean"
 * is a question about text, not about files. It is also the question the tool
 * used to get wrong: `String.prototype.replace` silently takes the first match,
 * so a model that meant the second one got no signal at all.
 *
 * Two rules:
 *
 *  - **A match must be unique, or the caller must say otherwise.** Zero matches
 *    and many matches are both errors. `replaceAll` is how a caller states that
 *    it meant all of them, so the tool never has to guess.
 *  - **Replacement is literal.** No regex is compiled and no substitution
 *    pattern is expanded, so `oldText` may contain `(`, `[`, `.` or `\` and
 *    `newText` may contain `$&` or `` $` `` without either being interpreted.
 */

/** Where one match sits, and enough of its surroundings to tell it apart. */
export interface Occurrence {
  /** Offset into the content, for slicing. */
  readonly index: number;
  /** 1-based line of the first character. */
  readonly line: number;
  /** 1-based column of the first character. */
  readonly column: number;
  /** 1-based line of the last character; differs for a multiline match. */
  readonly endLine: number;
  /** The match with surrounding lines, gutter-numbered and marked. */
  readonly preview: string;
}

/**
 * Optional and always `true` when present. There is no `replaceAll: false`:
 * the question is whether the caller deliberately asked for every occurrence,
 * and an explicit `false` is the same statement as saying nothing. Written this
 * way, a later `ignoreWhitespace?: true` reads the same and needs no defaults.
 */
export interface ApplyEditOptions {
  /** Replace every non-overlapping occurrence instead of requiring one. */
  readonly replaceAll?: true;
  /** Lines of context on each side of a match in its preview. Default 4. */
  readonly contextLines?: number;
}

export type EditOutcome =
  | { kind: "applied"; content: string; replacements: number }
  /** `oldText` was empty, which matches at every position and names nothing. */
  | { kind: "empty-pattern" }
  | { kind: "not-found" }
  | { kind: "ambiguous"; occurrences: Occurrence[] };

const DEFAULT_CONTEXT_LINES = 4;

/** Previews beyond this are cut: the point is to identify a match, not to page a file. */
const MAX_PREVIEWS = 5;

/**
 * Every non-overlapping match, in order.
 *
 * Non-overlapping is the honest description of the scan and of the replacement
 * that follows it: in `aaa`, the pattern `aa` occurs once, because consuming
 * the first match leaves only `a` behind.
 */
export function findOccurrences(
  content: string,
  oldText: string,
  contextLines: number = DEFAULT_CONTEXT_LINES,
): Occurrence[] {
  if (oldText === "") return [];

  const lines = content.split("\n");
  const lineStarts = startOfEachLine(lines);
  const occurrences: Occurrence[] = [];

  let index = content.indexOf(oldText);
  while (index !== -1) {
    const line = lineAt(lineStarts, index);
    const endLine = lineAt(lineStarts, index + Math.max(oldText.length - 1, 0));

    occurrences.push({
      index,
      line: line + 1,
      column: index - lineStarts[line]! + 1,
      endLine: endLine + 1,
      preview: buildPreview(lines, line, endLine, contextLines),
    });

    // Step past the whole match: an overlapping one could never be replaced.
    index = content.indexOf(oldText, index + oldText.length);
  }

  return occurrences;
}

/**
 * The decision and, when it is allowed, the new content.
 *
 * Ambiguity is checked before anything else about the replacement, including
 * whether it would change the file at all. A rule with an exception for the
 * no-op case would be a rule the caller has to reason about.
 */
export function applyEdit(
  content: string,
  oldText: string,
  newText: string,
  options: ApplyEditOptions = {},
): EditOutcome {
  if (oldText === "") return { kind: "empty-pattern" };

  const occurrences = findOccurrences(content, oldText, options.contextLines);
  if (occurrences.length === 0) return { kind: "not-found" };
  if (occurrences.length > 1 && !options.replaceAll) {
    return { kind: "ambiguous", occurrences };
  }

  return {
    kind: "applied",
    content: spliceAll(content, occurrences, oldText.length, newText),
    replacements: occurrences.length,
  };
}

/**
 * Rebuilds the content around the matches.
 *
 * `slice` rather than `String.replace`, so `newText` is written as the bytes it
 * is. `replace` expands `$&`, `` $` ``, `$'` and `$1` in the replacement even
 * when the pattern is a plain string, which quietly corrupts any edit that
 * inserts a literal `$`.
 */
function spliceAll(
  content: string,
  occurrences: Occurrence[],
  matchLength: number,
  newText: string,
): string {
  const pieces: string[] = [];
  let cursor = 0;

  for (const occurrence of occurrences) {
    pieces.push(content.slice(cursor, occurrence.index), newText);
    cursor = occurrence.index + matchLength;
  }

  pieces.push(content.slice(cursor));
  return pieces.join("");
}

/**
 * The message a caller sees when a match is ambiguous.
 *
 * It carries the surrounding lines rather than a bare count, because the point
 * is to be answerable in one step. Told only "3 matches on lines 12, 47, 103",
 * a caller has to read the file again to find out which is which; shown the
 * context, it can extend `oldText` immediately.
 *
 * Extending `oldText` is offered first and `replaceAll` second, on purpose:
 * `replaceAll` is for a deliberate rename, not for getting unstuck.
 */
export function describeAmbiguity(occurrences: Occurrence[], path: string): string {
  const shown = occurrences.slice(0, MAX_PREVIEWS);
  const remaining = occurrences.length - shown.length;

  const locations = shown
    .map((occurrence) => `Line ${occurrence.line}, column ${occurrence.column}:\n${occurrence.preview}`)
    .join("\n\n");

  const more =
    remaining > 0
      ? `\n\n… and ${remaining} more at ${describeLines(occurrences.slice(MAX_PREVIEWS))}.`
      : "";

  return [
    `Found ${occurrences.length} matches for oldText in ${path} (lines ${describeLines(occurrences)}).`,
    "edit_file changes one occurrence and will not guess which one you meant.",
    "",
    locations + more,
    "",
    "Extend oldText with the surrounding lines until it matches exactly one location.",
    "To change every non-overlapping occurrence deliberately, pass replaceAll: true.",
  ].join("\n");
}

function describeLines(occurrences: Occurrence[]): string {
  return occurrences.map((occurrence) => occurrence.line).join(", ");
}

/** Offset of the first character of each line. */
function startOfEachLine(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;

  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1; // the "\n" that split removed
  }

  return starts;
}

/** Index of the line containing an offset, by binary search. */
function lineAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }

  return low;
}

/**
 * The match in place, with its neighbours:
 *
 * ```
 *   10 | function load() {
 * > 11 |   const result = fetchUser(id);
 *   12 |   return result;
 * ```
 *
 * Every line of a multiline match is marked, so its extent is visible too.
 */
function buildPreview(
  lines: string[],
  startLine: number,
  endLine: number,
  contextLines: number = DEFAULT_CONTEXT_LINES,
): string {
  const first = Math.max(0, startLine - contextLines);
  const last = Math.min(lines.length - 1, endLine + contextLines);
  const gutter = String(last + 1).length;

  const rendered: string[] = [];
  for (let line = first; line <= last; line++) {
    const matched = line >= startLine && line <= endLine;
    const number = String(line + 1).padStart(gutter, " ");
    // Carriage returns would break the alignment of a CRLF file's preview.
    const text = lines[line]!.replace(/\r$/, "");
    rendered.push(`${matched ? ">" : " "} ${number} | ${text}`);
  }

  return rendered.join("\n");
}
