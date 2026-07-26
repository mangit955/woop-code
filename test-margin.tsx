import React from 'react';
import { render, Box, Text } from 'ink';

function App() {
  return (
    <Box flexDirection="column" height={5} overflow="hidden" borderStyle="single">
      <Box flexDirection="column" marginTop={-2}>
        {Array.from({ length: 10 }).map((_, i) => (
          <Text key={i}>Line {i}</Text>
        ))}
      </Box>
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
setTimeout(() => process.exit(0), 100);
