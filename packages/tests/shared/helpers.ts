import type { Message } from "../../../config/types";

/**
 * Deep clone helper for test isolation
 */
export const clone = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));

/**
 * Wait helper for async tests
 */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Assert that a value is defined (TypeScript type guard)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message?: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || "Expected value to be defined");
  }
}

/**
 * Compare messages ignoring order-independent fields
 */
export const messagesEqual = (a: Message, b: Message): boolean => {
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Extract text content from assistant messages in a conversation
 */
export const extractAssistantText = (messages: Message[]): string => {
  return messages
    .filter((m) => m.role === "assistant")
    .map((m) => (m as Extract<Message, { role: "assistant" }>).content)
    .join("");
};

/**
 * Count messages by role
 */
export const countMessagesByRole = (
  messages: Message[],
  role: Message["role"],
): number => {
  return messages.filter((m) => m.role === role).length;
};

/**
 * Get last message of specific role
 */
export const getLastMessage = (
  messages: Message[],
  role: Message["role"],
): Message | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role) {
      return messages[i];
    }
  }
  return undefined;
};

/**
 * Create abort controller that aborts after delay
 */
export const createTimedAbortController = (ms: number): AbortController => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller;
};
