import { Box, Text } from "ink";

interface DiffViewerProps {
  diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const lines = diff.split("\n");
  const renderedLines: JSX.Element[] = [];
  
  let contextBuffer: string[] = [];
  const CONTEXT_LINES = 3; // Show 3 lines of context around changes
  
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    
    // Skip file headers (---, +++)
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    
    // Hunk headers (@@)
    if (line.startsWith("@@")) {
      // Flush context buffer with ellipsis if we have old context
      if (contextBuffer.length > CONTEXT_LINES) {
        renderedLines.push(
          <Text key={`ellipsis-${idx}`} dimColor>
            {"  ..."}
          </Text>
        );
        contextBuffer = contextBuffer.slice(-CONTEXT_LINES);
      }
      
      // Render buffered context
      contextBuffer.forEach((ctx, i) => {
        renderedLines.push(
          <Text key={`ctx-${idx}-${i}`} dimColor>
            {ctx}
          </Text>
        );
      });
      contextBuffer = [];
      
      // Render hunk header - subtle
      renderedLines.push(
        <Text key={idx} dimColor>
          {line}
        </Text>
      );
      continue;
    }
    
    // Added lines - bright green
    if (line.startsWith("+")) {
      // Flush context before showing changes
      contextBuffer.forEach((ctx, i) => {
        renderedLines.push(
          <Text key={`ctx-before-${idx}-${i}`} dimColor>
            {ctx}
          </Text>
        );
      });
      contextBuffer = [];
      
      renderedLines.push(
        <Text key={idx} color="green">
          {line}
        </Text>
      );
      continue;
    }
    
    // Removed lines - bright red
    if (line.startsWith("-")) {
      // Flush context before showing changes
      contextBuffer.forEach((ctx, i) => {
        renderedLines.push(
          <Text key={`ctx-before-${idx}-${i}`} dimColor>
            {ctx}
          </Text>
        );
      });
      contextBuffer = [];
      
      renderedLines.push(
        <Text key={idx} color="red">
          {line}
        </Text>
      );
      continue;
    }
    
    // Context lines - buffer them
    if (line.startsWith(" ")) {
      contextBuffer.push(line);
      
      // If buffer gets too large, collapse the middle
      if (contextBuffer.length > CONTEXT_LINES * 2) {
        // Keep first N lines
        const keep = contextBuffer.slice(0, CONTEXT_LINES);
        keep.forEach((ctx, i) => {
          renderedLines.push(
            <Text key={`ctx-${idx}-${i}`} dimColor>
              {ctx}
            </Text>
          );
        });
        
        // Show ellipsis
        renderedLines.push(
          <Text key={`ellipsis-${idx}`} dimColor>
            {"  ..."}
          </Text>
        );
        
        // Keep last N lines in buffer
        contextBuffer = contextBuffer.slice(-CONTEXT_LINES);
      }
    }
  }
  
  // Render any remaining context with ellipsis if too long
  if (contextBuffer.length > CONTEXT_LINES) {
    contextBuffer = contextBuffer.slice(0, CONTEXT_LINES);
    contextBuffer.forEach((ctx, i) => {
      renderedLines.push(
        <Text key={`ctx-end-${i}`} dimColor>
          {ctx}
        </Text>
      );
    });
    renderedLines.push(
      <Text key="ellipsis-end" dimColor>
        {"  ..."}
      </Text>
    );
  } else {
    contextBuffer.forEach((ctx, i) => {
      renderedLines.push(
        <Text key={`ctx-end-${i}`} dimColor>
          {ctx}
        </Text>
      );
    });
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {renderedLines}
    </Box>
  );
}
