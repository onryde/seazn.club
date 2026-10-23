import "server-only";
// server/usecases/stream-credits-tab.ts — the view model of Settings → Credits → Streaming, the match-credit twin of
// credits-tab.ts (the AI wallet's). A READ over the same ledger the fixture page's Phone tab reads, through the same
// authorities, so the two screens cannot disagree about a number:
//   * the balance and its split — `relayCredits` (stream-sessions.ts), the Phone tab's own reader, which also GRANTS
//     this month's free credits before it reads (idempotent), so an org that has never opened a fixture's Stream panel
//     still sees the credits its plan gives it;
//   * whether Stream is on at all — `relayOffer` (stream-panel-context.ts), the ONE decision the fixture panel and the
//     Directory ask. A deployment that cannot stream, or a plan an override switched off, shows its credits and its
//     history but offers no purchase, and — as the panel does — WRITES nothing: that read grants, and a relay-less
//     deployment has no business granting;
//   * the history — `listStreamCreditHistory` (the organiser-facing reader).
//
// "N of M free used this month" is derived from the ledger, like the AI meter: there is no counter to drift.
//   N  the free (monthly-bucket) consumes dated in this UTC month, NET of the refunds written against those same
//      sessions (R2008's credit-back, a staff refund linked to the match) — a refunded match is not a free credit used;
//   M  what this month was granted, or the plan's allowance if that is higher (a read made before the grant landed):
//      after a mid-month downgrade the org still holds — and may spend — what the richer plan granted, and a meter
//      that capped at the new, smaller allowance would read "3 of 1".
import { sql } from "@/lib/db";
import { utcMonthStart } from "@/lib/credits";
import { relayOffer } from "@/server/stream-panel-context";
import type { AuthCtx } from "@/server/api-v1/auth";
import { creditBreakdown } from "@/server/usecases/stream-credits";
import { relayCredits } from "@/server/usecases/stream-sessions";
import { daysUntilMonthReset } from "@/server/usecases/credits-tab";
import {
  assertCanReadStreamHistory, listStreamCreditHistory, type StreamHistoryPage,
} from "@/server/usecases/stream-credit-history";

/** `on` — Stream is offered here and credits can be bought. `unavailable` — this deployment cannot stream right now
 *  (no relay). `notIncluded` — the org's plan (or a staff override) switches phone streaming off. */
export type StreamCreditsOffer = "on" | "unavailable" | "notIncluded";

export interface StreamCreditsTabView {
  offer: StreamCreditsOffer;
  /** monthly + pack — `creditBalance`'s number. */
  total: number;
  /** This month's free credits still held (they expire at the end of the UTC month). */
  monthly: number;
  /** Bought packs, Event Pass and staff credits still held (they never expire). */
  pack: number;
  /** M — the free credits this month gave the org (0 when Stream is not on). */
  freeAllowance: number;
  /** N — free credits used this month, net of refunds. */
  freeUsed: number;
  /** Whole days until the month turns and unused free credits expire. */
  freeResetsInDays: number;
  history: StreamHistoryPage;
}

export async function getStreamCreditsTab(
  auth: AuthCtx,
  orgId: string,
  opts: { cursor?: string; now?: Date } = {},
): Promise<StreamCreditsTabView> {
  // First, before the offer is asked or a credit granted: a refused caller causes no read and no write.
  assertCanReadStreamHistory(auth, orgId);
  const now = opts.now ?? new Date();
  const periodStart = utcMonthStart(now);

  const offerFacts = await relayOffer(orgId);
  const offer: StreamCreditsOffer = offerFacts.relayDisabled
    ? "unavailable"
    : offerFacts.entitled && offerFacts.relayEntitled
      ? "on"
      : "notIncluded";

  // The split, and — only with Stream on — the plan's allowance (this read grants the month's credits first).
  const credits =
    offer === "on"
      ? await relayCredits(auth, orgId).then((c) => ({ split: c, allowance: c.monthlyAllowance }))
      : { split: await creditBreakdown(sql, orgId), allowance: 0 };

  const [used, granted, history] = await Promise.all([
    sql<{ n: number }[]>`
      select coalesce(sum(
        -c.delta - coalesce((
          select sum(r.delta) from org_stream_credits r
           where r.org_id = c.org_id and r.reason = 'refund' and r.bucket = 'monthly' and r.session_id = c.session_id
        ), 0)
      ), 0)::int as n
        from org_stream_credits c
       where c.org_id = ${orgId} and c.reason = 'consume' and c.bucket = 'monthly'
         and c.created_at >= ${periodStart}`,
    sql<{ n: number }[]>`
      select coalesce(sum(delta), 0)::int as n from org_stream_credits
       where org_id = ${orgId} and reason = 'grant' and bucket = 'monthly' and created_at >= ${periodStart}`,
    listStreamCreditHistory(auth, orgId, { cursor: opts.cursor }),
  ]);

  const freeAllowance = offer === "on" ? Math.max(credits.allowance, granted[0]?.n ?? 0) : 0;
  return {
    offer,
    total: credits.split.total,
    monthly: credits.split.monthly,
    pack: credits.split.pack,
    freeAllowance,
    // Clamped to [0, M]: a refund that lands after the rollover can net a month's figure below zero, and a meter never
    // reads outside its own scale.
    freeUsed: Math.max(0, Math.min(freeAllowance, used[0]?.n ?? 0)),
    freeResetsInDays: daysUntilMonthReset(periodStart, now),
    history,
  };
}
