import { Box } from "ink";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

const PLACEHOLDER_ROTATION_MS = 3500;
const TYPEWRITER_FRAME_MS = 24;

export interface PromptCardProps {
  width: number;
  examples: readonly string[];
  children: (placeholder: string) => ReactNode;
}

export function PromptCard({ width, examples, children }: PromptCardProps) {
  const placeholder = useRotatingPlaceholder(examples);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} width={width}>
      {children(placeholder)}
    </Box>
  );
}

function useRotatingPlaceholder(examples: readonly string[]) {
  const [index, setIndex] = useState(0);
  const [visibleLength, setVisibleLength] = useState(0);
  const example = examples[index] ?? "";

  useEffect(() => {
    if (examples.length < 2) return;

    const interval = setInterval(() => {
      setVisibleLength(0);
      setIndex((current) => (current + 1) % examples.length);
    }, PLACEHOLDER_ROTATION_MS);

    return () => clearInterval(interval);
  }, [examples]);

  useEffect(() => {
    if (visibleLength >= example.length) return;

    const timer = setTimeout(
      () => setVisibleLength((length) => length + 1),
      TYPEWRITER_FRAME_MS,
    );

    return () => clearTimeout(timer);
  }, [example, visibleLength]);

  return example.slice(0, visibleLength);
}
