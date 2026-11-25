import { NextResponse } from "next/server";
import { log } from "@/server/logger";
import { parseCfLiveNotification, verifyCfWebhookAuth } from "@/server/relay/cf-live-notification";
import { cfLiveWebhookSecret } from "@/server/relay/config";
import { recordLiveNotification } from "@/server/usecases/stream-sessions";

// Seazn-hosted video, Task 27b: Cloudflare Stream's live-input notifications (live_input.connected / .disconnected / .errored),
// RECORDED the moment they happen, beside the stream tick's poll (1 min prod / 5 min stg), which stays the decider. PUBLIC and
// unauthenticated except by the destination's shared secret (no session, no CSRF: proxy.ts exempts /api/webhooks/ from its Origin
// check). A new route, not an extension of another: no Cloudflare Stream webhook existed here (the recordings are polled), and
// these are Cloudflare NOTIFICATIONS, whose auth (`cf-webhook-auth`, the secret verbatim) is not the Stream video webhook's
// HMAC (relay/cf-live-notification.ts has the contract). Every decision is the use case's (usecases/stream-sessions/live-notification.ts).
//
//  - The body is read as TEXT first (the resend and bunny-stream webhooks' way), so a body is parsed only once it is authentic.
//  - No secret configured, or a delivery without it: 401 with no detail and nothing written; one warn names which, never a header,
//    the body or the secret.
//  - An authentic body that is not a live-input notification (the destination's "Save and Test" message, a format drift): 200
//    `{ ignored: true }`, and a warn naming the FIELD that failed (never a value).
//  - An input no session here owns: 200, acked and ignored at debug. stg and prod share one Cloudflare account and its
//    notification policy, so each environment receives the other's events, routinely.
//  - A throw out of the use case is 500 (a Cloudflare delivery that is not 2xx shows on the destination as its last failure).
//    Everything else is 200.

const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();

  const secret = cfLiveWebhookSecret();
  if (secret === null || !verifyCfWebhookAuth(req.headers.get("cf-webhook-auth"), secret)) {
    log.warn({ reason: secret === null ? "no_secret_configured" : "auth" }, "cloudflare-live-webhook: delivery refused");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = undefined;
  }
  const parsed = parseCfLiveNotification(json);
  if (!parsed.ok) {
    log.warn({ field: parsed.field, bytes: rawBody.length }, "cloudflare-live-webhook: an authentic body that is not a live-input notification — ignored");
    return NextResponse.json({ ignored: true });
  }
  const n = parsed.notification;
  try {
    const r = await recordLiveNotification(n, new Date());
    if (r.outcome === "unknown_input") {
      log.debug({ inputUid: n.inputUid, event: n.event }, "cloudflare-live-webhook: an input this deployment does not own — ignored");
    } else {
      // One line per handled event: the input, the event, the session and the outcome only, never a header, the body or the secret.
      // Task 45: `edge` when the event raised the session's phone-live edge counter (a camera re-connection nudging the relay).
      log.info({ inputUid: n.inputUid, event: n.event, sessionId: "sessionId" in r ? r.sessionId : null, outcome: r.outcome,
        ...(r.outcome === "recorded" && r.edge !== undefined ? { edge: r.edge } : {}) }, "cloudflare-live-webhook: notification handled");
    }
    return NextResponse.json({ received: true, outcome: r.outcome });
  } catch (err) {
    // The class and the event's own ids only: never the error's message (a driver's text may carry anything), the body or a header.
    log.error({ errClass: errClass(err), inputUid: n.inputUid, event: n.event }, "cloudflare-live-webhook: recording the notification failed");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
