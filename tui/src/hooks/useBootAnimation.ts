import { useState, useEffect } from "react";

export type BootPhase = "logo" | "steps" | "launching" | "done";

export interface BootAnimationState {
  logoText: string;
  loadingStep: number; // index of the currently-spinning step (-1 = none)
  doneSteps: Set<number>;
  phase: BootPhase;
}

const LOGO = "Woopcode";
const STEPS = ["Runtime", "Provider", "Tool Registry", "Repository Context"];

const LOGO_DURATION_MS = 600; // duration of LogoReveal animation
const STEP_HOLD_MS = 180;     // how long spinner stays on a step before it completes
const STEP_GAP_MS  = 220;     // gap between steps starting (must be > STEP_HOLD_MS)
const LAUNCH_MS    = 350;     // "Launching..." shown for this long before onComplete

export function useBootAnimation(onComplete: () => void): BootAnimationState {
  const [logoText, setLogoText]     = useState("");
  const [loadingStep, setLoadingStep] = useState(-1);
  const [doneSteps, setDoneSteps]   = useState<Set<number>>(new Set());
  const [phase, setPhase]           = useState<BootPhase>("logo");

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const t = (ms: number, fn: () => void) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };

    // ── Logo reveal ───────────────────────────────────────────────────────
    // LogoReveal component handles the animation, we just wait for it
    const afterLogo = LOGO_DURATION_MS;

    // ── Steps ─────────────────────────────────────────────────────────────
    t(afterLogo, () => setPhase("steps"));

    STEPS.forEach((_, i) => {
      const stepStart = afterLogo + i * STEP_GAP_MS;
      t(stepStart,              () => setLoadingStep(i));
      t(stepStart + STEP_HOLD_MS, () => {
        setDoneSteps((prev) => new Set(prev).add(i));
        setLoadingStep(-1);
      });
    });

    const afterSteps = afterLogo + STEPS.length * STEP_GAP_MS + STEP_HOLD_MS;

    // ── Launching ─────────────────────────────────────────────────────────
    t(afterSteps, () => setPhase("launching"));
    t(afterSteps + LAUNCH_MS, () => {
      setPhase("done");
      onComplete();
    });

    return () => timers.forEach(clearTimeout);
    // onComplete is stable (comes from useState setter reference in agent.tsx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { logoText, loadingStep, doneSteps, phase };
}

export { STEPS };
