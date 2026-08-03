---
title: read_file
type: reference
summary: Reads the contents of a file inside the workspace.
prerequisites: []
related:
  - /docs/reference/tools
  - /docs/reference/tools/list-files
  - /docs/guides/approval-modes
since: 0.6.0
---

# `read_file`

{{tool:read_file:description}} Read-only: it never changes the workspace and
never asks for approval.

## Parameters

{{tool:read_file:params}}

## Example

```ts
read_file({ path: "src/auth/login.ts" })
```

Returns the file's contents as text, exactly as stored — no header, no line
numbers — so the result can be copied straight into `edit_file`'s `oldText`.

```ts
read_file({ path: "src/auth/login.ts", startLine: 40, endLine: 80 })
```

Returns only those lines, preceded by a header naming the range:

```terminal
Lines 40-80 of 512 in src/auth/login.ts:
```

Both bounds are 1-indexed and inclusive, matching how `grep`, compiler errors
and stack traces report positions. Either may be omitted: `startLine` alone
reads to the end of the file, `endLine` alone reads from the start.

## Behaviour

| Property | Detail |
| --- | --- |
| Approval | {{tool:read_file:gate}} |
| Path resolution | Resolved against the workspace root, symlinks included |
| Output limit | 16 KB, then truncated with a notice |
| Line numbering | 1-indexed, inclusive at both ends |
| Encoding | Read as UTF-8 text |

Paths may be relative or absolute, but must resolve inside the directory
Woopcode was launched from.

Files over 16 KB are cut at the limit and the tool appends:

```terminal
... File truncated: showing the first 16384 of 48291 characters
(1204 lines total). Read a specific range with startLine and endLine
to see the rest.
```

The cut is taken from the start of the file, so the end of a large file is only
reachable by asking for a range. The notice reports the total line count for
that reason. `grep` remains the cheaper way to locate a position first.

## Errors

| Message | Cause |
| --- | --- |
| `File path is required` | Called with no `path` |
| `File <path> does not exist` | Nothing at that path |
| `Cannot read <path>: it is a directory. Use list_files to see directory contents.` | The path is a directory |
| `startLine must be a whole number of 1 or more, got <value>` | A line bound that is zero, negative or fractional |
| `endLine (<n>) must not be before startLine (<n>)` | The range runs backwards |
| `startLine <n> is past the end of <path>, which has <n> lines` | The range begins after the last line |
| `Path escapes the workspace: <path>` | The path resolves outside the workspace root |

Errors are returned to the agent rather than ending the turn, so it can correct
the path and try again.

## See also

- [Tools](/docs/reference/tools) — every tool and what each one can change,
  including `list_files` for directory contents and `grep` for searching inside
  files without reading them whole
- [Approval modes](/docs/guides/approval-modes) — what gates the tools that do
  change things
