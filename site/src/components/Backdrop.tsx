import { AsciiCanvas } from "./AsciiCanvas";

/**
 * The panel's background layer. It spans both halves so the field is continuous
 * across the middle — the panes sit on top of it and paint no colour of their
 * own.
 */
export function Backdrop({
  strengthLeft = 1,
  strengthRight = 1,
  focusX = 0.5,
}: {
  strengthLeft?: number;
  strengthRight?: number;
  focusX?: number;
}) {
  return (
    <div className="backdrop">
      <AsciiCanvas
        strengthLeft={strengthLeft}
        strengthRight={strengthRight}
        focusX={focusX}
      />

      <div className="vignette" />
    </div>
  );
}
