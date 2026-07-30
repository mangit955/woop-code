/**
 * How much the agent may do without stopping to ask.
 *
 * The values are the strings written to config, so they survive a round trip
 * through `providers.json` and read sensibly when someone opens that file.
 */
export enum ApprovalMode {
  /** Every shell command is confirmed. The behaviour Woopcode shipped with. */
  ALWAYS_ASK = "always-ask",
  /** Inspecting the repository never interrupts; anything that writes asks. */
  AUTO_READ_ONLY = "auto-read-only",
  /** Writing inside the workspace is allowed; deleting and system work asks. */
  AUTO_WORKSPACE = "auto-workspace",
  /** Nothing is confirmed. Unsafe by construction. */
  FULL_AUTO = "full-auto",
}

export interface ApprovalModeInfo {
  mode: ApprovalMode;
  label: string;
  description: string;
  /** Shown with a warning: this mode can destroy work without asking. */
  unsafe: boolean;
}

/**
 * Ordered from most to least supervision, which is the order the picker shows
 * and the order a reader should think about them in.
 */
export const APPROVAL_MODES: readonly ApprovalModeInfo[] = [
  {
    mode: ApprovalMode.ALWAYS_ASK,
    label: "Always ask",
    description: "Confirm every shell command",
    unsafe: false,
  },
  {
    mode: ApprovalMode.AUTO_READ_ONLY,
    label: "Auto read-only",
    description: "Run reads and tests; ask before anything writes",
    unsafe: false,
  },
  {
    mode: ApprovalMode.AUTO_WORKSPACE,
    label: "Auto workspace",
    description: "Also write inside the workspace; ask to delete or touch the system",
    unsafe: false,
  },
  {
    mode: ApprovalMode.FULL_AUTO,
    label: "Full auto",
    description: "Run everything without asking — no protection",
    unsafe: true,
  },
];

/**
 * Reads are safe by construction and interrupting them for confirmation is the
 * thing this feature exists to stop, so that is the default. Anything that
 * writes still asks.
 */
export const DEFAULT_APPROVAL_MODE = ApprovalMode.AUTO_READ_ONLY;

const BY_VALUE = new Map<string, ApprovalMode>(
  Object.values(ApprovalMode).map((mode) => [mode, mode]),
);

/**
 * Turns a config value into a mode, falling back to the default. An unreadable
 * setting must not be able to widen permissions, so anything unrecognised lands
 * on the default rather than on the last mode that happened to parse.
 */
export function parseApprovalMode(value: unknown): ApprovalMode {
  if (typeof value !== "string") return DEFAULT_APPROVAL_MODE;

  return BY_VALUE.get(value.trim().toLowerCase()) ?? DEFAULT_APPROVAL_MODE;
}

export function describeApprovalMode(mode: ApprovalMode): ApprovalModeInfo {
  return (
    APPROVAL_MODES.find((info) => info.mode === mode) ?? APPROVAL_MODES[1]!
  );
}
