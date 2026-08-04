/**
 * Where the thumb goes, given what is scrolled and by how much.
 *
 * Pure and separate from the component because it is the part that can be
 * wrong in a way nobody notices: a thumb that renders is not a thumb that
 * points at the right rows, and the arithmetic is the same for the transcript
 * and for the diff even though the two scroll in opposite directions.
 */

export interface Thumb {
  /** Rows between the top of the track and the top of the thumb. */
  start: number;
  /** Rows the thumb covers. At least one, so it is never invisible. */
  size: number;
}

/**
 * The thumb for a viewport, or null when everything already fits.
 *
 * `offsetFromTop` is how far the first visible row is below the first row of
 * the content. The transcript stores its offset the other way round — it is
 * bottom-anchored, so its offset counts up from the *last* line — and converts
 * at the call site rather than here, because the conversion is a fact about
 * that viewport rather than about scrollbars.
 */
export function scrollbarThumb(
  contentHeight: number,
  viewportHeight: number,
  offsetFromTop: number,
): Thumb | null {
  if (viewportHeight <= 0) return null;
  if (contentHeight <= viewportHeight) return null;

  // Proportional, then floored to one row: on a long diff in a short window the
  // exact proportion rounds to zero, and a scrollbar with no thumb says the
  // content fits — the opposite of what is true.
  const size = Math.max(
    1,
    Math.round((viewportHeight * viewportHeight) / contentHeight),
  );

  const scrollable = contentHeight - viewportHeight;
  const travel = viewportHeight - size;
  const progress = Math.min(1, Math.max(0, offsetFromTop / scrollable));

  // Rounding the ends rather than the middle: the thumb must touch the top when
  // nothing is scrolled and the bottom when everything is, or the bar implies
  // there is more to reach when there is not.
  const start = Math.round(progress * travel);

  return { start: Math.min(start, travel), size };
}
