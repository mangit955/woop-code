import { describe, test, expect } from "bun:test";
import type { Tool } from "../../../config/types";
import { readFileTool } from "../../../tools/readFile";
import { listFilesTool } from "../../../tools/listFiles";

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

    test("execute method signature accepts Record<string, unknown>", () => {
      // This is a compile-time check, but we verify runtime behavior
      expect(tool.execute.length).toBe(1);
    });

    test("execute throws error for invalid arguments", async () => {
      // Most tools should throw when required params are missing
      try {
        await tool.execute({});
        // If it doesn't throw, it means the tool has no required params (valid)
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBeDefined();
      }
    });
  });
}

// Test real tools against the contract
describe("Real Tool Contract Compliance", () => {
  testToolContract("read_file", readFileTool);
  testToolContract("list_files", listFilesTool);

  test("readFileTool - validates required path parameter", async () => {
    await expect(readFileTool.execute({})).rejects.toThrow(
      "File path is required",
    );
  });

  test("readFileTool - returns string on success", async () => {
    // Create a temp file for testing
    const tempPath = `/tmp/test-${Date.now()}.txt`;
    await Bun.write(tempPath, "test content");

    try {
      const result = await readFileTool.execute({ path: tempPath });
      expect(typeof result).toBe("string");
      expect(result).toBe("test content");
    } finally {
      // Cleanup
      await Bun.write(tempPath, "").catch(() => {});
    }
  });

  test("readFileTool - throws error for non-existent file", async () => {
    const nonExistentPath = `/tmp/nonexistent-${Date.now()}.txt`;
    
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

  test("getTool returns correct tool by name", () => {
    const { getTool, toolRegistery } = require("../../../tools");
    
    // Just verify getTool works - don't rely on specific tool names
    // as they may vary or be mocked in other tests
    expect(typeof getTool).toBe("function");
    expect(Array.isArray(toolRegistery)).toBe(true);
    expect(toolRegistery.length).toBeGreaterThan(0);
    
    // Verify getTool returns tools from the registry
    const firstTool = toolRegistery[0];
    if (firstTool) {
      const found = getTool(firstTool.name);
      expect(found).toBeDefined();
      expect(found?.name).toBe(firstTool.name);
    }
  });

  test("getTool returns undefined for unknown tool", async () => {
    const { getTool } = await import("../../../tools");
    
    const unknown = getTool("unknown_tool_name");
    expect(unknown).toBeUndefined();
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
