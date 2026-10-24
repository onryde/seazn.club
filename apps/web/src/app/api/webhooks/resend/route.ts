import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { suppress } from "@/lib/email";
import { log } from "@/server/logger";
import { applyProviderEvent } from "@/server/email-outbox/provider-events";

// Resend signs webhooks with Svix. The signed content is "<svix-id>.<svix-timestamp>.<raw body>", the key is the base64 text
// after "whsec_", and the header holds one or more space-separated "v1,<base64 HMAC-SHA256>" entries.
//
// FAIL CLOSED. With RESEND_WEBHOOK_SECRET unset the route refuses (401) in production, because an unverifiable webhook lets
// anyone who knows the URL suppress an address or mark an email delivered. Outside production it accepts and warns, as it
// always has, so a developer can POST a sample event without a secret.

/** Svix's replay window: a timestamp more than 5 minutes either side of now is refused (Svix's own default). Resend re-signs
 *  every retry with a fresh timestamp, so a genuine retry is always inside it. */
const SVIX_TOLERANCE_S = 5 * 60;

/** The most `v1,` entries a signature header may list. Svix sends one, or two while a secret is being rotated; eight leaves
 *  room and still bounds the work an unauthenticated caller can ask for. More than this is refused before any MAC is computed. */
const SVIX_MAX_SIGNATURES = 8;

/** The svix-id is a caller-supplied header: only this much of it reaches a log line. */
const SVIX_ID_LOG_MAX = 128;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

async function verifySignature(req: NextRequest, body: string, secret: string): Promise<boolean> {
  const svixId = req.headers.get("svix-id");
  const svixTs = req.headers.get("svix-timestamp");
  const svixSig = req.headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) return false;

  // Pre-auth, so cheap and bounded: a header listing more than the cap is refused before a key is imported or a MAC computed.
  const entries = svixSig.split(" ");
  if (entries.length > SVIX_MAX_SIGNATURES) return false;

  // Whole seconds, digits only: Number("NaN"), "1e3", "+5" and " 5" would otherwise slide through a numeric comparison.
  if (!/^\d+$/.test(svixTs)) return false;
  const nowS = Math.floor(Date.now() / 1000);
  const tsS = Number(svixTs);
  if (nowS - tsS > SVIX_TOLERANCE_S || tsS - nowS > SVIX_TOLERANCE_S) return false;

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "raw", bytesOf(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  } catch {
    // A secret that is not base64 is a misconfiguration: refuse every event and say so.
    log.error("resend-webhook: RESEND_WEBHOOK_SECRET is not a valid base64 signing secret — refusing every event");
    return false;
  }

  // Signed string: "<svix-id>.<svix-timestamp>.<body>". The MAC is computed ONCE, whatever the header lists; each `v1,`
  // candidate is then compared with it in constant time (a candidate of another length cannot match, and
  // `timingSafeEqual` throws on unequal lengths, so that is checked first). Any v1 match passes.
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${svixId}.${svixTs}.${body}`)));
  for (const entry of entries) {
    if (!entry.startsWith("v1,")) continue;
    let mac: Uint8Array<ArrayBuffer>;
    try {
      mac = bytesOf(entry.slice(3));
    } catch {
      continue;
    }
    if (mac.length === expected.length && timingSafeEqual(mac, expected)) return true;
  }
  return false;
}

/** The recipient a bounce or complaint names: the first of `data.to`, else `data.email`. */
function recipientOf(data: Record<string, unknown>): string | undefined {
  const first = Array.isArray(data.to) ? data.to[0] : undefined;
  if (typeof first === "string") return first;
  return typeof data.email === "string" ? data.email : undefined;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * Put the event's recipient on the suppression list. A failed write is logged as an error and does NOT fail the request (the
 * existing behaviour: the outbox row still moves, and the answer is still 200); "suppressed" is only claimed when it was.
 */
async function suppressRecipient(
  type: string,
  reason: "bounce" | "complaint",
  data: Record<string, unknown>,
  emailId: string | undefined,
): Promise<void> {
  const email = recipientOf(data);
  if (!email) return;
  try {
    await suppress(email, reason, emailId);
  } catch (e) {
    log.error({ type, emailId, errName: errName(e) }, `resend-webhook: suppress ${reason} failed`);
    return;
  }
  log.info({ type, emailId }, `resend-webhook: ${reason} suppressed`);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      log.error("resend-webhook: RESEND_WEBHOOK_SECRET is not set — refusing the event (an unsigned webhook is not accepted in production)");
      // The same body as a bad signature: the caller learns nothing about the configuration. The log line says which.
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
    log.warn("resend-webhook: RESEND_WEBHOOK_SECRET not set — skipping signature verify");
  } else if (!(await verifySignature(req, body, secret))) {
    // One line per refusal, by svix-id only: never the payload (it carries the recipient), the signature or the secret.
    const svixId = req.headers.get("svix-id");
    log.warn({ svixId: svixId === null ? null : svixId.slice(0, SVIX_ID_LOG_MAX) }, "resend-webhook: signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(event)) return NextResponse.json({ error: "invalid json" }, { status: 400 });

  const type = typeof event.type === "string" ? event.type : "";
  const data = isRecord(event.data) ? event.data : {};
  const emailId = typeof data.email_id === "string" ? data.email_id : undefined;

  // The suppression list. Never log the address (or the payload): the event type and Resend's email id say which email.
  if (type === "email.bounced") await suppressRecipient(type, "bounce", data, emailId);
  else if (type === "email.complained") await suppressRecipient(type, "complaint", data, emailId);

  // The outbox row. A failure is a 500, so Resend retries the event (a retried event is safe: the move is monotonic).
  try {
    await applyProviderEvent(type, data);
  } catch (e) {
    log.error({ type, emailId, errName: errName(e) }, "resend-webhook: applying the event to the outbox failed");
    return NextResponse.json({ error: "could not apply event" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
