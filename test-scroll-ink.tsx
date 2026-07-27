import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput } from 'ink';

const App = () => {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setOffset(o => (o + 1) % 8), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <Box flexDirection="column">
      <Text>Use Up/Down arrows to scroll. Offset: {offset}</Text>
      <Box height={5} width={20} borderStyle="single" flexDirection="column" justifyContent="flex-end" overflow="hidden">
        <Box marginTop={offset}>
          <Text>Line 1</Text>
          <Text>Line 2</Text>
          <Text>Line 3</Text>
          <Text>Line 4</Text>
          <Text>Line 5</Text>
          <Text>Line 6</Text>
          <Text>Line 7</Text>
          <Text>Line 8</Text>
        </Box>
      </Box>
    </Box>
  );
};

render(<App />);
