import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildContents } from "../../../providers/client";
import { buildAnthropicMessages } from "../../../providers/anthropicClient";
import { buildOpenAIInput } from "../../../providers/openaiClient";
import { imageParts, imageText } from "../../../providers/images";
import { recentMessages } from "../../../config/config";
import type { Message } from "../../../config/types";

/**
 * An attached image has to reach all three providers, in each one's own shape.
 *
 * Driven per provider rather than through one client, because this is exactly
 * the kind of change that lands on one and is forgotten on the others — the
 * repository has the scar: a provider client that read `toolRegistry` directly
 * instead of its offered-tools parameter, merged without a textual conflict.
 *
 * The images are stored as paths and loaded when the request is built, so the
 * cases that matter are the ordinary one and the one where the file has gone.
 */

const fixtures = join(process.cwd(), `.test-attachments-${crypto.randomUUID()}`);
mkdirSync(fixtures, { recursive: true });

const png = join(fixtures, "frame.png");
await Bun.write(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

const withImage: Message[] = [
  { role: "user", content: "Look at this", images: [{ path: png, mediaType: "image/png" }] },
];

const withMissingImage: Message[] = [
  {
    role: "user",
    content: "Look at this",
    images: [{ path: join(fixtures, "gone.png"), mediaType: "image/png" }],
  },
];

const plain: Message[] = [{ role: "user", content: "No image here" }];

describe("imageParts", () => {
  test("loads a file as base64 with its media type", () => {
    const [loaded] = imageParts([{ path: png, mediaType: "image/png" }]);
    expect(loaded!.mediaType).toBe("image/png");
    expect(loaded!.base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString("base64"));
  });

  test("drops a file that has gone rather than throwing", () => {
    // The turn must still be sendable. A screenshot tidied away between turns
    // is worth less than the conversation that refers to it.
    expect(imageParts([{ path: join(fixtures, "gone.png"), mediaType: "image/png" }])).toEqual(
      [],
    );
  });

  test("returns nothing for a message with no images", () => {
    expect(imageParts(undefined)).toEqual([]);
    expect(imageParts([])).toEqual([]);
  });
});

describe("imageText", () => {
  test("leaves the text alone when every image loaded", () => {
    expect(imageText("Look", 1, [{ mediaType: "image/png", base64: "x" }])).toBe("Look");
  });

  test("leaves the text alone when there were no images", () => {
    expect(imageText("Hello", 0, [])).toBe("Hello");
  });

  test("names a single dropped image and tells the model not to describe it", () => {
    const text = imageText("Look", 1, []);
    expect(text).toContain("image is no longer readable");
    expect(text).toContain("Do not describe it");
  });

  test("counts several dropped images", () => {
    expect(imageText("Look", 3, [{ mediaType: "image/png", base64: "x" }])).toContain(
      "2 images are no longer readable",
    );
  });
});

describe("Gemini", () => {
  test("sends the image as an inlineData part after the text", () => {
    const [content] = buildContents(withImage) as any[];
    expect(content.parts[0].text).toBe("Look at this");
    expect(content.parts[1].inlineData.mimeType).toBe("image/png");
    expect(content.parts[1].inlineData.data.length).toBeGreaterThan(0);
  });

  test("a message with no image is unchanged", () => {
    const [content] = buildContents(plain) as any[];
    expect(content.parts).toHaveLength(1);
    expect(content.parts[0].text).toBe("No image here");
  });

  test("a missing file leaves one part, noting the image is gone", () => {
    const [content] = buildContents(withMissingImage) as any[];
    expect(content.parts).toHaveLength(1);
    expect(content.parts[0].text).toContain("no longer readable");
  });
});

describe("Anthropic", () => {
  test("sends the image as a base64 image block after the text", () => {
    const [message] = buildAnthropicMessages(withImage, new Map()) as any[];
    expect(message.content[0]).toEqual({ type: "text", text: "Look at this" });
    expect(message.content[1].type).toBe("image");
    expect(message.content[1].source.media_type).toBe("image/png");
    expect(message.content[1].source.type).toBe("base64");
  });

  test("a message with no image stays a plain string", () => {
    // Not a one-element content array: the string form is what every message
    // in this client has always been, and changing it for all of them would
    // move the cache prefix for no gain.
    const [message] = buildAnthropicMessages(plain, new Map()) as any[];
    expect(message.content).toBe("No image here");
  });

  test("a missing file falls back to a string that says the image is gone", () => {
    // Silence here is the dangerous option: the loop's text is "The image
    // requested above:", so a message arriving with no image and no note
    // invites the model to describe something it was never shown.
    const [message] = buildAnthropicMessages(withMissingImage, new Map()) as any[];
    expect(message.content).toContain("Look at this");
    expect(message.content).toContain("no longer readable");
  });
});

describe("OpenAI", () => {
  test("sends the image as an input_image data URL after the text", () => {
    const [message] = buildOpenAIInput(withImage, new Map()) as any[];
    expect(message.content[0]).toEqual({ type: "input_text", text: "Look at this" });
    expect(message.content[1].type).toBe("input_image");
    expect(message.content[1].image_url).toStartWith("data:image/png;base64,");
  });

  test("a message with no image stays a plain string", () => {
    const [message] = buildOpenAIInput(plain, new Map()) as any[];
    expect(message.content).toBe("No image here");
  });

  test("a missing file falls back to a string that says the image is gone", () => {
    const [message] = buildOpenAIInput(withMissingImage, new Map()) as any[];
    expect(message.content).toContain("Look at this");
    expect(message.content).toContain("no longer readable");
  });
});

describe("the history window", () => {
  /**
   * An attached image is not a turn of the conversation.
   *
   * `recentMessages` keeps the last N *user* turns, and the loop follows every
   * read_image with a user message carrying the picture. Counting those as
   * turns shortens the window until the question itself falls out of it — with
   * MAX_TURNS at 6, an agent reading five frames of a video kept one real turn
   * and five copies of "The image requested above:". That is precisely the
   * task read_image was added for, so it is the expected case, not an edge one.
   */
  const attachment = (path: string): Message => ({
    role: "user",
    content: "The image requested above:",
    images: [{ path, mediaType: "image/png" }],
  });

  const conversation: Message[] = [
    { role: "user", content: "question one" },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "question two" },
    attachment("/a.png"),
    attachment("/b.png"),
    attachment("/c.png"),
  ];

  const realTurns = (messages: Message[]) =>
    messages.filter((m) => m.role === "user" && !m.images?.length).length;

  test("attachments do not consume the window's turns", () => {
    expect(realTurns(recentMessages(conversation, 2))).toBe(2);
  });

  test("one turn of window still keeps a real question", () => {
    expect(realTurns(recentMessages(conversation, 1))).toBe(1);
  });

  test("attachments inside the window are still kept", () => {
    // Skipped when counting, never dropped when slicing — the picture has to
    // travel with the message that refers to it.
    const windowed = recentMessages(conversation, 1);
    expect(windowed.filter((m) => m.role === "user" && m.images?.length).length).toBe(3);
  });

  test("a conversation with no attachments is windowed as before", () => {
    const plainTalk: Message[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "user", content: "two" },
      { role: "assistant", content: "b" },
    ];
    expect(recentMessages(plainTalk, 1)).toEqual([
      { role: "user", content: "two" },
      { role: "assistant", content: "b" },
    ]);
  });
});
