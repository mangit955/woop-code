import { test, expect } from "bun:test";
import { parseInput } from "../../../commands/slash/parser";

test("parseInput: regular text", () => {
  const result = parseInput("Explain this code");
  expect(result).toEqual({
    type: "text",
    originalInput: "Explain this code",
  });
});

test("parseInput: valid command without args", () => {
  const result = parseInput("/help");
  expect(result).toEqual({
    type: "command",
    command: "help",
    args: [],
    originalInput: "/help",
  });
});

test("parseInput: valid command with args", () => {
  const result = parseInput("/provider google");
  expect(result).toEqual({
    type: "command",
    command: "provider",
    args: ["google"],
    originalInput: "/provider google",
  });
});

test("parseInput: command with multiple args", () => {
  const result = parseInput("/model set gemini-2.0-flash");
  expect(result).toEqual({
    type: "command",
    command: "model",
    args: ["set", "gemini-2.0-flash"],
    originalInput: "/model set gemini-2.0-flash",
  });
});

test("parseInput: discovery mode", () => {
  const result = parseInput("/");
  expect(result).toEqual({
    type: "discovery",
    originalInput: "/",
  });
});

test("parseInput: command is case insensitive", () => {
  const result = parseInput("/HELP");
  expect(result.command).toBe("help");
});

test("parseInput: handles extra whitespace", () => {
  const result = parseInput("  /help  ");
  expect(result).toEqual({
    type: "command",
    command: "help",
    args: [],
    originalInput: "  /help  ",
  });
});

test("parseInput: handles whitespace in args", () => {
  const result = parseInput("/provider   google");
  expect(result.args).toEqual(["google"]);
});

test("parseInput: empty string", () => {
  const result = parseInput("");
  expect(result.type).toBe("text");
});

test("parseInput: slash in middle of text", () => {
  const result = parseInput("Use /help command");
  expect(result.type).toBe("text");
});
