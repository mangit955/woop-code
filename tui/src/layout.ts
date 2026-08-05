/**
 * One place that decides what fits.
 *
 * Every surface used to carry its own idea of how wide or tall the terminal
 * was — a hard-coded 68-column dialog, a 73-column wordmark, a composer that
 * assumed it could always afford six rows. In a 40x24 or 80x10 window those
 * assumptions overlap each other and bury the input. Deciding it once, from
 * the real dimensions, keeps the surfaces consistent and the thresholds
 * reviewable in a single file.
 *
 * The rule behind the numbers: the composer is the last thing to degrade. A
 * cramped transcript is survivable, an unreachable prompt is not.
 */

/** The ANSI Shadow wordmark is 73 columns, plus room to not touch the edges. */
const WORDMARK_FULL_MIN_COLUMNS = 77;
/** Below this even "WOOPCODE" in plain text crowds out everything else. */
const WORDMARK_COMPACT_MIN_COLUMNS = 24;

/**
 * Columns every transcript row spends before its content starts: one for the
 * rail or the state glyph, one blank.
 *
 * A constant because the transcript had four conventions at once — the user row
 * at column 1, the assistant's label at column 1 with its own body at column 3,
 * tool rows at column 3, a command block's rail back at column 1 — so nothing
 * shared a left edge and the speaker floated free of its own text. One number
 * gives the transcript a single vertical spine.
 */
export const TRANSCRIPT_GUTTER = 2;

/** Rows the bordered composer occupies: border, padding, input, meta line. */
export const BLOCK_COMPOSER_ROWS = 6;
/** Rows the single-line `❯ ` composer occupies. */
export const INLINE_COMPOSER_ROWS = 1;
const HEADER_ROWS = 1;
const STATUS_BAR_ROWS = 1;
/** Fewer visible transcript rows than this and the block composer has to go. */
const MIN_TRANSCRIPT_ROWS = 3;

const SUBTITLE_MIN_ROWS = 14;
const CAPABILITIES_MIN_ROWS = 20;
const HOME_FOOTER_MIN_ROWS = 12;
const STATUS_BAR_MIN_ROWS = 12;
const KEY_HINTS_MIN_COLUMNS = 56;
/**
 * The status bar carries the path, the meter and three hints. Below this the
 * meter is what goes: it is the only one of the three that says nothing about
 * what a keystroke will do.
 */
const CONTEXT_METER_MIN_COLUMNS = 72;
const COMPOSER_PROVIDER_MIN_COLUMNS = 60;
const HEADER_TAGLINE_MIN_COLUMNS = 48;
const HEADER_META_MIN_COLUMNS = 30;
/** Below this the turn footer keeps only the agent and the clock. */
const TURN_MODEL_MIN_COLUMNS = 34;

const CONTENT_SIDE_PADDING = 4;
const PREFERRED_CONTENT_WIDTH = 68;
const MIN_CONTENT_WIDTH = 20;

const MIN_DIALOG_LIST_ROWS = 1;
/** Rows the slash-command popup keeps free for whatever sits behind it. */
const MIN_POPUP_CONTEXT_ROWS = 1;
const COMMAND_POPUP_HEADER_MIN_ROWS = 14;
/** The "↑ n more" / "↓ n more" rows a windowed list can add. */
const DIALOG_SCROLL_INDICATOR_ROWS = 2;
const DIALOG_LABEL_MIN_ROWS = 12;
const DIALOG_HINTS_MIN_ROWS = 18;
/**
 * The dialog border costs two rows, and it is decoration: it exists to lift a
 * panel off a canvas it differs from by 6% luminance. In a window too short to
 * afford it the border goes, the way the hints and the label already do —
 * a bordered dialog with no room for its own list is the worse of the two.
 */
const DIALOG_BORDER_MIN_ROWS = 10;

export type Wordmark = "full" | "compact" | "hidden";
export type ComposerVariant = "block" | "inline";

