// The ONE stream-link validator (R16), shared by the write route and the
// organiser panel's inline error. No `server-only`: the panel is a client
// component and must validate before it sends.
//
// EXACT hostname comparison. Never `startsWith`, never `includes`, never a
// regex over the whole URL: `https://evil.example/www.youtube.com` and
// `https://www.youtube.com.evil.example/` both contain an allowed host and
// neither IS one. `new URL()` is what separates the authority from the rest;
// this file's whole job is to compare `url.hostname` against a fixed set.
import { z } from "zod";

export const STREAM_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
  // Owner answer 16 (Q5), 2026-09-06: "Agree". YouTube's mobile host — what
  // the phone app's share sheet produces. Exact hostname like every other
  // entry; it widens the set by ONE name, not by a `youtube.com` suffix rule.
  "m.youtube.com",
  "www.facebook.com",
  "facebook.com",
  "fb.watch",
  "www.twitch.tv",
  "twitch.tv",
  "kick.com",
  "www.kick.com",
] as const;

const ALLOWED = new Set<string>(STREAM_HOSTS);

/** True when `value` is an https URL whose hostname is EXACTLY one of the eleven.
 *  Credentials in the authority are refused too — a link a club pastes into a
 *  public page must not carry a username. */
export function isStreamUrl(value: string): boolean {
  if (value !== value.trim()) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return ALLOWED.has(url.hostname);
}

/**
 * `""` (or whitespace) clears the link; `null` passes through; anything else
 * must satisfy `isStreamUrl`.
 *
 * `z.preprocess`, NOT a trailing `.transform()` — this schema is embedded in
 * `PutFixtureStream` (api-v1/schemas.ts), which openapi.ts converts with
 * `z.toJSONSchema(…, { io: "output" })`. A trailing `.transform()` makes the
 * transform the OUTPUT node and the whole generator dies with "Transforms
 * cannot be represented in JSON Schema" (the exact hazard AutoScheduleRequest's
 * comment in schemas.ts documents and works around the same way). `preprocess`
 * puts the trim-to-null normalization on the INPUT side instead, so the
 * output side (`z.union([z.string(), z.null()]).refine(...)`) is plain and
 * converts cleanly.
 */
export const streamUrlSchema = z.preprocess(
  (v) => (v === null || (typeof v === "string" && v.trim() === "") ? null : v),
  z.union([z.string(), z.null()]).refine((v) => v === null || isStreamUrl(v), {
    message: "Stream link must be an https link to YouTube, Facebook, Twitch or Kick",
  }),
);
