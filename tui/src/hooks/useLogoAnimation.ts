import { useState, useEffect, useRef } from "react";

export type AnimationMode = "highlight" | "typewriter" | "scan";

export interface LogoAnimationState {
  /** The text that should be visible (for typewriter mode) */
  visibleText: string;
  /** Current position of the highlight/scan (0-1, normalized) */
  highlightPosition: number;
  /** Overall animation progress (0-1) */
  progress: number;
  /** Whether animation has completed */
  isComplete: boolean;
}

interface UseLogoAnimationOptions {
  text: string;
  duration: number;
  mode: AnimationMode;
  onComplete?: () => void;
}

/**
 * Custom animation hook for logo reveal effects.
 * Uses interval-based timing for smooth animations in the terminal.
 */
export function useLogoAnimation({
  text,
  duration,
  mode,
  onComplete,
}: UseLogoAnimationOptions): LogoAnimationState {
  const [state, setState] = useState<LogoAnimationState>({
    visibleText: mode === "typewriter" ? "" : text,
    highlightPosition: 0,
    progress: 0,
    isComplete: false,
  });

  const startTimeRef = useRef<number>(Date.now());
  const onCompleteCalledRef = useRef(false);

  useEffect(() => {
    startTimeRef.current = Date.now();
    
    // Use 16ms interval for ~60fps
    const intervalId = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);

      // Calculate state based on animation mode
      const newState = calculateAnimationState(text, progress, mode);

      setState(newState);

      // Call onComplete exactly once when animation finishes
      if (progress >= 1) {
        if (!onCompleteCalledRef.current) {
          onCompleteCalledRef.current = true;
          onComplete?.();
        }
        clearInterval(intervalId);
      }
    }, 16);

    return () => {
      clearInterval(intervalId);
    };
  }, [text, duration, mode, onComplete]);

  return state;
}

/**
 * Calculate animation state based on progress and mode
 */
function calculateAnimationState(
  text: string,
  progress: number,
  mode: AnimationMode
): LogoAnimationState {
  const isComplete = progress >= 1;

  switch (mode) {
    case "typewriter": {
      const numChars = Math.floor(progress * text.length);
      return {
        visibleText: text.slice(0, numChars + (isComplete ? text.length : 0)),
        highlightPosition: progress,
        progress,
        isComplete,
      };
    }

    case "scan":
    case "highlight": {
      // For highlight and scan, full text is visible, only position changes
      return {
        visibleText: text,
        highlightPosition: progress,
        progress,
        isComplete,
      };
    }

    default:
      return {
        visibleText: text,
        highlightPosition: progress,
        progress,
        isComplete,
      };
  }
}
