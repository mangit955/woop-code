/**
 * `woopcode sessions` — the session store from outside a session.
 *
 * The picker covers the interactive case. This is for the rest: seeing what is
 * on disk before starting, reading a transcript without resuming it, and
 * running retention on demand rather than waiting for the daily sweep.
 */

import { Command } from "commander";
import {
  latestSession,
  listSessions,
  loadSession,
  pruneSessions,
  resolveSessionRef,
  UNTITLED,
  type SessionSummary,
} from "../config/sessions";
import { getConfig, parseRetentionDays } from "../config/config";
import { relativeTime } from "../tui/src/relative-time";
import { renderTable } from "./table";

function label(session: SessionSummary): string {
  return session.name ?? session.title ?? UNTITLED;
}

const listCommand = new Command("list")
  .description("List saved sessions")
  .option("-a, --all", "every project on this machine, not just this one")
  .action(async (options: { all?: boolean }) => {
    const sessions = await listSessions({ scope: options.all ? "all" : "project" });

    if (sessions.length === 0) {
      process.stdout.write(
        options.all
          ? "No saved sessions.\n"
          : "No saved sessions in this project. Try --all.\n",
      );
      return;
    }

    const current = await latestSession();

    process.stdout.write(
      renderTable(sessions, [
        { header: "", value: (session) => (session.id === current?.id ? "●" : " ") },
        { header: "ID", value: (session) => session.id.slice(0, 8) },
        { header: "SESSION", value: label },
        { header: "MSGS", value: (session) => `${session.messageCount}`, align: "right" },
        { header: "UPDATED", value: (session) => relativeTime(session.updated) },
        { header: "BRANCH", value: (session) => session.branch ?? "—" },
      ]) + "\n",
    );
  });

const showCommand = new Command("show")
  .description("Print a session's transcript")
  .argument("<session>", "name, id or id prefix")
  .action(async (ref: string) => {
    const sessions = await listSessions({ scope: "all" });
    const resolution = resolveSessionRef(ref, sessions);

    if (resolution.status === "none") {
      process.stderr.write(`✖ No session found matching "${ref}"\n`);
      process.exit(1);
    }
    if (resolution.status === "ambiguous") {
      process.stderr.write(
        `✖ "${ref}" matches ${resolution.matches.length} sessions:\n` +
          resolution.matches
            .map((session) => `   ${session.id.slice(0, 8)}  ${label(session)}\n`)
            .join("") +
          "  Use a longer id.\n",
      );
      process.exit(1);
    }

    const record = await loadSession(resolution.session.id, resolution.session.slug);
    if (!record) {
      process.stderr.write(`✖ Could not read session ${resolution.session.id}\n`);
      process.exit(1);
    }

    process.stdout.write(
      `${label(resolution.session)}  (${record.id})\n` +
        `${record.cwd ?? "no project"}${record.branch ? ` · ${record.branch}` : ""}\n\n`,
    );

    // Only user and assistant messages are ever persisted, but the Message
    // union is wider than that, so narrow rather than assume.
    for (const message of record.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const who = message.role === "user" ? "you" : "woopcode";
      process.stdout.write(`── ${who} ──\n${message.content}\n\n`);
    }
  });

const pruneCommand = new Command("prune")
  .description("Delete sessions older than the retention period")
  .option("--days <days>", "override the configured retention period")
  .action(async (options: { days?: string }) => {
    const configured = parseRetentionDays((await getConfig()).retentionDays);

    // A value that is not a number is a typo, and reporting it as "retention is
    // off" would describe the configuration rather than the mistake.
    if (options.days !== undefined && !Number.isFinite(Number(options.days))) {
      process.stderr.write(`✖ --days needs a number, not "${options.days}"\n`);
      process.exit(1);
    }

    const days = options.days !== undefined ? Number(options.days) : configured;

    if (days <= 0) {
      process.stdout.write(
        "Retention is off, so nothing was removed. Pass --days to override.\n",
      );
      return;
    }

    const removed = await pruneSessions(days);
    process.stdout.write(
      removed === 0
        ? `No sessions older than ${days} days.\n`
        : `Removed ${removed} session${removed === 1 ? "" : "s"} older than ${days} days.\n`,
    );
  });

export const sessionsCommand = new Command("sessions")
  .description("List, inspect and prune saved sessions")
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(pruneCommand)
  // A bare `woopcode sessions` is a listing, which is what anyone typing it
  // wants; the subcommands are for the less common cases.
  .action(async () => {
    await listCommand.parseAsync([], { from: "user" });
  });
