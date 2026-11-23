// server/relay/cf-live-notification.ts — Cloudflare Stream's live-input notification, the pure half (Task 27b): the shared-secret
// check and the body, in this app's words. No database, no network, no clock. The route (app/api/webhooks/cloudflare-stream-live)
// reads the header and the body; the use case (usecases/stream-sessions/live-notification.ts) records what this answers.
//
// Cloudflare's contract (read 2026-11-23):
//  * Live-input notifications are CLOUDFLARE NOTIFICATIONS (alert type `stream_live_notifications`), not the Stream video webhook
//    (`/stream/webhook`, on-demand videos only, signed `Webhook-Signature: time=…,sig1=…`). Per ACCOUNT: one policy, an optional
//    list of input ids (blank = every input), and the events ticked: `live_input.connected`, `live_input.disconnected`, and
//    `live_input.errored` (opt-in; added 2024-07-23). https://developers.cloudflare.com/stream/stream-live/webhooks/
//  * The destination is a generic webhook whose secret Cloudflare sends VERBATIM in `cf-webhook-auth` on every request: no HMAC,
//    no timestamp, so the check is equality, done in constant time.
//    https://developers.cloudflare.com/notifications/get-started/configure-webhooks/
//  * The body: `{ name, text, data: { notification_name, input_id, event_type, updated_at, live_input_errored?: { error: { code,
//    message }, video_codec, audio_codec } }, ts }`, plus (for some alert types) account_id, policy_id, alert_type,
//    alert_correlation_id. No delivery id, and no retry policy is documented.
//    https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/
import { createHash, timingSafeEqual } from "node:crypto";
import type { IngestState } from "./ports";

/** The events Cloudflare documents, each with the word it means in this app's port (ports.ts IngestState). An errored input is
 *  neither a phone known to be sending nor one known to be gone: `unknown`, as the poll reads an input word it has never seen. */
const WORDS = {
  "live_input.connected": "connected",
  "live_input.disconnected": "disconnected",
  "live_input.errored": "unknown",
} as const satisfies Record<string, IngestState>;
export type CfLiveEvent = keyof typeof WORDS;

/** The longest input id read (Cloudflare's are 32 hex characters; a longer value is not one of its inputs). */
const ID_MAX = 200;
/** The longest error code kept (Cloudflare's are words like ERR_GOP_OUT_OF_RANGE). */
const CODE_MAX = 64;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** True only when `header` is exactly `secret`. Both are hashed first, so `timingSafeEqual` always compares two 32-byte digests:
 *  the time taken says nothing about the header's length or where it differs, and nothing throws. A missing or empty header answers
 *  false, which also makes an unset (empty) secret match nothing: an empty secret is one anybody could send. */
export function verifyCfWebhookAuth(header: string | null, secret: string): boolean {
  if (!header) return false;
  return timingSafeEqual(sha256(header), sha256(secret));
}

/** One live-input notification, in this app's words. */
export interface CfLiveNotification {
  /** `data.input_id`: the Cloudflare live input's uid, as fixture_stream_inputs.ingest_input_id holds it. */
  inputUid: string;
  /** `data.event_type`, verbatim. */
  event: CfLiveEvent;
  /** The event's word (see WORDS). */
  word: IngestState;
  /** `data.live_input_errored.error.code`, cut to CODE_MAX; null when the body carries none. */
  reason: string | null;
  /** When it happened: `data.updated_at`, else the delivery's `ts` (seconds); null when neither is a time. */
  at: Date | null;
}

/** Why a body is not a notification: the FIELD that failed (never its value), so a format drift reads in the warn line. */
export type CfLiveParse =
  | { ok: true; notification: CfLiveNotification }
  | { ok: false; field: "body" | "data" | "data.input_id" | "data.event_type" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEvent = (v: unknown): v is CfLiveEvent => typeof v === "string" && Object.hasOwn(WORDS, v);

function momentOf(updatedAt: unknown, ts: unknown): Date | null {
  if (typeof updatedAt === "string") {
    const d = new Date(updatedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts * 1000) : null;
}

/** The notification a body carries, or the first field that is not the shape Cloudflare sends. A body is never refused for its
 *  clock (`at` falls back) or for a missing error code (`reason` null): only the input and the event decide what is recorded. */
export function parseCfLiveNotification(json: unknown): CfLiveParse {
  if (!isRecord(json)) return { ok: false, field: "body" };
  const data = json.data;
  if (!isRecord(data)) return { ok: false, field: "data" };
  const uid = data.input_id;
  if (typeof uid !== "string" || uid.trim() === "" || uid.length > ID_MAX) return { ok: false, field: "data.input_id" };
  const event = data.event_type;
  if (!isEvent(event)) return { ok: false, field: "data.event_type" };
  const errored = data.live_input_errored;
  const code = isRecord(errored) && isRecord(errored.error) ? errored.error.code : undefined;
  const reason = typeof code === "string" && code.trim() !== "" ? code.slice(0, CODE_MAX) : null;
  return { ok: true, notification: { inputUid: uid, event, word: WORDS[event], reason, at: momentOf(data.updated_at, json.ts) } };
}
