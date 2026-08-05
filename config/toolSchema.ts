/**
 * One description of a tool's arguments, for every provider.
 *
 * Both clients built this themselves — `providers/client.ts` into Gemini's `Type`
 * enum, `providers/anthropicClient.ts` into JSON Schema strings — from the same
 * `ToolParameter` list, and each carried its own copy of the rule that an array
 * holds strings. Two copies of one mapping is how the second goes stale, and it
 * did: neither could express an array of objects, so `todo_write` had nowhere to
 * put a status per item.
 *
 * This emits provider-neutral JSON Schema. Anthropic takes it as it stands;
 * Gemini's client walks it and swaps the type names for its enum. Being a pure
 * function of the registry, it is tested directly rather than through a request.
 */

import type { Tool, ToolParameter } from "./types";

export type JsonSchemaType = "string" | "number" | "boolean" | "array" | "object";

export interface JsonSchema {
  type: JsonSchemaType;
  description?: string;
  /** Allowed values. The provider rejects anything else before we see it. */
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
}

/** The schema for one parameter. */
export function parameterSchema(parameter: ToolParameter): JsonSchema {
  const type: JsonSchemaType = parameter.type ?? "string";
  const schema: JsonSchema = { type, description: parameter.description };

  // Emitted for any type, including array, where it constrains the array's own
  // value rather than its elements — the element case is `items[].enum` below.
  if (parameter.enum) schema.enum = parameter.enum;

  if (type !== "array") return schema;

  // An array has to state what it holds. Objects when the parameter describes
  // their properties, and otherwise strings — which is what every array
  // parameter was before this file existed, so the default preserves them.
  schema.items = parameter.items
    ? {
        type: "object",
        properties: Object.fromEntries(
          parameter.items.map((property) => [
            property.name,
            {
              type: property.type ?? "string",
              description: property.description,
              ...(property.enum ? { enum: property.enum } : {}),
            } satisfies JsonSchema,
          ]),
        ),
        required: parameter.items
          .filter((property) => property.required)
          .map((property) => property.name),
      }
    : { type: "string" };

  return schema;
}

/** The schema for a whole tool's arguments. */
export function toolInputSchema(tool: Tool): ToolInputSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      tool.parameters.map((parameter) => [parameter.name, parameterSchema(parameter)]),
    ),
    required: tool.parameters
      .filter((parameter) => parameter.required)
      .map((parameter) => parameter.name),
  };
}
