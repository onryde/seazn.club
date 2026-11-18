import { NextResponse } from "next/server";
import { log } from "@/server/logger";
import { receiveRealtimeKitWebhook } from "@/server/external-play/video/webhook";
import { WEBHOOK_KEY_REFETCH_MIN_MS } from "@/server/external-play/video/webhook-signature";

// Check-in capacity plan 1, Task 7 (spec §6.2): the RealtimeKit webhook. PUBLIC and unauthenticated except by the vendor's RSA
// signature (no session, no CSRF token: proxy.ts exempts /api/webhooks/ from its Origin check); every decision is the usecase's
// (server/external-play/video/webhook.ts) and this route answers exactly what it decided. The vendor retries 5xx and network
// errors only, so a retryable condition is a 5xx and a refusal it should never retry is a 4xx.
//
//  - The body is read as BYTES (`arrayBuffer`), never `text()`: the signature is over the bytes the vendor sent, and decoding
//    to a string first (a BOM, invalid UTF-8) would change them.
//  - A 400 logs the event name and the body's top-level KEYS, never a value (a participant's `customParticipantId` is a person
//    UUID) and never the body or the signature.
//  - A throw out of the usecase is a storage failure that rolled the transaction back: 500, so the vendor retries the same uuid.
//  - A 401 or 503 logs ONE warn carrying the receipt's reason (never a header or the body); a 400 logs the shape above.

const KEY_RETRY_AFTER_S = String(Math.ceil(WEBHOOK_KEY_REFETCH_MIN_MS / 1000));

/** Bounds on what a 400 line may carry: the body is signed, but any RealtimeKit customer's body verifies, so it is untrusted text. */
const LOG_MAX_KEYS = 20;
const LOG_MAX_LEN = 64;

/** The event name (a string, cut) and the top-level key names (cut, capped) of a body that did not parse as an event: no values. */
function shapeOf(rawBody: Uint8Array): { event: string | null; keys: string[] } | null {
  try {
    const v = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { event: null, keys: [] };
    const o = v as Record<string, unknown>;
    return {
      event: typeof o.event === "string" ? o.event.slice(0, LOG_MAX_LEN) : null,
      keys: Object.keys(o).slice(0, LOG_MAX_KEYS).map((k) => k.slice(0, LOG_MAX_LEN)),
    };
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = Buffer.from(await req.arrayBuffer());

  let receipt: Awaited<ReturnType<typeof receiveRealtimeKitWebhook>>;
  try {
    receipt = await receiveRealtimeKitWebhook({
      rawBody,
      signature: req.headers.get("rtk-signature"),
      uuid: req.headers.get("rtk-uuid"),
    });
  } catch (err) {
    // `{ err }`, the house shape: the logger's serializer (logger.ts dbSafeErr) strips what a driver error echoes back (the failing row,
    // the bound parameters, the statement) and keeps the name, message, code and stack. Never a hand-picked subset, never the body.
    log.error({ err }, "realtimekit-webhook: processing failed");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  switch (receipt.status) {
    case 200:
      return NextResponse.json({ received: true, outcome: receipt.outcome });
    case 400:
      log.warn({ shape: shapeOf(rawBody) }, "realtimekit-webhook: body is not a RealtimeKit event");
      return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
    case 401:
      // The reason only (no_signature | no_uuid | signature): never a header value, never the body. One line per refusal, so a forged
      // flood is visible to whoever reads the logs.
      log.warn({ reason: receipt.reason }, "realtimekit-webhook: delivery refused");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    case 503:
      log.warn({ reason: receipt.reason }, "realtimekit-webhook: signing key unavailable, the vendor will retry");
      return NextResponse.json({ error: "Key unavailable" }, { status: 503, headers: { "Retry-After": KEY_RETRY_AFTER_S } });
  }
}
