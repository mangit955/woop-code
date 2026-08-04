/**
 * The prompts submitted this session, and where ↑ has walked to in them.
 *
 * Session-scoped and never written to disk. Prompts routinely contain the
 * contents of whatever the user was looking at, so persisting them would put
 * fragments of one project's code in front of the next; the shells this borrows
 * its keys from make that choice too and get it wrong often enough to be a
 * known hazard.
 *
 * Pure, with no React in it, because the interesting part is the walk: an index
 * that runs off either end, or forgets where it was when the user types, is a
 * bug you can only see by pressing keys in an order nobody tests by hand.
 */
export class PromptHistory {
  private entries: string[] = [];
  /**
   * How far back ↑ has walked. -1 means "not walking" — the composer is showing
   * what the user typed rather than a recalled entry.
   */
  private cursor = -1;
  /** What was in the composer when the walk started, restored by walking back off the end. */
  private draft = "";

  /** Records a submitted prompt and ends any walk in progress. */
  push(prompt: string) {
    const value = prompt.trim();
    this.reset();

    if (value === "") return;
    // A prompt repeated immediately is one entry: pressing ↑ twice to reach the
    // one before it is the behaviour every shell has.
    if (this.entries.at(-1) === value) return;

    this.entries.push(value);
  }

  /**
   * The previous prompt, or null when there is nothing older to show.
   *
   * `current` is kept so that walking back down past the newest entry returns
   * the half-typed line the user abandoned rather than an empty composer.
   */
  previous(current: string): string | null {
    if (this.entries.length === 0) return null;

    if (this.cursor === -1) {
      this.draft = current;
      this.cursor = this.entries.length - 1;
      return this.entries[this.cursor] ?? null;
    }

    if (this.cursor === 0) return null;

    this.cursor -= 1;
    return this.entries[this.cursor] ?? null;
  }

  /** The next prompt down, or the abandoned draft at the bottom of the walk. */
  next(): string | null {
    if (this.cursor === -1) return null;

    if (this.cursor >= this.entries.length - 1) {
      const draft = this.draft;
      this.reset();
      return draft;
    }

    this.cursor += 1;
    return this.entries[this.cursor] ?? null;
  }

  /** True while ↑ is showing a recalled entry rather than the user's own text. */
  isWalking() {
    return this.cursor !== -1;
  }

  /** Whether ↑ has anything to offer at all. Empty history falls back to scrolling. */
  isEmpty() {
    return this.entries.length === 0;
  }

  /** Ends the walk, leaving whatever is in the composer alone. */
  reset() {
    this.cursor = -1;
    this.draft = "";
  }
}
