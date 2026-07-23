import { useState, useEffect } from "react";
import { Text } from "ink";

export function StreamingCursor() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, []);

  return <Text dimColor>{visible ? "▌" : " "}</Text>;
}
