import React from 'react';
import { render, Box, Text } from 'ink';

const App = () => {
  React.useEffect(() => {
    setTimeout(() => process.exit(0), 100);
  }, []);
  return (
    <Box height={5} width={20} borderStyle="single" flexDirection="column" overflow="hidden">
      <Box flexDirection="column-reverse" flexGrow={1} minHeight={0} overflow="hidden">
        <Box flexGrow={1} />
        <Box flexDirection="column" flexShrink={0} marginBottom={-1}>
          <Text>Line 1 (oldest)</Text>
          <Text>Line 2</Text>
          <Text>Line 3</Text>
          <Text>Line 4</Text>
          <Text>Line 5</Text>
          <Text>Line 6 (newest)</Text>
        </Box>
      </Box>
    </Box>
  );
};

render(<App />);
