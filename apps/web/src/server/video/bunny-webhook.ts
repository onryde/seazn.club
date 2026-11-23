// server/video/bunny-webhook.ts — the Bunny Stream webhook's pure half (Seazn-hosted video, Phase 2, Task 27): the signature, the
// body, and the webhook's own status list. No database, no network, no clock. The route (app/api/webhooks/bunny-stream) reads the raw
// body and the headers; the use case (usecases/seazn-replay-webhook.ts) acts on what `parseBunnyEvent` answers.
//
// Bunny's contract (B6, docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md; re-read against Bunny's "Stream webhook" page on
// 2026-11-23):
//  * `X-BunnyStream-Signature` is the lowercase hex HMAC-SHA256 of the RAW body (the exact bytes sent, never a re-serialisation),
//    keyed with the library's Read-Only API key; `X-BunnyStream-Signature-Version: v1`, `X-BunnyStream-Signature-Algorithm:
//    hmac-sha256`.
//  * The body: `VideoLibraryId` (a number), `VideoGuid`, `Status`, `EventId` (the same on every redelivery: the dedupe key) and
//    `Timestamp` (when the event happened, ISO UTC), plus fields read nowhere here (`IsLiveStreamWebhook`, `Reason`).
//  * The statuses are the WEBHOOK's list, not the video API's (Task 21, replay-bunny.ts): 3 Finished and 4 Resolution finished
//    (the first one means playable), 5 Failed. Bunny redelivers a refused event at 30 s, 2 m, 10 m, 30 m, 1 h and 2 h, then drops it.
import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "hmac-sha256";
/** The longest event id or video id read: Bunny's are uuids; a longer value is not one of its events. */
const ID_MAX = 200;

/** True only for Bunny's v1 hmac-sha256 signature of these exact bytes under `readOnlyKey`. The comparison is constant-time
 *  (`timingSafeEqual`) on equal-length byte strings; any other length answers false and never throws. An empty key answers false: an
 *  HMAC under an empty key is one anybody can make. */
export function verifyBunnySignature(
  rawBody: string,
  h: { signature: string | null; version: string | null; algorithm: string | null },
  readOnlyKey: string,
): boolean {
  if (h.version !== VERSION || h.algorithm !== ALGORITHM || !h.signature || readOnlyKey === "") return false;
  const expected = Buffer.from(createHmac("sha256", readOnlyKey).update(rawBody, "utf8").digest("hex"), "utf8");
  const given = Buffer.from(h.signature, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** One Bunny Stream webhook event, in this app's words. */
export interface BunnyEvent {
  /** `VideoLibraryId`, as text (the library setting is text). */
  libraryId: string;
  /** `VideoGuid`: the host's video id, as the replay port names it. */
  videoId: string;
  /** `Status`: the WEBHOOK's number (see `webhookOutcome`). */
  status: number;
  /** `EventId`: the same on every redelivery of one event. */
  eventId: string;
  /** `Timestamp`: when the event happened (not when it was delivered). */
  at: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const idOf = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= ID_MAX ? v : null);

/** The event a signed body carries, or null when any of its five fields is missing or not the shape Bunny sends: never a guess. */
export function parseBunnyEvent(json: unknown): BunnyEvent | null {
  if (!isRecord(json)) return null;
  const lib = json.VideoLibraryId;
  const libraryId = isCount(lib) ? String(lib) : typeof lib === "string" && /^\d+$/.test(lib) ? lib : null;
  const videoId = idOf(json.VideoGuid);
  const eventId = idOf(json.EventId);
  const status = isCount(json.Status) ? json.Status : null;
  const at = typeof json.Timestamp === "string" ? new Date(json.Timestamp) : null;
  if (libraryId === null || videoId === null || eventId === null || status === null || at === null || Number.isNaN(at.getTime())) return null;
  return { libraryId, videoId, status, eventId, at };
}

/** The webhook's status list (B6) — NOT the video API's (Task 21), where 3 is still transcoding and 6 a failed upload. 3 Finished
 *  and 4 Resolution finished are `playable` (a trigger to check the copy, never a verdict: Task 24's check decides); 5 Failed is
 *  `failed`; every other event (queued, processing, encoding, uploads, captions, deletion, a number Bunny adds later) is `ignore`. */
const WEBHOOK_OUTCOME: ReadonlyMap<number, "playable" | "failed"> = new Map([[3, "playable"], [4, "playable"], [5, "failed"]]);
export function webhookOutcome(status: number): "playable" | "failed" | "ignore" {
  return WEBHOOK_OUTCOME.get(status) ?? "ignore";
}
