/**
 * Lets the model look at an image instead of computing what is in it.
 *
 * The recorded benchmark trials show why. In the video-processing task the
 * agent made 131 `cv2` and 128 `numpy` calls building histograms, frame
 * differences and bounding boxes to infer what a frame contained — and scored 0
 * in three of four trials. Every model this drives can see; nothing was
 * offering them the pixels.
 *
 * The tool returns text and queues the image, which the agent loop attaches to
 * a following user message. That indirection is not decoration: of the three
 * providers only Anthropic accepts an image inside a tool result, so returning
 * one directly would work on one provider and quietly degrade on the other two.
 * A user message carrying image parts is the shape all three accept.
 */

import type { ImageAttachment, Tool } from "../config/types";
import { resolveWorkspacePath } from "./workspace";

/**
 * The largest file that is sent.
 *
 * Providers reject a request whose base64 payload is over roughly 5MB, and
 * base64 is a third larger than the bytes it encodes. Refusing here with an
 * instruction the model can act on is better than a 400 it cannot read.
 */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

/** Magic bytes, because an extension is a claim and a header is evidence. */
const SIGNATURES: { mediaType: string; test: (bytes: Uint8Array) => boolean }[] = [
  {
    mediaType: "image/png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mediaType: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mediaType: "image/gif",
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  },
  {
    mediaType: "image/webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

function detectMediaType(bytes: Uint8Array): string | null {
  return SIGNATURES.find((signature) => signature.test(bytes))?.mediaType ?? null;
}

/**
 * Width and height, read from the header.
 *
 * Reported because it is what the model needs to ask for the right crop next,
 * and because it is the one property worth stating that the image itself does
 * not make obvious. Only PNG and JPEG are parsed; the others return null and
 * the result simply omits the dimensions rather than guessing at them.
 */
function readDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (mediaType === "image/png" && bytes.length >= 24) {
    // IHDR is always the first chunk, so width and height sit at a fixed offset.
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (mediaType === "image/jpeg") {
    // Walk the segment chain to the start-of-frame marker, which is the only
    // place the size is recorded. Skipping by declared length rather than
    // scanning for the marker avoids matching one inside entropy-coded data.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);

      // SOF0..SOF15, excluding the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }

      offset += 2 + length;
    }
  }

  return null;
}

/**
 * Images read this turn and not yet attached to a message.
 *
 * Drained by the agent loop immediately after the tool returns, so at most one
 * call's worth is ever waiting. A queue rather than a return value because
 * `Tool.execute` returns a string — a contract the whole registry and its
 * sweep rest on, and not one worth reshaping for a single tool.
 */
let pending: ImageAttachment[] = [];

export function takePendingImages(): ImageAttachment[] {
  const taken = pending;
  pending = [];
  return taken;
}

export const readImageTool: Tool = {
  name: "read_image",
  description: `Shows you an image. Use it to look at a screenshot, a diagram, a rendered figure or a video frame rather than inferring their contents from pixel statistics.

The image arrives with the next message, so describe what you are looking for and then read what you actually see. To inspect a frame of a video, extract it to a file first (ffmpeg, or cv2 in the repl) and read that file.

Accepts PNG, JPEG, GIF and WebP.`,

  parameters: [
    {
      name: "path",
      description: "Path to the image file",
      required: true,
    },
  ],

  async execute(args) {
    const requestedPath = args.path;

    if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
      throw Error("File path is required");
    }

    let path: string;
    try {
      path = await resolveWorkspacePath(requestedPath, { mustExist: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Error(`File ${requestedPath} does not exist`);
      }
      throw error;
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw Error(`File ${requestedPath} does not exist`);
    }

    if (file.size === 0) {
      throw Error(`File ${requestedPath} is empty, so there is no image to show.`);
    }

    if (file.size > MAX_IMAGE_BYTES) {
      throw Error(
        `Image ${requestedPath} is ${Math.round(file.size / 1024)}KB, over the ` +
          `${Math.round(MAX_IMAGE_BYTES / 1024)}KB a provider will accept. Resize or ` +
          `crop it to a smaller file and read that.`,
      );
    }

    // Only the header is needed to identify it; the bytes themselves are read
    // again by whichever provider client renders the request.
    const header = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    const mediaType = detectMediaType(header);

    if (!mediaType) {
      throw Error(
        `${requestedPath} is not a PNG, JPEG, GIF or WebP image. ` +
          `Use read_file for text, or convert it to a supported format first.`,
      );
    }

    pending.push({ path, mediaType });

    const dimensions = readDimensions(header, mediaType);
    const size = `${Math.round(file.size / 1024)}KB`;
    const shape = dimensions ? `${dimensions.width}x${dimensions.height}, ` : "";

    return (
      `${requestedPath} (${shape}${mediaType}, ${size}) is attached to the next ` +
      `message. Describe what it shows before drawing conclusions from it.`
    );
  },
};
