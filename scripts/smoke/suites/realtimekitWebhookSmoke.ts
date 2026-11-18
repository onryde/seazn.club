// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import postgres from "postgres";
import { BASE, check, counts, skip } from "../harness.ts";

/**
 * Check-in capacity plan 1 (Task 10a) smoke: POST /api/webhooks/realtimekit refuses an unsigned or forged delivery, against the real
 * production build. The smoke server has no REALTIMEKIT_BASE_URL, so its signing key is Cloudflare's and this suite cannot sign a
 * delivery the server accepts: the accepted path (signed -> 200 and a row, a repeated `rtk-uuid` -> 200 `duplicate`) is proven by
 * the route suite (Task 7) and over HTTP by the Task 10 walkthrough. This proves only that the public door refuses.
 *
 * Checks 4a/4b (the two DB reads) are a REGRESSION TRIPWIRE, not a proof the refusal wrote nothing: the named meeting is one no
 * fixture holds, so even an event that slipped past verification would be 200 ignored and write nothing. What they catch is a
 * future change that records a delivery or a presence row BEFORE the ownership check; the route and usecase suites carry the proof.
 *
 * Five counted checks (three with no DATABASE_URL, where the two DB reads are SKIPped, never passed): the suite throws if fewer
 * ran, so a suite that checked nothing cannot read as green.
 */
const ROUTE = "/api/webhooks/realtimekit";

async function post(headers: Record<string, string>, body: string): Promise<{ status: number; error: string | null }> {
  const res = await fetch(`${BASE}${ROUTE}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const json: unknown = await res.json().catch(() => null); // the status, and the route's own `error` text (a proxy's 401 has neither)
  const error = typeof (json as { error?: unknown } | null)?.error === "string" ? (json as { error: string }).error : null;
  return { status: res.status, error };
}

export async function realtimekitWebhookSmoke(): Promise<void> {
  const before = counts();
  const meetingId = `smoke-rtk-meeting-${randomUUID()}`; // a meeting no fixture holds
  const uuid = `smoke-rtk-uuid-${randomUUID()}`; // a delivery id nobody has used
  const body = JSON.stringify({
    event: "meeting.participantJoined",
    meeting: { id: meetingId, sessionId: "smoke-rtk-session" },
    participant: { peerId: "smoke-rtk-peer", customParticipantId: randomUUID(), joinedAt: new Date().toISOString() },
  });
  // A key pair made here and kept in memory: the server cannot hold its public half, so the signature is a forgery to it.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signature = sign("sha256", Buffer.from(body), privateKey).toString("base64");

  // 1. no signature: refused before any key is asked for.
  check("realtimekit-webhook: a delivery with no rtk-signature is refused (401)", (await post({ "rtk-uuid": uuid }, body)).status === 401);

  // 2. a signature but no delivery id.
  check("realtimekit-webhook: a signature with no rtk-uuid is refused (401)", (await post({ "rtk-signature": signature }, body)).status === 401);

  // 3. a well-formed delivery signed with a key the server does not hold: 401 when the server could fetch Cloudflare's key and it
  //    refused this signature, 503 when it could not fetch one (CI's network, or the refetch floor). Exactly those two: a 200
  //    (accepted) or a 500 (a crash) fails, as does a 400 or anything else. The 401 must be the ROUTE's (its body says "Invalid
  //    signature"): a 401 from a proxy or a WAF in front of it is not this check's evidence.
  const forged = await post({ "rtk-signature": signature, "rtk-uuid": uuid }, body);
  check(
    `realtimekit-webhook: a delivery signed with a foreign key is refused (the route's 401 "Invalid signature", or 503 when no key could be fetched; got ${forged.status} ${forged.error ?? "(no error body)"})`,
    (forged.status === 401 && forged.error === "Invalid signature") || forged.status === 503,
  );

  // 4. a regression tripwire (see the header): no delivery row for THIS uuid and no presence row for THIS meeting (never a table-wide
  //    count: another suite, or a live fixture on a shared DB, may legitimately have rows). Vacuous for a forged signature on its own.
  const url = process.env.DATABASE_URL;
  if (!url) {
    skip("realtimekit-webhook: no delivery row was written for the refused uuid (tripwire; no DATABASE_URL)");
    skip("realtimekit-webhook: no presence row was written for the named meeting (tripwire; no DATABASE_URL)");
  } else {
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const db = postgres(url, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
      prepare: !url.includes(":6543"),
      max: 1,
    });
    try {
      // Both tables are sealed (RLS forced, no grant): the smoke's DATABASE_URL is the privileged role that reads them.
      const [deliveries] = await db<{ n: number }[]>`select count(*)::int as n from realtimekit_webhook_deliveries where rtk_uuid = ${uuid}`;
      check("realtimekit-webhook: no delivery row was written for the refused uuid (tripwire)", deliveries?.n === 0);
      const [presence] = await db<{ n: number }[]>`select count(*)::int as n from fixture_video_presence where meeting_id = ${meetingId}`;
      check("realtimekit-webhook: no presence row was written for the named meeting (tripwire)", presence?.n === 0);
    } finally {
      await db.end();
    }
  }

  const after = counts();
  const ran = after.pass + after.fail - (before.pass + before.fail);
  const skipped = after.skipped - before.skipped;
  const expected = url ? 5 : 3;
  if (ran !== expected || skipped !== (url ? 0 : 2)) {
    throw new Error(`realtimekit-webhook: expected ${expected} checks run (and ${url ? 0 : 2} skipped), got ${ran} run and ${skipped} skipped`);
  }
}
