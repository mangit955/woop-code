import { TODO_STATUSES, type TodoItem, type TodoStatus, type Tool } from "../config/types";
import { store } from "../tui/src/store/ui-store";

/**
 * Steps kept at once. A list longer than this is a plan that should have been
 * broken up, and it stops fitting on screen beside the transcript.
 */
const MAX_TODOS = 20;

/** Characters of a single step that are kept. */
const MAX_CONTENT = 120;

export const todoWriteTool: Tool = {
  name: "todo_write",
  description: `Records the task list for the work in progress, so the user can see what is done and what is left.

Send the complete list every time — it replaces the previous one rather than adding to it. Keep exactly one item in_progress, and mark an item completed as soon as it is finished rather than in a batch at the end.

Use it for work with several distinct steps, and for a plan the user has just approved. Skip it for a single-step change or a question: a one-item list tells the user nothing they did not already know.

This records intent only. It changes no files and runs nothing, so it is available while planning.`,

  parameters: [
    {
      name: "todos",
      description:
        "The complete task list, in the order the steps will be done. Replaces the previous list.",
      required: true,
      type: "array",
      items: [
        {
          name: "content",
          description:
            "The step, as a short imperative phrase — e.g. 'Gate writes in the agent loop'.",
          required: true,
        },
        {
          name: "status",
          description:
            "pending for not started, in_progress for the one being worked on now, completed when done.",
          required: true,
          enum: [...TODO_STATUSES],
        },
      ],
    },
  ],

  async execute(args) {
    const todos = parseTodos(args.todos);

    store.setTodos(todos);

    // Echoed back so the model sees the list as recorded rather than assuming
    // the write landed as sent, and so the next turn can read its own state out
    // of the transcript.
    const counts = summarize(todos);
    return `Task list updated (${counts}):\n${todos.map(render).join("\n")}`;
  },
};

/**
 * Validates before touching the store, so a bad call changes nothing.
 *
 * Every message here is read by the model and is what it corrects itself from,
 * so each one names what was wrong and what is accepted instead.
 */
function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw Error(
      "todos must be an array of objects, each with a content string and a status of " +
        `${TODO_STATUSES.join(", ")}.`,
    );
  }

  if (value.length === 0) {
    throw Error(
      "todos is empty. Send the whole list, or omit todo_write entirely if there is nothing to track.",
    );
  }

  if (value.length > MAX_TODOS) {
    throw Error(
      `todos has ${value.length} items, which is more than the ${MAX_TODOS} allowed. ` +
        "Group the smaller steps together.",
    );
  }

  const todos = value.map((entry, index) => {
    const position = index + 1;

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw Error(
        `todos[${index}] must be an object with content and status, got ${typeof entry}.`,
      );
    }

    const { content, status } = entry as Record<string, unknown>;

    if (typeof content !== "string" || content.trim() === "") {
      throw Error(`todos[${index}] needs a non-empty content string (item ${position}).`);
    }

    if (typeof status !== "string" || !isTodoStatus(status)) {
      throw Error(
        `todos[${index}] has status ${JSON.stringify(status)}, which is not one of ` +
          `${TODO_STATUSES.join(", ")}.`,
      );
    }

    return {
      content: content.trim().slice(0, MAX_CONTENT),
      status,
    } satisfies TodoItem;
  });

  // "Exactly one in_progress" is asked for in the description but not enforced
  // here: refusing the whole list over it would lose the update, and a list with
  // two items in flight is visibly that in the rendering. Only malformed input
  // is an error.
  return todos;
}

function isTodoStatus(value: string): value is TodoStatus {
  return (TODO_STATUSES as readonly string[]).includes(value);
}

const GLYPHS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

function render(todo: TodoItem): string {
  return `${GLYPHS[todo.status]} ${todo.content}`;
}

function summarize(todos: TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return `${done}/${todos.length} complete`;
}
