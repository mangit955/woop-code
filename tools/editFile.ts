import type { Tool } from "../config/types";
import { createTwoFilesPatch } from "diff";
import { store } from "../tui/src/store/ui-store";
import type { PendingEdit } from "../tui/src/types";
import { applyEdit, describeAmbiguity } from "./textEdit";
import { resolveWorkspacePath } from "./workspace";

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace text inside an existing file. oldText must match exactly one place in the file, " +
    "or the edit is refused so the wrong occurrence is never changed.",

  parameters: [
    {
      name: "path",
      description: "File path",
      required: true,
    },
    {
      name: "oldText",
      description:
        "Exact current text to replace, copied verbatim from read_file output. Include enough " +
        "surrounding lines to match exactly one place in the file.",
      required: true,
    },
    {
      name: "newText",
      description: "Exact replacement text. Inserted literally; no substitution patterns are expanded.",
      required: true,
    },
    {
      name: "replaceAll",
      description:
        "Set to true only to deliberately change every non-overlapping occurrence, such as a rename. " +
        "Omit it otherwise; omitting means the single unique occurrence.",
      required: false,
      type: "boolean",
    },
  ],

  async execute(args) {
    const requestedPath = args.path as string;
    const oldText = args.oldText as string;
    const newText = args.newText as string;

    // Checked by type, not by truthiness: "" is a legitimate newText — it is
    // how a deletion is expressed — and the same distinction create_file draws
    // for an empty file. An omitted one used to reach applyEdit, which builds
    // the result with join(""), and join renders undefined as empty: the match
    // was deleted and the tool reported success.
    if (typeof oldText !== "string") {
      throw new Error("Missing required argument: oldText");
    }
    if (typeof newText !== "string") {
      throw new Error("Missing required argument: newText");
    }

    let path: string;
    try {
      path = await resolveWorkspacePath(requestedPath, { mustExist: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${requestedPath}`);
      }
      throw error;
    }
    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`);
    }

    const content = await file.text();

    const outcome = applyEdit(content, oldText, newText, {
      // Absent and `false` mean the same thing: the caller did not ask for every
      // occurrence. Only an explicit yes counts as one.
      ...(args.replaceAll === true || args.replaceAll === "true"
        ? { replaceAll: true as const }
        : {}),
    });

    switch (outcome.kind) {
      case "empty-pattern":
        throw new Error(
          "oldText must not be empty. Provide the exact text to replace, copied from read_file.",
        );
      case "not-found":
        throw new Error(
          `Text to replace not found in ${path}. Read the file again and copy oldText verbatim, ` +
            "including its indentation.",
        );
      case "ambiguous":
        throw new Error(describeAmbiguity(outcome.occurrences, path));
    }

    const updated = outcome.content;

    // If content is identical, skip diff preview
    if (content === updated) {
      return `No changes needed for ${path}`;
    }

    const diff = createTwoFilesPatch(path, path, content, updated, "", "", {
      context: 3,
    });

    const pendingEdit: PendingEdit = {
      id: crypto.randomUUID(),
      filePath: path,
      oldContent: content,
      newContent: updated,
      diff,
      toolCallId: crypto.randomUUID(),
    };

    let approved: boolean;
    try {
      approved = await store.setPendingEdit(pendingEdit);
    } catch (error) {
      const message = `Edit cancelled for ${path}. No changes were applied.`;
      store.addSystemMessage(message);
      return message;
    }

    if (!approved) {
      const message = `Edit rejected for ${path}. No changes were applied. Do not claim this edit was completed.`;
      store.addSystemMessage(message);
      return message;
    }

    // The only write in this tool, and it sits below both exits above. Nothing
    // may move above them: the diff review is the product's whole guarantee.
    await Bun.write(path, updated);

    return outcome.replacements > 1
      ? `Edited ${path} (${outcome.replacements} occurrences replaced)`
      : `Edited ${path}`;
  },
};
