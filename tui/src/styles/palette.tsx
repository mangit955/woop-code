import { createContext, useContext, type ReactNode } from "react";
import {
  colors,
  dimmedColors,
  markdownColors,
  dimmedMarkdownColors,
  type MarkdownPalette,
  type Palette,
} from "./theme";

interface PaletteState {
  colors: Palette;
  markdown: MarkdownPalette;
  /** True while this subtree is behind a dialog. */
  dimmed: boolean;
}

const lit: PaletteState = { colors, markdown: markdownColors, dimmed: false };
const faded: PaletteState = {
  colors: dimmedColors,
  markdown: dimmedMarkdownColors,
  dimmed: true,
};

const PaletteContext = createContext<PaletteState>(lit);

/**
 * Fades everything rendered inside it.
 *
 * Context rather than a module flag on purpose: a context change propagates
 * through `memo`, so the memoised transcript rows redraw when a dialog opens.
 * A module-level flag would leave them at full brightness until their own props
 * happened to change.
 */
export function PaletteProvider({
  dimmed,
  children,
}: {
  dimmed: boolean;
  children: ReactNode;
}) {
  return (
    <PaletteContext.Provider value={dimmed ? faded : lit}>
      {children}
    </PaletteContext.Provider>
  );
}

/**
 * The palette for the current layer. Components use this instead of importing
 * `colors` directly, so the same component renders lit in a dialog and faded
 * behind one.
 */
export function usePalette(): Palette {
  return useContext(PaletteContext).colors;
}

/** The markdown body palette for the current layer. */
export function useMarkdownPalette(): MarkdownPalette {
  return useContext(PaletteContext).markdown;
}

/** For components that mix their own colours and need to fade them too. */
export function useDimmed(): boolean {
  return useContext(PaletteContext).dimmed;
}
