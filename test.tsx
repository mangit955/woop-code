import React, { useState } from 'react';
import { render, Box, Text, useInput } from 'ink';

function App() {
  const [offset, setOffset] = useState(0);
  
  useInput((input, key) => {
    if (key.upArrow) setOffset(o => o - 1);
    if (key.downArrow) setOffset(o => o + 1);
    
    // ctrl+c to exit
    if (key.ctrl && input === 'c') process.exit(0);
  });

  return (
    <Box flexDirection="column" height={10} overflow="hidden" borderStyle="single">
      <Box flexDirection="column" marginTop={-offset}>
        {Array.from({ length: 30 }).map((_, i) => (
          <Text key={i}>Line {i}</Text>
        ))}
      </Box>
    </Box>
  );
}

render(<App />);
