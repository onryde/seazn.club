import "server-only";
// Check-in capacity plan 1, Task 6 (spec §6.2): the RealtimeKit webhook receiver, as a usecase the public route (Task 7) wraps.
//
// ORDER, and why each step sits where it does:
//   1. headers: no `rtk-signature` / `rtk-uuid` is 401 before any key is asked for (a request with neither costs nothing).
//   2. signature, over the RAW BYTES the route read (never a decoded string), against the cached key. A refusal by a key that was
//      FETCHED FOR THIS REQUEST is 401 outright (no second ask: a forced ask inside Cloudflare's floor answers fetched:false and
//      would turn a plain forgery into a retryable 503). A refusal by a key that was served from the cache gets ONE forced refetch:
//      it verifies, or it is 401 when that key was fetched fresh and still refuses, or 503 when no fresh key could be fetched (the
//      floor, a failed fetch, or no key at all). The vendor never retries a 4xx, so a delivery signed under a just-rotated key
//      must never be answered 4xx merely because we could not look yet; it is retried after the floor and applies then.
//   3. parse (400 when the body is not a RealtimeKit event). An event we never apply (`other`) is 200 ignored before any statement.
//   4. ONE transaction: `heldMeeting` (not ours: 200 ignored and NOTHING written, not even the delivery row, so a third party who
//      holds a valid signature, which every Cloudflare customer's events carry, can never make the public route insert) -> KEY SHARE
//      on the held board's `fixtures` row (gone: the delivery is recorded and nothing else, 200 ignored; there: a fixture delete waits
//      for this commit, then V527's purge trigger removes what we wrote) -> record the delivery id (`rtk-uuid`; a repeat is 200
//      duplicate) -> apply the event under the meeting's lock. LOCK ORDER: fixture row -> delivery key -> meeting lock -> presence
//      rows. A fixture delete locks the fixture row FIRST and touches only that fixture's presence rows (its trigger), never a
//      delivery row or a meeting lock, so it can wait on a receiver but no receiver of that fixture can hold anything it needs
//      before then: no cycle. The delivery insert comes
//      BEFORE the apply so the two writers of one delivery meet on the unique key before either takes the meeting lock (no cycle
//      between two deliveries of one meeting, which take that lock in turn). A throw anywhere rolls the whole transaction back: no
//      delivery row survives a failed apply, so the vendor's retry of the same uuid applies (the route answers 500 on a throw).
import type { KeyObject } from "node:crypto";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { applyPresenceEvent, heldMeeting } from "./presence";
import { parseRealtimeKitEvent } from "./webhook-event";
import { verifyRealtimeKitSignature, webhookPublicKey } from "./webhook-signature";

export type WebhookReceipt =
  | { status: 200; outcome: "applied" | "duplicate" | "ignored" }
  | { status: 400; reason: "unparseable" }
  | { status: 401; reason: "no_signature" | "no_uuid" | "signature" }
  | { status: 503; reason: "key_unavailable" }; // no fresh key could be fetched for this request (floor or fetch failure): retry

export type WebhookDeps = {
  /** The vendor's signing key; default `webhookPublicKey`. `publicKey` (the cached KeyObject) is used to verify when present,
   *  else `key` (a served string). `fetched`: a key fetched for THIS ask, not served from the cache. */
  publicKey?: (opts: { force?: boolean }) => Promise<{ key: string; publicKey?: KeyObject; fetched: boolean }>;
  /** Test seam for a storage failure. */
  apply?: typeof applyPresenceEvent;
  /** The receipt time written to `received_at`; default the wall clock. */
  now?: Date;
};

type Key = Awaited<ReturnType<NonNullable<WebhookDeps["publicKey"]>>>;

/** The key, or null when none could be had (any throw: no key ever fetched, a malformed REALTIMEKIT_BASE_URL, ...): a 503, never a 500. */
async function askKey(getKey: NonNullable<WebhookDeps["publicKey"]>, force: boolean): Promise<Key | null> {
  try {
    return await getKey(force ? { force: true } : {});
  } catch (err) {
    log.warn({ err, force }, "realtimekit-webhook: the signing key is unavailable");
    return null;
  }
}

