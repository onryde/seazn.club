// lib/stream-key-shape.ts — spec 2026-09-30 §4 "Key-shape warning". WARNS, never blocks: a platform can change its key
// format, and the organiser is the authority on what their dashboard shows. Its job is the staging incident — a key's
// NAME ("TestYouTube") saved where the key belongs. Client-safe: the Directory's add and Replace key forms call it as
// the organiser types.
import type { StreamPlatform } from "@/lib/stream-destinations";

export const KEY_SHAPES: Readonly<Record<StreamPlatform, RegExp>> = {
  youtube: /^[a-z0-9]{4}(-[a-z0-9]{4}){3,4}$/i,
  twitch: /^live_\d+_[A-Za-z0-9]{20,}$/,
};

/** The dictionary key of the warning for `key` on `kind`, or null. An empty (or whitespace-only) key is an unfinished
 *  field, not a wrong one; surrounding whitespace is ignored, exactly as the server trims it before sealing. */
export function keyShapeWarning(kind: StreamPlatform, key: string): `streamDest.shape.${StreamPlatform}` | null {
  const k = key.trim();
  if (k === "") return null;
  return KEY_SHAPES[kind].test(k) ? null : `streamDest.shape.${kind}`;
}
