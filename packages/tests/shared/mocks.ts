import type { ProviderClient, StreamEvent, Tool } from "../../../config/types";

/**
 * Mock Provider Client for testing
 * Allows controlled streaming of events to test agent loop behavior
 */
export class MockProviderClient implements ProviderClient {
  private events: StreamEvent[] = [];
  private delay = 0;
  private shouldThrow = false;
  private throwError: Error | null = null;

  constructor(events: StreamEvent[] = []) {
    this.events = events;
  }

  setEvents(events: StreamEvent[]) {
    this.events = events;
  }

  setDelay(ms: number) {
    this.delay = ms;
  }

  setThrowError(error: Error) {
    this.shouldThrow = true;
    this.throwError = error;
  }

  async *stream(
    messages: any[],
    repoContext: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    if (this.shouldThrow && this.throwError) {
      throw this.throwError;
    }

    for (const event of this.events) {
      // Check cancellation before each event
      if (signal?.aborted) {
        return;
      }

      if (this.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delay));
      }

      yield event;
    }
  }
}

/**
 * Mock Tool for testing
 * Allows controlled execution results and errors
 */
export class MockTool implements Tool {
  name: string;
  description: string;
  parameters: any[];
  
  private executionResult: string;
  private shouldThrow = false;
  private throwError: Error | null = null;
  private executionDelay = 0;
  public executionCount = 0;
  public lastArgs: Record<string, unknown> | null = null;

  constructor(
    name: string,
    result: string = "Tool executed successfully",
    description: string = "Mock tool",
  ) {
    this.name = name;
    this.description = description;
    this.parameters = [];
    this.executionResult = result;
  }

  setResult(result: string) {
    this.executionResult = result;
  }

  setThrowError(error: Error) {
    this.shouldThrow = true;
    this.throwError = error;
  }

  setDelay(ms: number) {
    this.executionDelay = ms;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    this.executionCount++;
    this.lastArgs = args;

    if (this.executionDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.executionDelay));
    }

    if (this.shouldThrow && this.throwError) {
      throw this.throwError;
    }

    return this.executionResult;
  }

  reset() {
    this.executionCount = 0;
    this.lastArgs = null;
    this.shouldThrow = false;
    this.throwError = null;
  }
}

/**
 * Spy for tracking callback invocations
 */
export class CallbackSpy {
  public calls: Array<{ name: string; args: any[] }> = [];

  onStatus = (status: string) => {
    this.calls.push({ name: "onStatus", args: [status] });
  };

  onText = (text: string) => {
    this.calls.push({ name: "onText", args: [text] });
  };

  onToolStart = (tool: any) => {
    this.calls.push({ name: "onToolStart", args: [tool] });
  };

  onToolFinish = (tool: any) => {
    this.calls.push({ name: "onToolFinish", args: [tool] });
  };

  onDone = () => {
    this.calls.push({ name: "onDone", args: [] });
  };

  onError = (error: Error) => {
    this.calls.push({ name: "onError", args: [error] });
  };

  onCancel = () => {
    this.calls.push({ name: "onCancel", args: [] });
  };

  getCallsByName(name: string) {
    return this.calls.filter((call) => call.name === name);
  }

  wasCalledWith(name: string, ...args: any[]) {
    return this.calls.some(
      (call) =>
        call.name === name &&
        JSON.stringify(call.args) === JSON.stringify(args),
    );
  }

  reset() {
    this.calls = [];
  }
}

/**
 * Mock tool registry for testing
 * Replaces the global tool registry
 */
export class MockToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  clear() {
    this.tools.clear();
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
