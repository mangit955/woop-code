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
  /** How stirred this cell currently is. Decays to zero on its own. */
  stir: number;
  /** Displacement from the grid position, in pixels. Springs back to zero. */
  flowX: number;
  flowY: number;
};

const CELL = 14;

const CLEAR_RADIUS = 220;

// The interaction radius in pixels. A moving pointer stirs cells within this
// distance. The radius is in cell units so the patch scales with density.
const INTERACTION_RADIUS = CELL * 9.5;

const FONT = `"Berkeley Mono","SF Mono","JetBrains Mono",monospace`;

/**
 * One colour for every glyph, ambient and highlighted alike.
 *
 * The field used to run a hue ramp from a pale lavender to a deeper violet and
 * the cursor pushed cells toward this value. Everything is now this value, so
 * the drift that ramp used to carry is expressed in opacity instead — see the
 * `neutral` factor at fill time.
 */
const GLYPH = "124,88,238";

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
    // Smoothed pointer position (lerped toward target each frame).
    let pointerX = 0;
    let pointerY = 0;
    // Raw target from the latest pointermove event.
    let targetPointerX = 0;
    let targetPointerY = 0;
    let pointerIsOverCanvas = false;
    let lastRenderTime = 0;

    // ── Velocity tracking ────────────────────────────────────────────────
    // The pointer's velocity drives *all* interaction now. A stationary
    // cursor produces zero effect; a fast one stirs the characters hard.
    let prevPointerX = 0;
    let prevPointerY = 0;
    /** Smoothed speed in px/ms. Decays toward zero each frame. */
    let pointerSpeed = 0;
    /** Smoothed velocity direction (unit-length when speed > 0). */
    let velDirX = 0;
    let velDirY = 0;

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
            stir: 0,
            flowX: 0,
            flowY: 0,
          });
        }
      }
    }

    function render(time: number) {
      // Left transparent: the pane behind paints the colour, so the canvas only
      // ever contributes glyphs.
      ctx.clearRect(0, 0, width, height);

      const elapsed = time - lastRenderTime;
      lastRenderTime = time;

      // ── Smooth the pointer position ──────────────────────────────────
      const posEasing = 1 - Math.exp(-elapsed * 0.018);
      pointerX = lerp(pointerX, targetPointerX, posEasing);
      pointerY = lerp(pointerY, targetPointerY, posEasing);

      // ── Compute instantaneous velocity and smooth it ─────────────────
      // The velocity of the smoothed pointer, not the raw one, so jitter
      // in the event stream does not make the field nervous.
      if (elapsed > 0) {
        const dx = pointerX - prevPointerX;
        const dy = pointerY - prevPointerY;
        const instantSpeed = Math.hypot(dx, dy) / elapsed;

        // Smooth speed with asymmetric easing: rises fast when the user
        // starts moving, decays slowly for a lingering tail.
        const speedUp = 1 - Math.exp(-elapsed * 0.012);
        const speedDown = 1 - Math.exp(-elapsed * 0.004);
        const speedEasing = instantSpeed > pointerSpeed ? speedUp : speedDown;
        pointerSpeed = lerp(pointerSpeed, instantSpeed, speedEasing);

        // Direction smoothing (only update when there is meaningful motion).
        if (instantSpeed > 0.01) {
          const invSpeed = 1 / (instantSpeed * elapsed);
          const rawDirX = dx * invSpeed;
          const rawDirY = dy * invSpeed;
          const dirEasing = 1 - Math.exp(-elapsed * 0.01);
          velDirX = lerp(velDirX, rawDirX, dirEasing);
          velDirY = lerp(velDirY, rawDirY, dirEasing);
        }
      }
      prevPointerX = pointerX;
      prevPointerY = pointerY;

      // A normalised 0–1 "stirring intensity" derived from speed.
      // Clamp to a comfortable range: gentle movement → subtle stir,
      // fast swipe → full effect. The curve is tuned so you need a real
      // gesture to saturate it.
      const speedNorm = smoothstep(0.04, 0.9, pointerSpeed);

      // ── Density and ambient motion (unchanged) ───────────────────────
      const t = time * 0.00005;

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
        density = Math.min(1, Math.pow(density, 2.1) * 1.26);
        density *= smoothstep(
          CLEAR_RADIUS * 0.6,
          CLEAR_RADIUS * 1.8,
          cell.focusDistance,
        );

        const maxDistance = Math.hypot(width / 2, height / 2);
        const edgeFade =
          1 -
          smoothstep(maxDistance * 0.62, maxDistance * 1.06, cell.centerDistance);

        density *= edgeFade * 0.85 + 0.15;

        const strength = lerp(strengthLeft, strengthRight, cell.x / width);
        const alpha =
          lerp(0.1, 0.92, density * 0.82 + cell.alpha * 0.18) * strength;

        // ── Fluid‐flow interaction ─────────────────────────────────────
        // Instead of a torch/spotlight, the cursor *stirs* nearby characters.
        // The stir is proportional to pointer SPEED, so a stationary cursor
        // has no effect and the interaction naturally stops when the pointer
        // does.
        const offsetX = cell.x + cell.flowX - pointerX;
        const offsetY = cell.y + cell.flowY - pointerY;
        const dist = Math.hypot(offsetX, offsetY);
        const proximity =
          1 - smoothstep(INTERACTION_RADIUS * 0.15, INTERACTION_RADIUS, dist);

        // The push vector: cells are pushed away from the cursor path. This
        // combines the pointer's velocity direction (downstream push) with a
        // radial outward push. The blend gives the swirl its organic character.
        let pushX = 0;
        let pushY = 0;
        if (dist > 0.001) {
          // Radial: outward from the pointer.
          const radialX = offsetX / dist;
          const radialY = offsetY / dist;
          // Tangential/downstream: along the velocity direction.
          // Mix 30% radial + 50% velocity direction for a wake-like shape.
          pushX = radialX * 0.3 + velDirX * 0.5;
          pushY = radialY * 0.3 + velDirY * 0.5;
        }

        // Drive stir from speed × proximity. It rises fast and decays slowly,
        // so the trail lingers behind the cursor like water settling.
        const targetStir = proximity * speedNorm * (pointerIsOverCanvas ? 1 : 0);
        const stirUp = 1 - Math.exp(-elapsed * 0.014);
        const stirDown = 1 - Math.exp(-elapsed * 0.0018);
        const stirEasing = targetStir > cell.stir ? stirUp : stirDown;
        cell.stir = lerp(cell.stir, targetStir, stirEasing);

        // Displacement: push cells away from the path. Spring back to zero
        // with gentle damping so characters slide home instead of snapping.
        const maxDisplace = CELL * 1.2;
        const targetFlowX = pushX * cell.stir * maxDisplace;
        const targetFlowY = pushY * cell.stir * maxDisplace;
        // Spring constant: cells resist more at high displacement, keeping
        // them from flying too far, and return gently at low displacement.
        const springK = 1 - Math.exp(-elapsed * 0.006);
        cell.flowX = lerp(cell.flowX, targetFlowX, springK);
        cell.flowY = lerp(cell.flowY, targetFlowY, springK);

        // ── Ambient field tone (unchanged) ─────────────────────────────
        const tone =
          (noise2D(cell.x * 0.0055 - t * 0.72, cell.y * 0.0055 + t * 0.26) +
            1) *
          0.5;
        const neutral = smoothstep(0.24, 0.76, tone);
        const wash = lerp(0.72, 1, neutral);

        // ── Character selection ────────────────────────────────────────
        const grain =
          ((noise2D(cell.x * 0.012 + t * 0.86, cell.y * 0.012 - t * 0.4) + 1) *
            0.5 +
            cell.character * 0.06) %
          1;
        const baseCharacter = pickCharacter(grain, density);

        // When stirred, crossfade into a denser/more agitated glyph family.
        // The stir value drives the crossfade, so when speed drops to zero
        // the character reverts to its ambient glyph.
        const stirredCharacters = ["+", "*", "#", "%"];
        const stirredCharacter =
          stirredCharacters[
            Math.floor(
              time * 0.003 + cell.phase * stirredCharacters.length + cell.stir * 4,
            ) % stirredCharacters.length
          ]!;

        // Render position includes the flow displacement.
        const drawX = cell.x + cell.flowX;
        const drawY = cell.y + cell.flowY;

        if (cell.stir > 0.01) {
          // ── Stirred rendering ──────────────────────────────────────
          // The base glyph fades back and the stirred glyph takes over.
          // The effect is proportional to stir, so partial movement gives
          // a partial crossfade — no hard on/off threshold.

          // Base glyph recedes.
          const baseAlpha = alpha * wash * (1 - cell.stir * 0.82);
          ctx.fillStyle = `rgba(${GLYPH},${baseAlpha})`;
          ctx.fillText(baseCharacter, drawX, drawY);

          // Stirred glyph: brighter, bolder, displaced.
          const hoverStrength = 0.72 + 0.28 * strength;
          const stirAlpha =
            hoverStrength *
            cell.stir *
            lerp(0.88, 1, density) *
            // A subtle pulse tied to stir intensity — alive, not static.
            (0.9 + 0.1 * Math.sin(time * 0.008 + cell.phase * 7));

          ctx.font = `700 16px ${FONT}`;
          ctx.fillStyle = `rgba(${GLYPH},${stirAlpha})`;
          ctx.fillText(stirredCharacter, drawX, drawY);
          ctx.font = `500 16px ${FONT}`;
        } else {
          // ── Ambient rendering (no stir) ────────────────────────────
          ctx.fillStyle = `rgba(${GLYPH},${alpha * wash})`;
          ctx.fillText(baseCharacter, drawX, drawY);
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

      if (isOverCanvas) {
        const nextX = event.clientX - rect.left;
        const nextY = event.clientY - rect.top;

        if (!wasOverCanvas) {
          pointerX = nextX;
          pointerY = nextY;
          targetPointerX = nextX;
          targetPointerY = nextY;
          prevPointerX = nextX;
          prevPointerY = nextY;
          pointerSpeed = 0;
        }

        targetPointerX = nextX;
        targetPointerY = nextY;
      }
    };

    const hidePointer = () => {
      pointerIsOverCanvas = false;
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
