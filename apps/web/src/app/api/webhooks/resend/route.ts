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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

async function verifySignature(req: NextRequest, body: string, secret: string): Promise<boolean> {
  const svixId = req.headers.get("svix-id");
  const svixTs = req.headers.get("svix-timestamp");
  const svixSig = req.headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) return false;

  // Whole seconds, digits only: Number("NaN"), "1e3", "+5" and " 5" would otherwise slide through a numeric comparison.
  if (!/^\d+$/.test(svixTs)) return false;
  const nowS = Math.floor(Date.now() / 1000);
  const tsS = Number(svixTs);
  if (nowS - tsS > SVIX_TOLERANCE_S || tsS - nowS > SVIX_TOLERANCE_S) return false;

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "raw", bytesOf(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
  } catch {
    // A secret that is not base64 is a misconfiguration: refuse every event and say so.
    log.error("resend-webhook: RESEND_WEBHOOK_SECRET is not a valid base64 signing secret — refusing every event");
    return false;
  }

  // Signed string: "<svix-id>.<svix-timestamp>.<body>". `verify` compares in constant time and is false for a MAC of
  // the wrong length; Resend may send several signatures, and any v1 match passes.
  const signed = new TextEncoder().encode(`${svixId}.${svixTs}.${body}`);
  for (const entry of svixSig.split(" ")) {
    if (!entry.startsWith("v1,")) continue;
    let mac: Uint8Array<ArrayBuffer>;
    try {
      mac = bytesOf(entry.slice(3));
    } catch {
      continue;
    }
    if (await crypto.subtle.verify("HMAC", cryptoKey, mac, signed)) return true;
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.text();

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      log.error("resend-webhook: RESEND_WEBHOOK_SECRET is not set — refusing the event (an unsigned webhook is not accepted in production)");
      return NextResponse.json({ error: "webhook secret not configured" }, { status: 401 });
    }
    log.warn("resend-webhook: RESEND_WEBHOOK_SECRET not set — skipping signature verify");
  } else if (!(await verifySignature(req, body, secret))) {
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
  if (type === "email.bounced") {
    const email = recipientOf(data);
    if (email) {
      await suppress(email, "bounce", emailId).catch((e) =>
        log.error({ type, emailId, errName: errName(e) }, "resend-webhook: suppress bounce failed"),
      );
      log.info({ type, emailId }, "resend-webhook: bounce suppressed");
    }
  } else if (type === "email.complained") {
    const email = recipientOf(data);
    if (email) {
      await suppress(email, "complaint", emailId).catch((e) =>
        log.error({ type, emailId, errName: errName(e) }, "resend-webhook: suppress complaint failed"),
      );
      log.info({ type, emailId }, "resend-webhook: complaint suppressed");
    }
  }

  // The outbox row. A failure is a 500, so Resend retries the event (a retried event is safe: the move is monotonic).
  try {
    await applyProviderEvent(type, data);
  } catch (e) {
    log.error({ type, emailId, errName: errName(e) }, "resend-webhook: applying the event to the outbox failed");
    return NextResponse.json({ error: "could not apply event" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
