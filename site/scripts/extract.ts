/**
 * Pulls the documented surface out of the code that owns it.
 *
 * Tool names, their parameters, the slash commands, the approval modes and
 * their descriptions all exist already — in `toolRegistery`, in the slash
 * `registry`, in `APPROVAL_MODES`. Writing them out a second time in markdown
 * means maintaining two copies of the same list, and the second copy is the one
 * that goes stale. README.md already says "13 tools" as hand-written prose;
 * that number is only correct until someone adds a tool.
 *
 *   bun run docs:extract          # writes site/src/docs/surface.json
 *   bun run docs:extract --check  # exits non-zero if the file is out of date
 *
 * The docs read the JSON. Nothing in `docs/` states a count, a parameter, or a
 * command name in prose.
 */

import { toolRegistery } from "../../tools";
import { registry, registerCommands } from "../../commands/slash";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from "../../runtime/approval/approval-mode";
import { VERSION } from "../../config/version";

/**
 * Which tools change the workspace, and which merely read it. The registry does
 * not carry this — approval is enforced in the tool implementations and in the
 * approval policy, not declared as tool metadata — so it is stated here, in one
 * place, rather than repeated in prose on every page.
 *
 * Keyed by tool name so an added tool shows up as `unclassified` in the output
 * instead of being silently documented as safe.
 */
const EFFECT: Record<string, "read" | "write" | "shell" | "ask"> = {
  list_files: "read",
  read_file: "read",
  grep: "read",
  glob: "read",
  find_files: "read",
  web_search: "read",
  web_fetch: "read",
  create_file: "write",
  write_file: "write",
  edit_file: "write",
  run_terminal: "shell",
  run_tests: "shell",
  ask_user: "ask",
};

/** How each effect class is gated. One sentence, reused wherever it is shown. */
const GATE: Record<string, string> = {
  read: "Runs without asking. Reads only; never changes the workspace.",
  write: "Pauses on a unified diff. Nothing is written until you approve it.",
  shell: "Gated by the approval mode.",
  ask: "Stops the turn and waits for your answer.",
  unclassified: "Not yet classified — see site/scripts/extract.ts.",
};

registerCommands();

const tools = toolRegistery.map((tool) => {
  const effect = EFFECT[tool.name] ?? "unclassified";

  return {
    name: tool.name,
    description: tool.description,
    effect,
    gate: GATE[effect],
    parameters: tool.parameters.map((parameter) => ({
      name: parameter.name,
      // The registry leaves `type` optional; every provider-facing parameter is
      // a string unless it says otherwise, which is what the schema builder
      // assumes too.
      type: parameter.type ?? "string",
      required: parameter.required,
      description: parameter.description,
    })),
  };
});

const commands = registry.getAll().map((command) => ({
  name: command.name,
  aliases: command.aliases ?? [],
  category: command.category,
  description: command.description,
  usage: command.usage ?? `/${command.name}`,
}));

const approvalModes = APPROVAL_MODES.map((mode) => ({
  mode: mode.mode,
  label: mode.label,
  description: mode.description,
  unsafe: mode.unsafe,
  default: mode.mode === DEFAULT_APPROVAL_MODE,
}));

const surface = {
  // Generated, not authored. Regenerate with `bun run docs:extract`.
  version: VERSION,
  counts: {
    tools: tools.length,
    commands: commands.length,
    approvalModes: approvalModes.length,
  },
  tools,
  commands,
  approvalModes,
};

const serialised = JSON.stringify(surface, null, 2) + "\n";
const target = new URL("../src/docs/surface.json", import.meta.url);

// `--check` is for CI: it fails when the code has moved and the docs data has
// not, which is the failure this whole file exists to prevent.
if (process.argv.includes("--check")) {
  const existing = await Bun.file(target).text().catch(() => null);

  if (existing !== serialised) {
    console.error(
      "site/src/docs/surface.json is out of date. Run: bun run docs:extract",
    );
    process.exit(1);
  }

  console.log("surface.json is up to date.");
} else {
  await Bun.write(target, serialised);

  const unclassified = tools.filter((tool) => tool.effect === "unclassified");

  console.log(
    `woopcode ${VERSION} → ${tools.length} tools, ${commands.length} slash commands, ` +
      `${approvalModes.length} approval modes`,
  );

  if (unclassified.length > 0) {
    console.warn(
      `\n${unclassified.length} unclassified tool(s): ${unclassified
        .map((tool) => tool.name)
        .join(", ")}\nAdd them to EFFECT in site/scripts/extract.ts.`,
    );
  }
}
