import { describe, test, expect } from "bun:test";
import type { Tool } from "../../../config/types";
import { toolRegistery } from "../../../tools";
import { toolEffect } from "../../../runtime/toolEffects";
import { readFileTool } from "../../../tools/readFile";
import { listFilesTool } from "../../../tools/listFiles";
import { join } from "node:path";
import { rmSync } from "node:fs";

/**
 * Tool Contract Tests
 * 
 * Every Tool implementation must satisfy this contract.
 * This ensures tools are properly integrated with the runtime.
 * 
 * Tests verify:
 * - Tool interface compliance
 * - Name, description, parameters defined
 * - Execute returns string result
 * - Execute accepts Record<string, unknown> arguments
 * - Errors are thrown with descriptive messages
 */

/**
 * Runs the complete contract test suite against a tool
 */
export function testToolContract(toolName: string, tool: Tool) {
  describe(`Tool Contract: ${toolName}`, () => {
    test("has required name property", () => {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    });

    test("has required description property", () => {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    });

    test("has required parameters property", () => {
      expect(tool.parameters).toBeDefined();
      expect(Array.isArray(tool.parameters)).toBe(true);
    });

    test("parameters have valid structure", () => {
      for (const param of tool.parameters) {
        expect(param.name).toBeDefined();
        expect(typeof param.name).toBe("string");
        expect(param.description).toBeDefined();
        expect(typeof param.description).toBe("string");
        expect(typeof param.required).toBe("boolean");
      }
    });

    test("has execute method", () => {
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    test("execute takes arguments, and at most an abort signal besides", () => {
      // The signature is execute(args, signal), and the signal is optional: a
      // tool with nothing to interrupt declares one parameter, a tool that
      // passes it to a fetch or a subprocess declares two. Pinning this to
      // exactly one would fail every tool that honours cancellation, which is
      // the behaviour the runtime asks for. The shape of `args` itself is tsc's
      // job, not an arity check's.
      expect(tool.execute.length).toBeGreaterThanOrEqual(1);
      expect(tool.execute.length).toBeLessThanOrEqual(2);
    });

    test("execute rejects missing required arguments before doing any work", async () => {
      const required = tool.parameters.filter((parameter) => parameter.required);

      if (required.length === 0) {
        // Nothing is required, so an empty call is a legitimate invocation
        // rather than an error — but only a reading tool can be invoked to
        // prove it. Calling run_tests with no arguments defaults to `bun test`
        // and blocks on an approval prompt no test can answer, having already
        // spawned the suite inside itself; a shell or writing tool belongs to
        // its own integration test, where the approval prompt is faked.
        // Reading the effect from TOOL_EFFECTS rather than from the tool name
        // means an unclassified new tool is left alone too, which is the same
        // direction everything else here fails in.
        if (toolEffect(tool.name) === "read") {
          expect(typeof (await tool.execute({}))).toBe("string");
        }
        return;
      }

      // A tool with a required parameter must refuse an empty call, and refuse
      // it before it touches the network, the filesystem or the approval store.
      // The message is what the model reads and corrects itself from, so an
      // empty one fails the contract as surely as no error at all.
      let thrown: unknown;
      try {
        await tool.execute({});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message.length).toBeGreaterThan(0);
    });
  });
}

// Every registered tool, not a hand-kept list of two.
//
// The list was `read_file` and `list_files`, and the other eleven entries in the
// registry were covered only by the shallow sweep below — unique names, non-empty
// descriptions. A tool could ship with an unvalidated required parameter or a
// signature the runtime cannot call and pass CI, while packages/tests/README.md
// said contracts were "applied to every implementation". Driving this off the
// registry is what makes that sentence true, and means a new tool inherits the
// contract by being registered rather than by someone remembering this file.
for (const tool of toolRegistery) {
  testToolContract(tool.name, tool);
}

// Behaviour, rather than shape: these assert what a particular tool does, so
// they stay named.
describe("Real Tool Contract Compliance", () => {
  test("readFileTool - validates required path parameter", async () => {
    await expect(readFileTool.execute({})).rejects.toThrow(
      "File path is required",
    );
  });

  test("readFileTool - returns string on success", async () => {
    // Create a temp file for testing
    const tempPath = join(process.cwd(), `.tool-contract-${Date.now()}.txt`);
    await Bun.write(tempPath, "test content");

    try {
      const result = await readFileTool.execute({ path: tempPath });
      expect(typeof result).toBe("string");
      expect(result).toBe("test content");
    } finally {
      // Cleanup
      rmSync(tempPath, { force: true });
    }
  });

  test("readFileTool - throws error for non-existent file", async () => {
    const nonExistentPath = join(process.cwd(), `.nonexistent-${Date.now()}.txt`);
    
    await expect(readFileTool.execute({ path: nonExistentPath })).rejects.toThrow(
      "does not exist",
    );
  });

  test("listFilesTool - returns string result", async () => {
    const result = await listFilesTool.execute({ path: process.cwd() });
    expect(typeof result).toBe("string");
  });

  test("listFilesTool - handles missing path parameter", async () => {
    // listFilesTool may have default behavior for missing path
    const result = await listFilesTool.execute({});
    expect(typeof result).toBe("string");
  });

  test("tool parameters match expected structure", () => {
    const readFileParams = readFileTool.parameters;
    expect(readFileParams.length).toBeGreaterThan(0);
    
    const pathParam = readFileParams.find(p => p.name === "path");
    expect(pathParam).toBeDefined();
    expect(pathParam?.required).toBe(true);
  });
});

/**
 * Tool Registry Contract Tests
 * 
 * Verifies that the tool registry maintains contract guarantees:
 * - Unique tool names
 * - Tools can be retrieved
 * - All registered tools satisfy the Tool interface
 */
describe("Tool Registry Contract", () => {
  test("all registered tools have unique names", async () => {
    const { toolRegistery } = await import("../../../tools");
    
    const names = toolRegistery.map(t => t.name);
    const uniqueNames = new Set(names);
    
    expect(uniqueNames.size).toBe(names.length);
  });

  test("all registered tools satisfy Tool interface", async () => {
    const { toolRegistery } = await import("../../../tools");
    
    for (const tool of toolRegistery) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("registry resolver returns undefined for an unknown tool", async () => {
    const { resolveTool } = await import("../../../tools");
    
    const unknown = resolveTool("unknown_tool_name");
    expect(unknown).toBeUndefined();
  });

  test("list file aliases resolve to the canonical tool", async () => {
    const { resolveTool } = await import("../../../tools");

    const canonicalTool = resolveTool("list_files");
    expect(canonicalTool?.name).toBe("list_files");
    expect(resolveTool("list_file")).toBe(canonicalTool);
    expect(resolveTool("list_Files")).toBe(canonicalTool);
  });

  test("all tools have non-empty descriptions", async () => {
    const { toolRegistery } = await import("../../../tools");
    
    for (const tool of toolRegistery) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("all tools have valid parameter definitions", async () => {
    const { toolRegistery } = await import("../../../tools");
    
    for (const tool of toolRegistery) {
      expect(Array.isArray(tool.parameters)).toBe(true);
      
      for (const param of tool.parameters) {
        expect(typeof param.name).toBe("string");
        expect(typeof param.description).toBe("string");
        expect(typeof param.required).toBe("boolean");
      }
    }
  });
});
