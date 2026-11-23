import "server-only";
// server/usecases/online-package/reversals.ts — the two reads and the one marker the card-refund claw-back and the settle step
// share (spec 2026-11-23-online-chess-credits-design.md §7.5, review C1). A LEAF: it imports no usecase, so the claw-back
// (stream-credits.ts `recordStreamPackRefund`) and the settle step (./settle.ts, which imports stream-credits.ts) both read the
// ONE attribution without a module cycle. settle.ts re-exports the two the plan names there.
//
//  * The MARKER (`stream_pack_reversals`): a durable record THAT a pack's card payment was refunded or lost in a dispute, one row
//    per payment intent, written on EVERY matched claw-back call, even one that claws nothing. It is not a debt: the settle step
//    re-measures what is outstanding from the ledger every time. A replayed Stripe webhook meets the row already there: `on
//    conflict do nothing`, never a 500 on the primary key.
//  * The ATTRIBUTION (`netPackSpendSince`): what a pack bought at `since` has spent — bought (`pack`) credits consumed from that
//    instant on, net of the Online Chess package returns of those same credits. A package that was refunded (or moved down) is not
//    spent, so a card refund takes its returned credits, in either order (§7.5 item 1). A stream's credits stay spent: a stream
//    that ran cannot be un-delivered, and no stream refund is netted here (the claw-back has never netted them; the spec's
//    concern, and this one's, is the package).
//  * Every read here is under the caller's org money lock (`lockOrg`): the claw-back and the settle step both hold it.
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";

/** Record that the pack bought with `intent` was reversed on the card (§7.5 item 2). Idempotent by the intent: a second call for
 *  the same intent (a replayed webhook, a lost dispute after a refund) writes nothing and raises nothing. `purchased` is what the
 *  pack granted, kept beside the marker for a human walking the ledger back; the settle step reads the purchase row's own. */
export async function markReversal(tx: Tx, a: { intent: string; orgId: string; purchased: number }): Promise<void> {
  await tx`
    insert into stream_pack_reversals (stripe_payment_intent_id, org_id, purchased)
    values (${a.intent}, ${a.orgId}, ${a.purchased})
    on conflict (stripe_payment_intent_id) do nothing`;
}

/** What a pack bought at `since` has spent (§7.5): the org's bought (`pack`) consumes from `since` on (`>=`: a tie counts as spent,
 *  the claw-back's conservative direction), net of the package returns of credits that were spent from `since` on.
 *
 *  The netting is PER PACKAGE and starts from what the package already held at `since`: a package's bought returns from `since`
 *  on are first counted against the bought credits it held before `since` (they were never this pack's), and only the rest
 *  against the bought credits it drew from `since` on. So a package paid for BEFORE the pack was bought and refunded after it
 *  nets nothing here, and its returned credits are not taken to settle a later pack's reversal — the spec's "pack consumes
 *  minus pack refunds since the purchase", read without that bound, would take them (buy X, pay 16 from X, buy A, refund the
 *  package, card-refund A: 0 − 16 = −16 spent, and A's claw-back would take X's 16 too). Equal to the spec's sum whenever every
 *  package was paid after `since` (both worked examples). The bound only ever counts MORE spent, so it can only claw less.
 *
 *  Never below 0: a package never returns more than it held (`refundForPackage` refuses it), so the netted sum is at most the
 *  package consumes it nets. A negative answer is a ledger that breaks that, refused by name rather than read as unspent. */
export async function netPackSpendSince(tx: Tx, orgId: string, since: Date): Promise<number> {
  const [r] = await tx<{ consumed: number; netted: number }[]>`
    select
      (select coalesce(-sum(delta), 0)::int from org_stream_credits
        where org_id = ${orgId} and reason = 'consume' and bucket = 'pack' and created_at >= ${since}) as consumed,
      (select coalesce(sum(greatest(0, p.returned_since - p.held_before)), 0)::int
         from (select coalesce(sum(delta) filter (where reason = 'refund' and created_at >= ${since}), 0) as returned_since,
                      coalesce(-sum(delta) filter (where created_at < ${since}), 0) as held_before
                 from org_stream_credits
                where org_id = ${orgId} and bucket = 'pack' and online_package_id is not null
                group by online_package_id) p) as netted`;
  const net = r!.consumed - r!.netted;
  if (net < 0) {
    throw new HttpError(
      500,
      `Organisation ${orgId} shows ${r!.consumed} bought credits spent since ${since.toISOString()} and ${r!.netted} returned; refusing to read a negative spend`,
      "reversal_spend_negative",
    );
  }
  return net;
}

/** Credits already taken back against `intent`, IN TOTAL: the claw-back's own row (keyed `stream_pack_refund:{intent}`) and
 *  every settle row (no key), each a `revoke` carrying the intent. Org-scoped: an intent names one org's purchase. */
export async function revokedForIntent(tx: Tx, orgId: string, intent: string): Promise<number> {
  const [r] = await tx<{ revoked: number }[]>`
    select coalesce(-sum(delta), 0)::int as revoked from org_stream_credits
     where org_id = ${orgId} and reason = 'revoke' and stripe_payment_intent_id = ${intent}`;
  return r!.revoked;
}
