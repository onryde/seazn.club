import { NextResponse } from "next/server";
import { log } from "@/server/logger";
import { bunnyConfig, seaznHostedReplay } from "@/server/relay/config";
import { applyBunnyEvent } from "@/server/usecases/seazn-replay-webhook";
import { readBunnyEvent, verifyBunnySignature } from "@/server/video/bunny-webhook";
import { replayDriver } from "@/server/video/replay-driver";

// Seazn-hosted video, Phase 2 Task 27: Bunny Stream's library webhook, the primary "playable" signal for a replay copy (the move's
// 15-min poll is the backstop). PUBLIC and unauthenticated except by Bunny's signature (no session, no CSRF token: proxy.ts exempts
// /api/webhooks/ from its Origin check). Every decision is the use case's (usecases/seazn-replay-webhook.ts); this route checks the
// signature, the flag and the body's shape, and answers. Bunny redelivers anything but a 2xx (30 s, 2 m, 10 m, 30 m, 1 h, 2 h).
//
//  - The body is read as TEXT before anything parses it (the resend webhook's way): the signature is over the raw body, and
//    verifying a re-serialisation would refuse every pretty-printed delivery and accept nothing Bunny did not send.
//  - A delivery that is not Bunny's — no signature, a wrong one, another version or algorithm, or no Read-Only key configured to
//    check it against — is 401 with no detail and nothing written; one warn line names which, never a header, the body or a key.
//  - SEAZN_HOSTED_REPLAY off: 200 `{ ignored: true }`, nothing written (the poll catches up once it is on).
//  - A signed body that is not one of Bunny's events: 200 `{ ignored: true }` — a redelivery would not change it.
//  - A throw out of the use case is 500, so Bunny redelivers (the use case released the event's mark). Everything else is 200.

const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** The Read-Only key and the library this deployment's webhook checks against; null when the Bunny settings are not all there
 *  (the names of the missing ones are in the replay driver's own refusal, never needed here). */
function settings(): { readOnlyKey: string; libraryId: string } | null {
  try {
    const c = bunnyConfig();
    return { readOnlyKey: c.readOnlyKey, libraryId: c.libraryId };
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();

  const s = settings();
  const signed = s !== null && verifyBunnySignature(rawBody, {
    signature: req.headers.get("x-bunnystream-signature"),
    version: req.headers.get("x-bunnystream-signature-version"),
    algorithm: req.headers.get("x-bunnystream-signature-algorithm"),
  }, s.readOnlyKey);
  if (!signed) {
    log.warn({ reason: s === null ? "no_key_configured" : "signature" }, "bunny-webhook: delivery refused");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let ev;
  try {
    if (!seaznHostedReplay()) return NextResponse.json({ ignored: true });
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = undefined;
    }
    const read = readBunnyEvent(json);
    if ("fault" in read) {
      // The field's NAME (or "body"), never its value (Task 27 review m6): a format drift says which field it hit.
      log.warn({ bytes: rawBody.length, field: read.fault }, "bunny-webhook: a signed body that is not a Bunny Stream event — ignored");
      return NextResponse.json({ ignored: true });
    }
    ev = read.event;
    const outcome = await applyBunnyEvent({ libraryId: s.libraryId, replay: replayDriver() }, ev, new Date());
    // One line per handled event (Task 27 review m7: the stg runbook's check), its ids, status and outcome only: never a header,
    // the body or a key.
    log.info({ eventId: ev.eventId, videoId: ev.videoId, status: ev.status, outcome }, "bunny-webhook: event handled");
    return NextResponse.json({ received: true, outcome });
  } catch (err) {
    // The class and the event's own ids only: never the body, a header or a key.
    log.error({ errClass: errClass(err), eventId: ev?.eventId ?? null, guid: ev?.videoId ?? null, status: ev?.status ?? null }, "bunny-webhook: applying the event failed — Bunny redelivers it");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
