import { test } from "bun:test";

/** Bun 1.3 does not ship a benchmark API. Keep benchmark sources executable
 * as regular tests until a dedicated benchmark runner is introduced. */
export const bench = test;
