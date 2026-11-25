import "server-only";
// server/usecases/stream-credits-tab.ts — the view model of Settings → Credits → Streaming, the match-credit twin of
// credits-tab.ts (the AI wallet's). A READ over the same ledger the fixture page's Phone tab reads, through the same
// authorities, so the two screens cannot disagree about a number:
//   * the balance and its split — `relayCredits` (usecases/stream-sessions/panel-reads.ts), the Phone tab's own reader, which also GRANTS
//     this month's free credits before it reads (idempotent), so an org that has never opened a fixture's Stream panel
//     still sees the credits its plan gives it;
//   * whether Stream is on at all — `relayOffer` (stream-panel-context.ts), the ONE decision the fixture panel and the
//     Directory ask. A deployment that cannot stream, or a plan an override switched off, shows its credits and its
//     history but offers no purchase, and — as the panel does — WRITES nothing: that read grants, and a relay-less
//     deployment has no business granting;
//   * the history — `listStreamCreditHistory` (the organiser-facing reader).
//
// Online Chess (spec 2026-11-23 §7.6, §8.4, §8.8): the credits are ONE pool, so a club that plays chess online and does not stream still
// buys and holds them here. The offer is "on" when streaming is offered OR Online Chess is (`resolveStreamCreditsOffer`, the one
// authority the tab and the Settings rail both ask); the tab then grants the month and offers packs exactly as it does for streaming.
//
// "N of M free used this month" is derived from the ledger, like the AI meter: there is no counter to drift.
//   N  the free (monthly-bucket) consumes dated in this UTC month, NET of the refunds written against those same
//      sessions (R2008's credit-back, a staff refund linked to the match) — a refunded match is not a free credit used —
//      and of the refunds written against the same PACKAGE (a move down, a full refund of an Online Chess division): a
//      package's rows carry no session, so they net by `online_package_id`, bounded by that package's own consumes;
//   M  what this month was granted, or the plan's allowance if that is higher (a read made before the grant landed):
//      after a mid-month downgrade the org still holds — and may spend — what the richer plan granted, and a meter
//      that capped at the new, smaller allowance would read "3 of 1".
import { sql } from "@/lib/db";
import { utcMonthStart } from "@/lib/credits";
import { relayOffer } from "@/server/stream-panel-context";
import { onlineChessOffered } from "@/server/usecases/external-play/online-chess-flag";
import type { AuthCtx } from "@/server/api-v1/auth";
import { creditBreakdown, projectMonthlyRollDelta, streamMonthlyRate } from "@/server/usecases/stream-credits";
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

/** The tab's offer state from `relayOffer`'s facts — and, when Online Chess is offered to the org, `on` whatever phone streaming says
 *  (§7.6: the credits are one pool, the checkout sells them to such a club). ONE authority, so the rail's projection asks the same
 *  question that decides whether the tab grants. */
export function streamCreditsOffer(
  f: { entitled: boolean; relayEntitled: boolean; relayDisabled: boolean },
  onlineChess = false,
): StreamCreditsOffer {
  if (onlineChess) return "on";
  return f.relayDisabled ? "unavailable" : f.entitled && f.relayEntitled ? "on" : "notIncluded";
}

/** The offer for an org: streaming's answer, and the Online Chess flag asked only when streaming does not already admit (no PostHog
 *  call for a club that streams). The flag is asked for the ORG, never a person: the Settings rail has no person to name, and a
 *  tab and a rail that asked differently could print two numbers for one balance (the flag is org-targeted, online-chess-flag.ts). */
async function resolveStreamCreditsOffer(orgId: string): Promise<StreamCreditsOffer> {
  const facts = await relayOffer(orgId);
  const offer = streamCreditsOffer(facts);
  return offer === "on" ? offer : streamCreditsOffer(facts, await onlineChessOffered({ orgId, userId: null }));
}

/** The Streaming credits total the tab WILL show — the ledger as it stands plus what the tab's own grant would add
 *  (or minus last month's expiring leftover) — computed WITHOUT writing. For the Settings rail, so its number equals the
 *  tab's on the first visit of a month. Offer not "on" ⇒ the tab never grants ⇒ no projection. Throws like its reads;
 *  the caller is best-effort. */
export async function projectedStreamCreditsTotal(orgId: string, now: Date = new Date()): Promise<number> {
  const split = await creditBreakdown(sql, orgId);
  if ((await resolveStreamCreditsOffer(orgId)) !== "on") return split.total;
  // As `relayCredits` does when its grant fails (a corrupt ledger's `ledger_negative`, a lock or plan read): answer the
  // ungranted total rather than lose the rail. The projection is display-only, so it is not reported either.
  try {
    return split.total + (await projectMonthlyRollDelta(sql, orgId, await streamMonthlyRate(orgId, { quiet: true }), split, now));
  } catch {
    return split.total;
  }
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

  const offer = await resolveStreamCreditsOffer(orgId);

  // The split, and — only with Stream on — the plan's allowance (this read grants the month's credits first).
  const credits =
    offer === "on"
      ? await relayCredits(auth, orgId).then((c) => ({ split: c, allowance: c.monthlyAllowance }))
      : { split: await creditBreakdown(sql, orgId), allowance: 0 };

  const [used, granted, history] = await Promise.all([
    // Two sources of free credits spent, summed. A stream's consume nets the refund written against ITS session; every other row
    // without a package (a hand-written consume has no session at all) counts as it always did. A package's rows have no session,
    // so they net per package: what it consumed from the month's credits this month, less what came back this month, never less
    // than nothing — a refund the writer allows only in the month of the consume it returns (P6), and `least` keeps a refund
    // written some other way from eating another source's credit.
    sql<{ n: number }[]>`
      select (
        coalesce((
          select sum(
            -c.delta - coalesce((
              select sum(r.delta) from org_stream_credits r
               where r.org_id = c.org_id and r.reason = 'refund' and r.bucket = 'monthly' and r.session_id = c.session_id
            ), 0)
          )
            from org_stream_credits c
           where c.org_id = ${orgId} and c.reason = 'consume' and c.bucket = 'monthly' and c.online_package_id is null
             and c.created_at >= ${periodStart}
        ), 0)
        +
        coalesce((
          select sum(p.consumed - least(p.refunded, p.consumed))
            from (
              select coalesce(-sum(delta) filter (where reason = 'consume'), 0) as consumed,
                     coalesce(sum(delta) filter (where reason = 'refund'), 0) as refunded
                from org_stream_credits
               where org_id = ${orgId} and bucket = 'monthly' and online_package_id is not null
                 and reason in ('consume', 'refund') and created_at >= ${periodStart}
               group by online_package_id
            ) p
        ), 0)
      )::int as n`,
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
