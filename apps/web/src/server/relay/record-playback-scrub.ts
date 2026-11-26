// Owner ruling 2026-11-26: a playback URL is never logged or stored. A Cloudflare Stream playback address carries its
// credential as the FIRST PATH SEGMENT (cf-playback.ts: a signed JWT, or an unsigned input's uid), so it can ride under
// `url` or `overlayUrl` as well as `playbackUrl`, or sit inside free text (`message`, `problems`) — all of which the
// record line's allow-list admits. The domain screen drops the `playbackUrl` KEY; this is the VALUE rule beside it, run
// on a line the screen already judged ok, so no kept/dropped/invalid count can move because of it:
//  - a URL-class field whose value is a Cloudflare playback address is dropped from the stored line;
//  - in free text the credential segment becomes `***` (the scrub's own mask), the rest of the text kept.
// The address shape is `scrub-score-url.ts`'s (the telemetry scrub's own definition), not a second regex.
import { ENCODED_STREAM_PLAYBACK_PATH, STREAM_PLAYBACK_PATH } from "@/lib/scrub-score-url";

/** The record line's URL-class and free-text keys (capture-schemas.ts's RECORD_PUBLIC_URL_KEYS and RECORD_TEXT_KEYS, which are
 *  not exported: its export list is pinned by capture-contract.test.ts). A drift test pins both lists to the PUBLISHED contract's
 *  own classes (capture-record.v1.json's `publicUrl:` and `text:` properties), so a key added there reds here. */
export const RECORD_URL_FIELDS: readonly string[] = ["url", "playbackUrl", "overlayUrl"];
export const RECORD_TEXT_FIELDS: readonly string[] = ["message", "problems"];

/** The telemetry scrub's patterns are global (`lastIndex` state), so a TEST copy is made per module, never shared. */
const PLAIN = new RegExp(STREAM_PLAYBACK_PATH.source);
const ENCODED = new RegExp(ENCODED_STREAM_PLAYBACK_PATH.source);

/** Whether a string holds a Cloudflare Stream playback address (plain, or URL-encoded inside another URL). */
export const holdsPlaybackAddress = (value: string): boolean => PLAIN.test(value) || ENCODED.test(value);
const MASK = "***";
const redactPlayback = (value: string): string =>
  value.replace(STREAM_PLAYBACK_PATH, `$1${MASK}`).replace(ENCODED_STREAM_PLAYBACK_PATH, `$1${MASK}`);

/**
 * The text a kept line is STORED as, after the value rule. A line that holds no playback address comes back as the very
 * string it went in (byte for byte); one that does is re-serialised with the field dropped or the text redacted.
 * `text` is the screen's own re-serialisation of a line it judged ok, so it parses; a value that is not an object is a
 * named refusal, never a guess.
 */
export function scrubPlaybackValues(text: string): string {
  const line: unknown = JSON.parse(text);
  if (typeof line !== "object" || line === null || Array.isArray(line)) throw new RangeError("scrubPlaybackValues: a screened line is an object");
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    if (typeof value === "string" && RECORD_URL_FIELDS.includes(key) && holdsPlaybackAddress(value)) { changed = true; continue; }
    if (typeof value === "string" && RECORD_TEXT_FIELDS.includes(key) && holdsPlaybackAddress(value)) { changed = true; out[key] = redactPlayback(value); continue; }
    out[key] = value;
  }
  return changed ? JSON.stringify(out) : text;
}
