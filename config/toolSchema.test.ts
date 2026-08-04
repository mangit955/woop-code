import { describe, test, expect } from "bun:test";
import { parameterSchema, toolInputSchema } from "./toolSchema";
import type { Tool, ToolParameter } from "./types";
import { toolRegistery } from "../tools";

const parameter = (overrides: Partial<ToolParameter>): ToolParameter => ({
  name: "value",
  description: "a value",
  required: false,
  ...overrides,
});

describe("parameterSchema", () => {
  test("defaults an unstated type to string", () => {
    expect(parameterSchema(parameter({}))).toEqual({
      type: "string",
      description: "a value",
    });
  });

  test.each(["number", "boolean"] as const)("passes %s through", (type) => {
    expect(parameterSchema(parameter({ type })).type).toBe(type);
  });

  test("an array without item properties still holds strings", () => {
    // The behaviour every array parameter had before objects were expressible.
    // ask_user relies on it, and JSON Schema requires the item type be stated.
    expect(parameterSchema(parameter({ type: "array" }))).toEqual({
      type: "array",
      description: "a value",
      items: { type: "string" },
    });
  });

  test("an array with item properties holds objects", () => {
    const schema = parameterSchema(
      parameter({
        type: "array",
        items: [
          { name: "content", description: "the step", required: true },
          {
            name: "status",
            description: "how far along",
            required: true,
            enum: ["pending", "completed"],
          },
          { name: "weight", description: "how big", type: "number" },
        ],
      }),
    );

    expect(schema.items).toEqual({
      type: "object",
      properties: {
        content: { type: "string", description: "the step" },
        status: {
          type: "string",
          description: "how far along",
          enum: ["pending", "completed"],
        },
        weight: { type: "number", description: "how big" },
      },
      required: ["content", "status"],
    });
  });

  test("an enum survives, because it is what the provider enforces", () => {
    const schema = parameterSchema(
      parameter({
        type: "array",
        items: [{ name: "status", description: "s", required: true, enum: ["a", "b"] }],
      }),
    );

    expect(schema.items?.properties?.status?.enum).toEqual(["a", "b"]);
  });
});

describe("toolInputSchema", () => {
  const tool: Tool = {
    name: "example",
    description: "an example",
    parameters: [
      parameter({ name: "path", required: true }),
      parameter({ name: "lines", type: "number" }),
    ],
    async execute() {
      return "";
    },
  };

  test("lists the properties and only the required names", () => {
    expect(toolInputSchema(tool)).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "a value" },
        lines: { type: "number", description: "a value" },
      },
      required: ["path"],
    });
  });

  test("a tool with no parameters gets an empty object schema", () => {
    // list_files is called with no arguments, and a provider rejects a schema
    // whose `properties` is missing rather than empty.
    const schema = toolInputSchema({ ...tool, parameters: [] });

    expect(schema.properties).toEqual({});
    expect(schema.required).toEqual([]);
  });

  test("every registered tool produces a usable schema", () => {
    for (const registered of toolRegistery) {
      const schema = toolInputSchema(registered);

      expect(schema.type).toBe("object");
      // An array parameter that never says what it holds is the bug this file
      // exists to prevent: both providers reject it.
      for (const property of Object.values(schema.properties)) {
        if (property.type === "array") expect(property.items).toBeDefined();
      }
      for (const name of schema.required) {
        expect(Object.keys(schema.properties)).toContain(name);
      }
    }
  });

  test("todo_write asks for objects with a constrained status", () => {
    const todo = toolRegistery.find((entry) => entry.name === "todo_write");
    expect(todo).toBeDefined();

    const items = toolInputSchema(todo!).properties.todos?.items;

    expect(items?.type).toBe("object");
    expect(items?.properties?.status?.enum).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(items?.required).toEqual(["content", "status"]);
  });
});
