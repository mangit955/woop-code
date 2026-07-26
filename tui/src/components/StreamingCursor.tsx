import { useState, useEffect } from "react";
import { Text } from "ink";
import { colors } from "../styles/theme";

export function StreamingCursor() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, []);

  return <Text color={colors.textMuted}>{visible ? "▌" : " "}</Text>;
}
