import { useState, useEffect } from "react";

interface TerminalSize {
  width: number;
  height: number;
}

/**
 * Returns the current terminal dimensions and re-renders whenever
 * the terminal is resized (SIGWINCH). This is how we make the app
 * fill the full terminal and adjust on resize — same approach as
 * OpenCode's useTerminalDimensions().
 */
export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>({
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  });

  useEffect(() => {
    function onResize() {
      setSize({
        width: process.stdout.columns || 80,
        height: process.stdout.rows || 24,
      });
    }

    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return size;
}
