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

```text
read_file(path: "src/auth/login.ts")
```

Returns the file's contents as text.

## Behaviour

| Property | Detail |
| --- | --- |
| Approval | {{tool:read_file:gate}} |
| Path resolution | Resolved against the workspace root, symlinks included |
| Output limit | 16 KB, then truncated with a notice |
| Encoding | Read as UTF-8 text |

Paths may be relative or absolute, but must resolve inside the directory
Woopcode was launched from.

Files over 16 KB are cut at the limit and the tool appends:

```text
... File truncated. Showing first 16384 characters of 48291.
```

The agent sees the truncation notice and can use `grep` to find the part it
needs.

## Errors

| Message | Cause |
| --- | --- |
| `File path is required` | Called with no `path` |
| `File <path> does not exist` | Nothing at that path |
| `Cannot read <path>: it is a directory. Use list_files to see directory contents.` | The path is a directory |
| `Path escapes the workspace: <path>` | The path resolves outside the workspace root |

Errors are returned to the agent rather than ending the turn, so it can correct
the path and try again.

## See also

- [`list_files`](/docs/reference/tools/list-files) — directory contents
- [`grep`](/docs/reference/tools/grep) — search inside files without reading
  them whole
- [Tools overview](/docs/reference/tools) — all {{counts.tools}} tools and what
  each one can change
