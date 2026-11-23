import "server-only";
// server/usecases/online-package/settle.ts — the settle step of a reversed pack (spec 2026-11-23-online-chess-credits-design.md
// §7.5, review C1). A card refund (or a lost dispute) of a bought pack claws back what is LEFT of it (stream-credits.ts
// `recordStreamPackRefund`). Credits it could not take because a package held them come back to the org when the package is
// refunded or moved down; this step, run on the SAME transaction right after that return and under the same money lock, takes
// them. Worked example 1 (§7.5): buy 20, pay 16, card refund (claws 4), refund the package (16 return) → settle revokes 16.
//
//  * For each reversal of the org (`stream_pack_reversals`), oldest pack first (the attribution's own FIFO):
//      outstanding = purchased − netPackSpendSince(its purchase) − already revoked for its intent;
//    revoke min(outstanding, the pack balance) when that is above 0, as a `revoke` carrying the intent and no key
//    (`revokeForReversal`). Credits genuinely spent (a stream that ran, a package that froze) stay in the net spend for good, so
//    they are never taken back, and a later pack's credits are never taken to pay for an earlier one (worked example 2).
//  * The caller holds the org money lock (`lockOrg`); this takes it again (re-entrant) so a caller that forgot cannot race.
//  * Idempotent by the attribution: a second run finds every reversal's outstanding already revoked and writes nothing.
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { creditBreakdown, lockOrg } from "@/server/usecases/stream-credits";
import { revokeForReversal } from "./ledger";
import { netPackSpendSince, revokedForIntent } from "./reversals";

export { markReversal, netPackSpendSince } from "./reversals";

/** Settle every reversed pack of the org against the ledger as it now stands; answers the credits revoked by THIS call (0 when
 *  nothing is outstanding, or the org has no reversal). On the caller's transaction, under its money lock. */
export async function settleReversals(tx: Tx, orgId: string): Promise<number> {
  await lockOrg(tx, orgId);
  // The purchase row is the attribution boundary (`findStreamPurchase`'s reading: `reason = 'purchase'`, the org's own row).
  const reversals = await tx<{ intent: string; purchased: number; purchased_at: Date | null }[]>`
    select r.stripe_payment_intent_id as intent, r.purchased,
           (select min(p.created_at) from org_stream_credits p
             where p.org_id = r.org_id and p.reason = 'purchase' and p.stripe_payment_intent_id = r.stripe_payment_intent_id) as purchased_at
      from stream_pack_reversals r
     where r.org_id = ${orgId}`;
  // Oldest pack first; an intent breaks a tie, so the order never depends on a scan.
  const ordered = [...reversals].sort((a, b) =>
    (a.purchased_at?.getTime() ?? 0) - (b.purchased_at?.getTime() ?? 0) || (a.intent < b.intent ? -1 : a.intent > b.intent ? 1 : 0));
  let revoked = 0;
  for (const r of ordered) {
    // "Cannot happen": a marker is written only by a claw-back that MATCHED a purchase row of this org.
    if (r.purchased_at === null) {
      throw new HttpError(500, `Reversed payment intent ${r.intent} has no purchase row in organisation ${orgId}; nothing was settled`, "reversal_purchase_missing");
    }
    const outstanding = r.purchased - (await netPackSpendSince(tx, orgId, r.purchased_at)) - (await revokedForIntent(tx, orgId, r.intent));
    if (outstanding <= 0) continue;
    const { pack } = await creditBreakdown(tx, orgId);
    // A named refusal, never a clamp (the claw-back's own guard): a negative pack is a corrupt ledger.
    if (pack < 0) {
      throw new HttpError(500, `This organisation's bought Seazn credit balance is ${pack}; refusing to settle against a negative ledger`, "ledger_negative");
    }
    const take = Math.min(outstanding, pack);
    if (take <= 0) continue;
    await revokeForReversal(tx, { orgId, intent: r.intent, credits: take });
    revoked += take;
  }
  return revoked;
}
