import React from "react";
import { render, Box, Text } from "ink";

function App() {
  const [offset, setOffset] = React.useState(0);

  React.useEffect(() => {
    const t = setInterval(() => setOffset((o) => (o + 1) % 5), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <Box flexDirection="column" height={10} width={20} borderStyle="single">
      <Box flexDirection="column-reverse" flexGrow={1} overflow="hidden">
        <Box marginTop={offset * 2} flexDirection="column">
          <Text>Line 1 (oldest)</Text>
          <Text>Line 2</Text>
          <Text>Line 3</Text>
          <Text>Line 4</Text>
          <Text>Line 5</Text>
          <Text>Line 6</Text>
          <Text>Line 7</Text>
          <Text>Line 8 (newest)</Text>
        </Box>
      </Box>
      <Text>Offset: {offset}</Text>
    </Box>
  );
}

render(<App />);
