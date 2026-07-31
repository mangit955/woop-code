import { useEffect, useRef, useState } from "react";
import { morphFrame, planColumns } from "./scramble";

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Morphs from whatever is on screen to `value`, one column at a time, left to
 * right. The text is monospaced, so a column holds its position while it churns
 * and only the character in it changes.
 */
export function ScrambleText({ value }: { value: string }) {
  const [display, setDisplay] = useState(value);
  // What is actually on screen right now. The animation reads this rather than
  // the previous `value`, so an interrupted morph carries on from where it got
  // to instead of snapping back to the last settled command.
  const displayRef = useRef(value);

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    const from = displayRef.current;
    if (from === value) return;

    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }

    const plan = planColumns(from, value);
    let frame = 0;
    let animationId = 0;

    const tick = () => {
      const { text, settled } = morphFrame(from, value, plan, frame);

      setDisplay(text);
      if (settled) return;

      frame += 1;
      animationId = requestAnimationFrame(tick);
    };

    animationId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(animationId);
  }, [value]);

  return <>{display}</>;
}
