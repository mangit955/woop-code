import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * One interval for every animation in the app.
 *
 * Four used to run independently — the status spinner at 60ms, the turn
 * footer's clock at 100ms and its pulse at 240ms, and one `ink-spinner` per
 * running tool at 80ms. Each drove its own `setState`, and Ink repaints the
 * whole frame per commit, so a turn merely waiting on the provider measured
 * 45-60 full repaints a second and 32KB of terminal writes every three. That is
 * the flicker, and none of it was buying anything: three glyphs were moving.
 *
 * Sharing the tick means one commit animates all of them.
 */
const TICK_MS = 100;

const ClockContext = createContext(0);

export function ClockProvider({ children }: { children: ReactNode }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      // Wraps at a large multiple of every consumer's cycle length, so no
      // consumer sees its sequence jump at the wrap.
      setFrame((current) => (current + 1) % 3600);
    }, TICK_MS);

    return () => clearInterval(interval);
  }, []);

  return <ClockContext.Provider value={frame}>{children}</ClockContext.Provider>;
}

/**
 * The current frame, advancing every 100ms.
 *
 * Components that want a slower cycle divide it rather than starting a timer:
 * `Math.floor(frame / 2)` is the old 200ms, and so on. A component that wants a
 * *faster* one cannot have it, which is the point.
 */
export function useClock() {
  return useContext(ClockContext);
}

/** Milliseconds between frames, for consumers converting a duration to frames. */
export const CLOCK_TICK_MS = TICK_MS;