export interface LayoutPlan {
  wordmark: Wordmark;
  showSubtitle: boolean;
  showCapabilities: boolean;
  showHomeFooter: boolean;
  showStatusBar: boolean;
  showKeyHints: boolean;
  /** The status bar's prompt-size meter; dropped before the key hints are. */
  showContextMeter: boolean;
  /** The composer's "Build · model · provider" line drops the provider first. */
  showComposerProvider: boolean;
  /** Header's " / coding agent" tagline. */
  showHeaderTagline: boolean;
  /** Header's branch and provider, on the right. */
  showHeaderMeta: boolean;
  /** The turn footer's model name; the elapsed time outlives it. */
  showTurnModel: boolean;
  composer: ComposerVariant;
  /** Vertical breathing room between home sections; the first thing to go. */
  rhythm: number;
  /**
   * Total rows the slash-command popup may occupy. It renders in flow, so this
   * is what stops it from pushing the composer or the header off screen.
   */
  commandPopupRows: number;
  showCommandPopupHeader: boolean;
  contentWidth: number;
  dialogWidth: number;
  /** Rows a dialog list may render before it has to scroll. */
  dialogListRows: number;
  /** Margins inside a dialog; 0 in a short terminal. */
  dialogRhythm: number;
  showDialogLabel: boolean;
  showDialogHints: boolean;
  /** The border lifting a dialog off the canvas; dropped in a short window. */
  showDialogBorder: boolean;
  /**
   * False when the window is so short that the "↑ n more" rows would cost more
   * than the list rows they describe.
   */
  showDialogScrollIndicators: boolean;
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Widths that never exceed the terminal. The minimum is a floor for readable
 * content, but it must still lose to the actual window — a 28-column card in a
 * 20-column terminal is the bug, not the fix.
 */
export function fitWidth(
  terminalWidth: number,
  preferred = PREFERRED_CONTENT_WIDTH,
  padding = CONTENT_SIDE_PADDING,
  minimum = MIN_CONTENT_WIDTH,
) {
  const room = Math.max(minimum, terminalWidth - padding);
  return Math.max(1, Math.min(preferred, room, terminalWidth));
}

export function planLayout(width: number, height: number): LayoutPlan {
  // Reserve the chrome that is always present, then see whether the bordered
  // composer still leaves a usable transcript. If not, fall back to the
  // one-line composer rather than letting the two overlap.
  const showStatusBar = height >= STATUS_BAR_MIN_ROWS;
  const fixedRows = HEADER_ROWS + (showStatusBar ? STATUS_BAR_ROWS : 0);
  const transcriptWithBlock = height - fixedRows - BLOCK_COMPOSER_ROWS;
  const composer: ComposerVariant =
    transcriptWithBlock >= MIN_TRANSCRIPT_ROWS ? "block" : "inline";

  const wordmark: Wordmark =
    width >= WORDMARK_FULL_MIN_COLUMNS && height >= SUBTITLE_MIN_ROWS
      ? "full"
      : width >= WORDMARK_COMPACT_MIN_COLUMNS && height >= HOME_FOOTER_MIN_ROWS
        ? "compact"
        : "hidden";

  // A dialog has to fit its own chrome before it can offer list rows, and the
  // scroll indicators are part of that chrome. Budgeting for them is what stops
  // a long list from pushing its own title off the top of the screen. The border
  // is chrome too: it was added to lift the panel off a canvas it differed from
  // by 6% luminance, and two unbudgeted rows would cost the title it protects.
  const dialogRhythm = height >= DIALOG_LABEL_MIN_ROWS ? 1 : 0;
  const showDialogLabel = height >= DIALOG_LABEL_MIN_ROWS;
  const showDialogHints = height >= DIALOG_HINTS_MIN_ROWS;
  const showDialogBorder = height >= DIALOG_BORDER_MIN_ROWS;
  const dialogFixedRows =
    (showDialogBorder ? 2 : 0) + // the border, top and bottom
    2 + // vertical padding
    1 + dialogRhythm + // title and its gap
    1 + dialogRhythm + // search field and its gap
    (showDialogLabel ? 1 : 0) +
    dialogRhythm + // the list's own top margin
    (showDialogHints ? 3 : 0);
  const showDialogScrollIndicators =
    height - dialogFixedRows - DIALOG_SCROLL_INDICATOR_ROWS >= MIN_DIALOG_LIST_ROWS;

  // The popup opens above the composer and used to be absolutely positioned, so
  // it painted over the header, the wordmark, and the transcript instead of
  // giving way to them. In flow it needs a budget: everything the app must keep
  // showing while the list is open, subtracted from the window.
  const composerRows =
    composer === "block" ? BLOCK_COMPOSER_ROWS : INLINE_COMPOSER_ROWS;
  const commandPopupRows = Math.max(
    1,
    height -
      HEADER_ROWS -
      composerRows -
      (showStatusBar ? STATUS_BAR_ROWS : 0) -
      MIN_POPUP_CONTEXT_ROWS,
  );

  return {
    wordmark,
    showSubtitle: height >= SUBTITLE_MIN_ROWS,
    showCapabilities: height >= CAPABILITIES_MIN_ROWS,
    showHomeFooter: height >= HOME_FOOTER_MIN_ROWS,
    showStatusBar,
    showKeyHints: width >= KEY_HINTS_MIN_COLUMNS,
    showContextMeter: width >= CONTEXT_METER_MIN_COLUMNS,
    showComposerProvider: width >= COMPOSER_PROVIDER_MIN_COLUMNS,
    showHeaderTagline: width >= HEADER_TAGLINE_MIN_COLUMNS,
    showHeaderMeta: width >= HEADER_META_MIN_COLUMNS,
    showTurnModel: width >= TURN_MODEL_MIN_COLUMNS,
    composer,
    rhythm: height >= CAPABILITIES_MIN_ROWS ? 3 : height >= SUBTITLE_MIN_ROWS ? 1 : 0,
    commandPopupRows,
    showCommandPopupHeader: height >= COMMAND_POPUP_HEADER_MIN_ROWS,
    contentWidth: fitWidth(width),
    dialogWidth: fitWidth(width),
    dialogListRows: Math.max(
      MIN_DIALOG_LIST_ROWS,
      height -
        dialogFixedRows -
        (showDialogScrollIndicators ? DIALOG_SCROLL_INDICATOR_ROWS : 0),
    ),
    dialogRhythm,
    showDialogLabel,
    showDialogHints,
    showDialogBorder,
    showDialogScrollIndicators,
  };
}

/**
 * Keeps the selected row inside a window of `visibleRows`, so a list longer
 * than the terminal still scrolls to whatever is selected instead of clipping
 * it out of view.
 */
export function windowAround(
  selectedIndex: number,
  total: number,
  visibleRows: number,
) {
  if (total <= visibleRows) return { start: 0, end: total };

  // Center the selection, then push the window back inside the list bounds.
  const half = Math.floor(visibleRows / 2);
  const start = clamp(selectedIndex - half, 0, total - visibleRows);
  return { start, end: start + visibleRows };
}

/**
 * Paths are long and the interesting end is the last segment, so drop leading
 * characters rather than trailing ones.
 */
export function truncateStart(value: string, maxWidth: number) {
  if (maxWidth <= 0) return "";
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return "…";
  return `…${value.slice(-(maxWidth - 1))}`;
}
