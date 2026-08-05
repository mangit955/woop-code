import type { Tool } from "../config/types";
import { requestCodeApproval } from "./approval";
import {
  DEFAULT_EVAL_TIMEOUT_SECONDS,
  MAX_REPL_OUTPUT,
  ReplUnavailableError,
  evaluate,
  type ReplLanguage,
} from "./replSession";

const LANGUAGES: ReplLanguage[] = ["python", "node"];

function isLanguage(value: unknown): value is ReplLanguage {
  return typeof value === "string" && LANGUAGES.includes(value as ReplLanguage);
}

export const replTool: Tool = {
  name: "repl",
  description: `Runs code in an interpreter that stays alive between calls, so variables, imports and loaded data persist.

Use it instead of \`run_terminal\` with \`python3 -c\` or \`node -e\` whenever the work takes more than one step over the same data. Load a file, parse an archive or decode a video once, then keep querying what is already in memory — re-reading the same input on every call is the single most expensive habit available here.

State lasts for the current turn and is discarded when the turn ends.

python: the value of a trailing expression is printed, as in a notebook.
node: a top-level \`var\` persists between calls; \`const\` and \`let\` are scoped to the single call, so assign to \`globalThis\` for anything that must outlive it.

This runs real code. It can write files and shell out, and is subject to the same approval and plan-mode rules as run_terminal.`,

  parameters: [
    {
      name: "language",
      description: "Which interpreter to use.",
      required: true,
      enum: LANGUAGES,
    },
    {
      name: "code",
      description:
        "Source to evaluate in the session. May be several statements; it runs in the same namespace as previous calls.",
      required: true,
    },
    {
      name: "restart",
      description:
        "Discard the existing session and start an empty one before running this code. Use after leaving the interpreter in a bad state, not routinely — restarting throws away the loaded data that makes this tool worth using.",
      required: false,
      type: "boolean",
    },
    {
      name: "timeout",
      description: `Seconds this evaluation may run (default: ${DEFAULT_EVAL_TIMEOUT_SECONDS}). Exceeding it discards the session and its variables.`,
      required: false,
      type: "number",
    },
  ],

  async execute(args, signal) {
    const language = args.language;
    const code = args.code;

    // Validated before anything is spawned: the contract sweep calls this with
    // no arguments at all.
    if (!isLanguage(language)) {
      throw Error(
        `language must be one of ${LANGUAGES.join(", ")}, got ${JSON.stringify(args.language)}`,
      );
    }

    if (typeof code !== "string" || code.trim() === "") {
      throw Error("code is required and must be a non-empty string");
    }

    const timeout = args.timeout;
    if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
      throw Error(`timeout must be a positive number of seconds, got ${JSON.stringify(timeout)}`);
    }

    const { approved } = await requestCodeApproval(code, language);
    if (!approved) {
      return "Code rejected by user. It was not run, and the session is unchanged.";
    }

    let output: string;
    let started: boolean;
    try {
      ({ output, started } = await evaluate(language, code, {
        restart: args.restart === true,
        timeoutSeconds: timeout,
        signal,
      }));
    } catch (error) {
      if (error instanceof ReplUnavailableError) throw error;
      // A lost session is returned as a result rather than thrown so the model
      // can rebuild its state and carry on; the message says what was lost.
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }

    // An evaluation that assigns a variable prints nothing, which is a success
    // and has to read as one — an empty result looks like a tool that failed.
    if (output === "") {
      return started
        ? `Started a ${language} session. The code ran and produced no output.`
        : "The code ran and produced no output.";
    }

    if (output.length > MAX_REPL_OUTPUT) {
      return (
        `${output.slice(0, MAX_REPL_OUTPUT)}\n\n` +
        `... Output truncated: showing the first ${MAX_REPL_OUTPUT} of ${output.length} characters. ` +
        `The session still holds the full result — print a slice or a summary of it instead.`
      );
    }

    return output;
  },
};