const verifies = (raw: string | Uint8Array, signature: string, k: Key) => verifyRealtimeKitSignature(raw, signature, k.publicKey ?? k.key);

/** Verify (refetching the key once on failure: 401 only when a key fetched for THIS request still refuses, 503 when none could be
 *  fetched), parse, then in ONE transaction: `heldMeeting` (not ours -> 200 ignored, NOTHING written, not even the delivery row),
 *  key-share the held board's fixture row, record the delivery id, apply the event (a deleted board: 200 ignored, the delivery
 *  recorded and no presence written). A storage failure throws (the route answers 500 so the vendor retries); a duplicate
 *  `rtk-uuid` is a 200 that applies nothing. An `other` event is 200 ignored and writes nothing. `rawBody` is the body's BYTES as
 *  read (a string is taken as its UTF-8 bytes); the signature is checked over them and the JSON is parsed from them. */
export async function receiveRealtimeKitWebhook(
  a: { rawBody: string | Uint8Array; signature: string | null; uuid: string | null },
  deps: WebhookDeps = {},
): Promise<WebhookReceipt> {
  if (a.signature === null || a.signature === "") return { status: 401, reason: "no_signature" };
  if (a.uuid === null || a.uuid.trim() === "") return { status: 401, reason: "no_uuid" };
  const signature = a.signature;
  const uuid = a.uuid.trim(); // stored trimmed: a padded retry of the same delivery must meet its first row
  const getKey = deps.publicKey ?? ((opts) => webhookPublicKey(opts));

  const first = await askKey(getKey, false);
  if (first === null) return { status: 503, reason: "key_unavailable" };
  if (!verifies(a.rawBody, signature, first)) {
    // A key fetched for this very request that refuses is a forgery (or a key we cannot match): 401, with no forced second ask.
    if (first.fetched) return { status: 401, reason: "signature" };
    const forced = await askKey(getKey, true);
    if (forced === null) return { status: 503, reason: "key_unavailable" };
    // A valid signature is valid whoever fetched the key (a forced ask that joined another request's fresh fetch still brings it).
    if (!verifies(a.rawBody, signature, forced)) {
      return forced.fetched ? { status: 401, reason: "signature" } : { status: 503, reason: "key_unavailable" };
    }
  }

  let ev: ReturnType<typeof parseRealtimeKitEvent>;
  try {
    const text = typeof a.rawBody === "string" ? a.rawBody : Buffer.from(a.rawBody).toString("utf8");
    // A leading BOM is not JSON (JSON.parse throws on it) yet is part of the signed bytes: strip it AFTER the signature check, so a vendor
    // body that carries one is applied, never answered with a 400 the vendor does not retry.
    ev = parseRealtimeKitEvent(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown);
  } catch {
    ev = null;
  }
  if (ev === null) return { status: 400, reason: "unparseable" };
  if (ev.kind === "other") return { status: 200, outcome: "ignored" };

  const now = deps.now ?? new Date();
  const apply = deps.apply ?? applyPresenceEvent;
  const result = await sql.begin(async (tx) => {
    const held = await heldMeeting(tx, ev.meetingId);
    if (held === null) return "foreign" as const;
    // The board must still exist, and must keep existing until we commit: KEY SHARE on its fixture row (what a foreign key would
    // take) makes a concurrent fixture delete wait for us, so its purge trigger sees every row we write. A board already deleted (its
    // meeting still held through the room the delete parked, V460) writes no presence: the delivery is recorded, nothing else.
    const [board] = await tx`select 1 from fixtures where id = ${held.fixtureId} for key share`;
    const [row] = await tx<{ rtk_uuid: string }[]>`
      insert into realtimekit_webhook_deliveries (rtk_uuid, event) values (${uuid}, ${ev.event})
      on conflict (rtk_uuid) do nothing returning rtk_uuid`;
    if (!row) return "duplicate" as const;
    if (!board) return "ignored" as const;
    return apply(tx, ev, now, held);
  });
  if (result === "foreign") {
    log.info({ meetingId: ev.meetingId }, "realtimekit-webhook: foreign meeting");
    return { status: 200, outcome: "ignored" };
  }
  return { status: 200, outcome: result };
}
