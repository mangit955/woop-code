import type { Message } from "../../../config/types";

/**
 * Rebuilds the conversation a recorded run assembled, iteration by iteration.
 *
 * Context changes cannot be evaluated against live benchmark runs: trajectories
 * diverge, and a comparison of two different trajectories measures the
 * divergence rather than the change. One benchmark comparison showed +7% to
 * +31% per-iteration prompt growth that segment analysis then attributed
 * entirely to the agent doing different work.
 *
 * A recorded run removes that variable. The events fix what the model said and
 * what every tool returned, so replaying them exercises assembly against
 * identical inputs every time.
 *
 * What makes this self-validating rather than a restatement of assumptions:
 * each `iteration` event carries the `segments` the runtime actually measured
 * at that point. Those are ground truth. A reconstruction that reproduces them
 * is faithful; one that does not is wrong, and says so.
 */

export interface RunEventRecord {
  type: string;
  [key: string]: unknown;
}

export interface ReplayStep {
  /** 1-based, matching the recorded iteration counter. */
  iteration: number;
  /** The conversation as it stood before this iteration's request. */
  messages: Message[];
  /** The repository context the run was given, recovered from the record. */
  repoContextChars: number;
  /** What the runtime measured at the time — the assertion target. */
  recordedSegments: Record<string, number>;
}

export function parseEvents(text: string): RunEventRecord[] {
  const events: RunEventRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // A run killed at a timeout leaves a truncated final line; the steps
      // before it are still replayable.
    }
  }
  return events;
}

/**
 * Walks a recorded run, yielding the state before each provider request.
 *
 * Event order is fixed by the runtime and verified against real logs: the
 * `iteration` record is written after the stream completes but *before* that
 * iteration's tools run, so the messages it describes are everything up to the
 * previous iteration's results.
 */
export function replaySteps(events: RunEventRecord[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const messages: Message[] = [];
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();

  for (const event of events) {
    switch (event.type) {
      case "run_start":
        messages.push({ role: "user", content: String(event.prompt ?? "") });
        break;

      case "iteration": {
        const segments = (event.segments ?? {}) as Record<string, number>;
        steps.push({
          iteration: Number(event.n),
          // Copied: later events keep appending to the live array.
          messages: messages.map((message) => ({ ...message }) as Message),
          repoContextChars: segments.repoContext ?? 0,
          recordedSegments: segments,
        });
        break;
      }

      case "tool_call":
        pending.set(String(event.id), {
          name: String(event.name),
          args: (event.arguments ?? {}) as Record<string, unknown>,
        });
        messages.push({
          role: "assistant_tool_call",
          toolName: String(event.name),
          toolCallId: String(event.id),
          arguments: (event.arguments ?? {}) as Record<string, unknown>,
        });
        break;

      case "tool_result":
      case "tool_error": {
        const call = pending.get(String(event.id));
        if (!call) break;
        pending.delete(String(event.id));
        messages.push({
          role: "tool",
          toolName: call.name,
          toolCallId: String(event.id),
          content:
            event.type === "tool_result"
              ? String(event.output ?? "")
              : `Tool failed: ${String(event.error ?? "")}`,
        });
        break;
      }
    }
  }

  return steps;
}
