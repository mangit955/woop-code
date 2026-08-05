/**
 * Turning an attached image into bytes, once, for all three clients.
 *
 * `ImageAttachment` stores a path rather than the bytes, so that a saved
 * session stays small and compaction keeps moving short strings. The cost of
 * that is this step: the file has to be read at the moment a request is built,
 * and by then it may have changed or gone — the agent extracts a frame to a
 * scratch path, and nothing stops a later turn overwriting it.
 *
 * So a file that cannot be read is dropped, not raised. A turn that fails
 * outright because a screenshot from four messages ago was tidied away is worse
 * than a turn that proceeds without it, and the text of the message already
 * says what the image was. The three render sites each add their own text note
 * in the provider's own shape.
 *
 * Read synchronously because all three request builders are synchronous
 * functions over `Message[]`, and making them async to load a file would ripple
 * through every caller and their tests. `readFileSync` is the sanctioned form
 * here; the rule the gate enforces is against the `fs/promises` read/write pair.
 */

import { readFileSync } from "node:fs";
import type { ImageAttachment } from "../config/types";

export interface LoadedImage {
  mediaType: string;
  base64: string;
}

export function imageParts(images: ImageAttachment[] | undefined): LoadedImage[] {
  if (!images?.length) return [];

  const loaded: LoadedImage[] = [];
  for (const image of images) {
    try {
      loaded.push({
        mediaType: image.mediaType,
        base64: readFileSync(image.path).toString("base64"),
      });
    } catch {
      // Gone or unreadable since it was attached. Reported by `imageText`
      // rather than raised; a dropped image must not cost the turn.
    }
  }

  return loaded;
}

/**
 * The message text, with a note when an image could not be loaded.
 *
 * Silence here is the dangerous option. The text the loop writes is "The image
 * requested above:", so a message that arrives with the image dropped and the
 * text untouched invites the model to describe something it was never shown —
 * and it has every reason to believe it was shown one. Saying the file is gone
 * turns a hallucination into a retry.
 */
export function imageText(
  content: string,
  attached: number,
  loaded: LoadedImage[],
): string {
  const missing = attached - loaded.length;
  if (missing <= 0) return content;

  const subject = missing === 1 ? "image is" : `${missing} images are`;
  return (
    `${content}\n\n[${subject} no longer readable and could not be attached. ` +
    `Do not describe ${missing === 1 ? "it" : "them"}; read the file again if it still matters.]`
  );
}
