import type { Tool } from "../config/types";
import { requestCodeApproval } from "./approval";
import { currentExecutor } from "../runtime/sandbox";
import { budgetedTimeout, formatTimeoutError } from "./timeoutBudget";
import { REPL_LANGUAGES as LANGUAGES, isReplLanguage as isLanguage } from "./replDrivers";
import {
  DEFAULT_EVAL_TIMEOUT_SECONDS,
  MAX_REPL_OUTPUT,
  ReplUnavailableError,
  evaluate,
} from "./replSession";

export const replTool: Tool = {
  name: "repl",
  description: `Runs code in an interpreter that stays alive between calls, so variables, imports and loaded data persist.

Use it instead of \`run_terminal\` with \`python3 -c\` or \`node -e\` whenever the work takes more than one step over the same data. Load a file, parse an archive or decode a video once, then keep querying what is already in memory — re-reading the same input on every call is the single most expensive habit available here.

State lasts for the current turn and is discarded when the turn ends.

python: the value of a trailing expression is printed, as in a notebook.
node: a top-level \`var\` persists between calls; \`const\` and \`let\` are scoped to the single call, so assign to \`globalThis\` for anything that must outlive it.

This runs real code. It can write files and shell out, and is subject to the same approval and plan-mode rules as run_terminal. With the sandbox on it runs inside the sandbox, like every other command, and files it writes are brought back after each call.`,

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

    // Asked of the executor rather than of a flag, and refused when it cannot
    // answer. An interpreter running outside the boundary the other commands
    // are confined to is not a boundary at all — `subprocess.run` inside one
    // reaches everything `run_terminal` was just stopped from reaching. Local
    // and sandbox can both host one; anything added later is refused until it
    // says it can. Checked before approval so the user is not asked to confirm
    // something that is not going to run either way.
    if (!currentExecutor().startRepl) {
      return (
        "The repl is not available in the current execution environment, which " +
        "cannot host an interpreter. Use run_terminal for one-off evaluation."
      );
    }

    const { approved } = await requestCodeApproval(code, language);
    if (!approved) {
      return "Code rejected by user. It was not run, and the session is unchanged.";
    }

    // The default is resolved here rather than left to `replSession`, because a
    // timeout that is never named cannot be clamped: passing `undefined` through
    // gave an evaluation the full 120 seconds against a budget with one left.
    // Read after approval, so time spent waiting for a human is not granted to
    // the evaluation that follows it.
    const requestedSeconds = timeout ?? DEFAULT_EVAL_TIMEOUT_SECONDS;
    const budgeted = budgetedTimeout(requestedSeconds);

    let output: string;
    let note: string;
    let started: boolean;
    try {
      ({ output, note, started } = await evaluate(language, code, {
        restart: args.restart === true,
        timeoutSeconds: budgeted.seconds,
        signal,
      }));
    } catch (error) {
      if (error instanceof ReplUnavailableError) throw error;
      // A lost session is returned as a result rather than thrown so the model
      // can rebuild its state and carry on; the message says what was lost.
      const message = error instanceof Error ? error.message : String(error);
      // Which clock ran out matters: told only that its evaluation timed out,
      // the model rebuilds the session and runs it again with a longer one.
      // No standing advice on this path — a lost session is explained by its
      // own message — so anything but a clamped timeout returns the error bare.
      if (message.includes("timed out")) {
        return formatTimeoutError(message, budgeted, "");
      }
      return `Error: ${message}`;
    }

    // Appended after everything below, never folded into the output: it has to
    // survive the empty case, which has a message of its own, and the truncated
    // case, which drops the end of exactly the long result most likely to have
    // written the files the note is about.
    // An evaluation that assigns a variable prints nothing, which is a success
    // and has to read as one — an empty result looks like a tool that failed.
    if (output === "") {
      const body = started
        ? `Started a ${language} session. The code ran and produced no output.`
        : "The code ran and produced no output.";
      return `${body}${note}`;
    }

    if (output.length > MAX_REPL_OUTPUT) {
      return (
        `${output.slice(0, MAX_REPL_OUTPUT)}\n\n` +
        `... Output truncated: showing the first ${MAX_REPL_OUTPUT} of ${output.length} characters. ` +
        `The session still holds the full result — print a slice or a summary of it instead.` +
        note
      );
    }

    return `${output}${note}`;
  },
};
