/**
 * The mark is the two block-drawing glyphs ▛▜ rendered as real pixels.
 *
 * ▛ fills its upper-left, upper-right and lower-left quadrants; ▜ fills its
 * upper-left, upper-right and lower-right. Side by side that is a 4x2 grid with
 * six cells filled — a solid bar with a leg at each end:
 *
 *     ████
 *     █  █
 *
 * The cells used to each carry their own step along a periwinkle ramp. They are
 * flat black now: on the white pane the lockup reads as one solid object, and
 * the accent is left to the product itself rather than the wordmark.
 */
const CELL_FILL = "#000000";

const CELLS = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 3, y: 0 },
  { x: 0, y: 1 },
  { x: 3, y: 1 },
];

export function Mark({ height = 18 }: { height?: number }) {
  return (
    <svg
      className="mark"
      viewBox="0 0 4 2"
      height={height}
      width={height * 2}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {CELLS.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width="1"
          height="1"
          fill={CELL_FILL}
        />
      ))}
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <Mark height={17} />
      <span className="logo__name">woopcode</span>
    </span>
  );
}
