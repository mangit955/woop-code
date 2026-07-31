import { useEffect, useRef } from "react";
import { createNoise2D } from "simplex-noise";

type Cell = {
  x: number;
  y: number;
  /** From the middle of the canvas. Drives the fade toward the outer edges. */
  centerDistance: number;
  /** From the focus point. Drives the clearing the artwork sits in. */
  focusDistance: number;
  character: number;
  alpha: number;
  phase: number;
  /** Current lavender carry-over from the pointer interaction. */
  interaction: number;
};

const CELL = 14;

const CLEAR_RADIUS = 220;

// The interaction colours existing glyphs; it does not paint a blurred layer
// over the canvas. Keeping the radius in cell units makes the patch feel the
// same as the density changes at different viewport sizes.
const INTERACTION_RADIUS = CELL * 8;

const FONT = `"Berkeley Mono","SF Mono","JetBrains Mono",monospace`;

function smoothstep(edge0: number, edge1: number, x: number) {
  x = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickCharacter(random: number, density: number) {
  if (density < 0.25) {
    return random < 0.7 ? "." : ":";
  }

  if (density < 0.5) {
    return random < 0.5 ? "-" : "=";
  }

  if (density < 0.8) {
    return random < 0.5 ? "+" : "*";
  }

  return random < 0.5 ? "#" : "%";
}

interface AsciiCanvasProps {
  /** Opacity multiplier at the left edge. */
  strengthLeft?: number;
  /** Opacity multiplier at the right edge; the field ramps between the two. */
  strengthRight?: number;
  /** Where the clearing sits, 0 = left edge, 1 = right edge. */
  focusX?: number;
}

/**
 * One field spans the whole panel and ramps horizontally from `strengthLeft` to
 * `strengthRight`. It is a ramp rather than two canvases at two strengths
 * because any step in density reads as a seam down the middle of the panel.
 */
export function AsciiCanvas({
  strengthLeft = 1,
  strengthRight = 1,
  focusX = 0.5,
}: AsciiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;

    const ctx = canvas.getContext("2d")!;
    const noise2D = createNoise2D(mulberry32(20260731));
    let cells: Cell[] = [];
    let width = 0;
    let height = 0;
    let animationId = 0;
    let pointerX = 0;
    let pointerY = 0;
    let targetPointerX = 0;
    let targetPointerY = 0;
    let pointerIsOverCanvas = false;
    let pointerPresence = 0;
    let targetPointerPresence = 0;
    let lastRenderTime = 0;

    function generateField() {
      const rect = canvas.getBoundingClientRect();

      width = rect.width;
      height = rect.height;

      const dpr = window.devicePixelRatio || 1;

      canvas.width = width * dpr;
      canvas.height = height * dpr;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Medium rather than regular: at these opacities the glyphs need a little
      // more body to read as characters instead of speckle. Faces without a 500
      // fall back to 400, so this is a no-op rather than a jump to bold.
      ctx.font = `500 16px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.imageSmoothingEnabled = true;

      const random = mulberry32(20260731);

      const cols = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);

      const cx = width / 2;
      const cy = height / 2;

      // The clearing does not have to sit in the middle: on the panel-wide
      // field it follows the artwork over in the right half.
      const fx = width * focusX;
      const fy = height / 2;

      cells = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * CELL + CELL / 2;
          const y = row * CELL + CELL / 2;

          const centerDistance = Math.hypot(x - cx, y - cy);
          const focusDistance = Math.hypot(x - fx, y - fy);

          const jitter = CELL * 0.08;
          const px = x + (random() - 0.5) * jitter;
          const py = y + (random() - 0.5) * jitter;

          cells.push({
            x: px,
            y: py,
            centerDistance,
            focusDistance,
            character: random(),
            alpha: random(),
            phase: random(),
            interaction: 0,
          });
        }
      }
    }

    function render(time: number) {
      // Left transparent: the pane behind paints the colour, so the canvas only
      // ever contributes glyphs.
      ctx.clearRect(0, 0, width, height);

      // Density controls the field's subtle weight, but never whether a grid
      // position has a character. The reference interaction is a continuous
      // ASCII lattice, not clusters of glyphs appearing and disappearing.
      //
      // Everything ambient is driven from this one clock, and every field it
      // feeds is sampled from noise in both space and time. That is what keeps
      // the motion calm: neighbouring cells always hold near-identical values,
      // so the field drifts as a whole instead of each cell acting alone.
      const t = time * 0.00005;
      const elapsed = time - lastRenderTime;
      lastRenderTime = time;
      // Cursor events arrive in uneven bursts. Filtering both the position and
      // the presence of the interaction gives the colour field a soft, liquid
      // response instead of sharp pointer-following jumps.
      const easing = 1 - Math.exp(-elapsed * 0.018);
      pointerX = lerp(pointerX, targetPointerX, easing);
      pointerY = lerp(pointerY, targetPointerY, easing);
      pointerPresence = lerp(pointerPresence, targetPointerPresence, easing);

      for (const cell of cells) {
        // Two octaves, both drifting the same way and at close to the same
        // rate. The old third octave was high-frequency and travelled against
        // the other two, which is what made the field boil rather than move.
        const n1 =
          (noise2D(cell.x * 0.0075 + t, cell.y * 0.0075 + t * 0.34) + 1) * 0.5;
        const n2 =
          (noise2D(
            cell.x * 0.019 + t * 0.62,
            cell.y * 0.019 + t * 0.22,
          ) +
            1) *
          0.5;

        let density = n1 * 0.72 + n2 * 0.28;
        density = Math.min(1, Math.pow(density, 1.55) * 1.35);
        density *= smoothstep(
          CLEAR_RADIUS * 0.6,
          CLEAR_RADIUS * 1.8,
          cell.focusDistance,
        );

        // Measured against the half-diagonal rather than the width, so the fade
        // reaches the same way whatever shape the canvas is. The two constants
        // are where the old width-based pair landed on a single pane.
        const maxDistance = Math.hypot(width / 2, height / 2);
        const edgeFade =
          1 -
          smoothstep(maxDistance * 0.62, maxDistance * 1.06, cell.centerDistance);

        density *= edgeFade * 0.85 + 0.15;

        // Every cell has a minimum opacity. The density still gives the field
        // shape, but no location goes empty as the noise evolves.
        const alpha =
          lerp(0.28, 0.76, density * 0.78 + cell.alpha * 0.22) *
          lerp(strengthLeft, strengthRight, cell.x / width);

        // A low-frequency noise field carries lavender through the glyphs. It
        // has no brightening or hard bands, so the interaction reads as colour
        // flowing through the ASCII rather than light cast by the cursor.
        const offsetX = cell.x - pointerX;
        const offsetY = cell.y - pointerY;
        const radius = 1 -
          smoothstep(
            INTERACTION_RADIUS * 0.28,
            INTERACTION_RADIUS,
            Math.hypot(offsetX, offsetY),
          );
        const current =
          (noise2D(
            cell.x * 0.024 + time * 0.00016,
            cell.y * 0.024 - time * 0.00011,
          ) +
            1) *
          0.5;
        const targetInteraction =
          radius * lerp(0.38, 1, current) * pointerPresence;
        // Each character keeps a little of the colour it picked up. It takes
        // on lavender promptly, then returns to its base colour more slowly;
        // that lingering per-cell fade is what makes the response feel fluid
        // after the cursor has already moved away.
        const interactionEasing =
          1 -
          Math.exp(
            -elapsed *
              (targetInteraction > cell.interaction ? 0.018 : 0.0042),
          );
        cell.interaction = lerp(
          cell.interaction,
          targetInteraction,
          interactionEasing,
        );
        // The field's normal motion: pale to lavender and back. This used to be
        // a per-cell sawtooth — every cell ran its own timer from its own phase
        // offset, so cells snapped back to pale at the wrap, at a different
        // moment each. Hundreds of independent snaps is what read as chaos.
        //
        // Reading the tone from a slow, very low-frequency noise field fixes
        // both halves of that: it is continuous in time, so there is no wrap to
        // snap at, and continuous in space, so the colour arrives as a broad
        // wash moving across the panel rather than cell by cell.
        const tone =
          (noise2D(cell.x * 0.0055 - t * 0.72, cell.y * 0.0055 + t * 0.26) +
            1) *
          0.5;
        const neutral = smoothstep(0.24, 0.76, tone);
        const baseRed = 236 - neutral * 92;
        const baseGreen = 222 - neutral * 96;
        const baseBlue = 252 - neutral * 28;
        const red = Math.round(lerp(baseRed, 137, cell.interaction));
        const green = Math.round(lerp(baseGreen, 104, cell.interaction));
        const blue = Math.round(lerp(baseBlue, 239, cell.interaction));
        // The ambient field keeps changing even while the pointer is still or
        // away from the canvas. This is independent from the hover state, so
        // the interaction only affects the nearby characters.
        //
        // Which glyph a cell picks also comes from noise now. It used to step
        // on `Math.floor(time + phase)`, so every cell swapped character at its
        // own instant and the panel was permanently sprinkled with unrelated
        // flips. From a noise field a region agrees on its glyph and the change
        // sweeps through, which is the difference between shimmer and drift.
        // `cell.character` stays in as a small offset so the whole region does
        // not turn over on precisely the same frame.
        const grain =
          ((noise2D(cell.x * 0.012 + t * 0.86, cell.y * 0.012 - t * 0.4) + 1) *
            0.5 +
            cell.character * 0.06) %
          1;
        const baseCharacter = pickCharacter(grain, density);
        // Nearby cells crossfade into a deliberately small family of glyphs.
        // Because `interaction` recedes slowly, the original symbol returns
        // with the soft flicker visible in the reference clip.
        const hoverCharacters = ["+", "*", "#"];
        const hoverCharacter =
          hoverCharacters[
            Math.floor(time * 0.005 + cell.phase * hoverCharacters.length) %
              hoverCharacters.length
          ]!;

        ctx.fillStyle = `rgba(${red},${green},${blue},${
          alpha * (1 - cell.interaction * 0.48)
        })`;
        ctx.fillText(baseCharacter, cell.x, cell.y);

        if (cell.interaction > 0.01) {
          // Highlighted glyphs bounce vertically in place. The motion is
          // deliberately one-dimensional so it reads as a bounce, while the
          // underlying grid stays evenly spaced and easy to scan.
          const hoverX = cell.x;
          const hoverY =
            cell.y -
            Math.abs(Math.sin(time * 0.0065 + cell.phase * 8)) *
              cell.interaction *
              4;
          const hoverAlpha =
            alpha *
            cell.interaction *
            (0.76 + 0.24 * Math.sin(time * 0.006 + cell.phase * 9));

          ctx.fillStyle = `rgba(137,104,239,${hoverAlpha})`;
          ctx.fillText(hoverCharacter, hoverX, hoverY);
        }
      }

      animationId = requestAnimationFrame(render);
    }

    generateField();
    animationId = requestAnimationFrame(render);

    const resize = () => {
      generateField();
    };

    const updatePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const isOverCanvas =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      const wasOverCanvas = pointerIsOverCanvas;
      pointerIsOverCanvas = isOverCanvas;
      targetPointerPresence = isOverCanvas ? 1 : 0;

      if (isOverCanvas) {
        const nextX = event.clientX - rect.left;
        const nextY = event.clientY - rect.top;

        if (!wasOverCanvas) {
          pointerX = nextX;
          pointerY = nextY;
          targetPointerX = nextX;
          targetPointerY = nextY;
          pointerPresence = 0;
        }

        targetPointerX = nextX;
        targetPointerY = nextY;
      }
    };

    const hidePointer = () => {
      pointerIsOverCanvas = false;
      targetPointerPresence = 0;
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", updatePointer, { passive: true });
    window.addEventListener("blur", hidePointer);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", updatePointer);
      window.removeEventListener("blur", hidePointer);
    };
  }, [strengthLeft, strengthRight, focusX]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
