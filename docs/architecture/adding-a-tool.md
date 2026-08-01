---
title: Adding a tool
type: guide
summary: Write a tool, register it, classify its effect, and let the docs pick it up.
prerequisites:
  - /docs/architecture/running-from-source
related:
  - /docs/reference/tools
  - /docs/guides/approval-modes
since: 0.6.0
---

# Adding a tool

A tool is an object with a name, a description, a parameter list, and an
`execute` function. Everything else — schema generation, dispatch, error
handling, the docs — follows from registering it.

## The shape

```ts
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface ToolParameter {
  name: string;
  description: string;
  required: boolean;
  type?: "string" | "number" | "array";
}
```

`execute` returns a string. That string is what the model sees, so it is part
of the interface, not a log line.

## Write it

```ts title="tools/countLines.ts"
import type { Tool } from "../config/types";
import { resolveWorkspacePath } from "./workspace";

export const countLinesTool: Tool = {
  name: "count_lines",
  description: "Counts the lines in a file.",
  parameters: [
    { name: "path", description: "Path to the file", required: true },
  ],

  async execute(args) {
    const requested = args.path as string;
    if (!requested) throw Error("File path is required");

    // Never join paths by hand. This resolves symlinks before checking
    // containment, which is what stops a link being used to escape.
    const path = await resolveWorkspacePath(requested, { mustExist: true });
    const text = await Bun.file(path).text();

    return `${text.split("\n").length} lines`;
  },
};
```

## Register it

```ts title="tools/index.ts"
export const toolRegistery: Tool[] = [
  // ...
  countLinesTool,
];
```

That is the whole wiring. The registry is what the provider schema, the
dispatcher, and the docs all read.

## Classify its effect

The registry does not record whether a tool writes — approval is enforced in
the tool and in the policy, not declared as metadata. The docs need to know, so
there is one table:

```ts title="site/scripts/extract.ts"
const EFFECT: Record<string, "read" | "write" | "shell" | "ask"> = {
  // ...
  count_lines: "read",
};
```

A tool missing from that table shows up as `unclassified` and
`bun run docs:extract` warns about it — it is not silently documented as safe.

## Regenerate the docs data

```bash
bun run docs:extract
```

Commit the updated `site/src/docs/surface.json`. Nothing in `docs/` states a
tool name, parameter, or count in prose, so the tools page, the counts, and the
tables all pick up your tool with no page edits. `bun run docs:check` fails if
you forget.

## Rules worth following

**Throw for bad input.** Errors are returned to the agent as results, so it can
correct a path and retry. Write the message for the model: `File <path> does
not exist` is actionable, `ENOENT` is not.

**Use `resolveWorkspacePath` for every path.** It is the workspace boundary.

**Bound your output.** Tool results are truncated at 4,000 characters before
reaching the model. Truncate deliberately, with a notice, rather than being cut
mid-structure — `read_file` is the example to copy.

**Respect the signal.** Long-running work should check the `AbortSignal` so
<kbd>Ctrl</kbd><kbd>C</kbd> stops it.

**Keep the description short and literal.** It is prompt text, and the model
chooses tools from it.

:::warning
A tool that writes must raise an approval request rather than writing directly.
Copy `tools/editFile.ts`. A tool that quietly writes bypasses the diff review,
which is the guarantee the whole product rests on.
:::

## Test it

```bash
bun test
```

Tool tests live in `packages/tests/tools/`. Cover the happy path, a missing
required argument, and a path outside the workspace.

## Next

- [How it works](/docs/architecture/how-it-works)
- [Tools](/docs/reference/tools)
