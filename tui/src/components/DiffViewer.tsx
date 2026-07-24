import { Box, Text } from "ink";

interface DiffViewerProps {
  diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  // Parse unified diff and render with colors
  const lines = diff.split("\n");

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {lines.map((line, idx) => {
        // Skip the first two lines (file headers)
        if (idx < 2) return null;

        let color: "green" | "red" | "cyan" | "dim" = "dim";
        let content = line;

        if (line.startsWith("@@")) {
          color = "cyan";
        } else if (line.startsWith("+")) {
          color = "green";
        } else if (line.startsWith("-")) {
          color = "red";
        }

        return (
          <Text key={idx} color={color}>
            {content}
          </Text>
        );
      })}
    </Box>
  );
}
