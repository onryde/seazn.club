// W2b Task 12 (spec §5.5 "Copy") — WHICH forfeit a `core.forfeit` payload records, for the surfaces that put it into
// words: the pad's ribbon and activity rows (ribbon.ts), the event copy (event-copy.ts) and the public timeline
// (server/public-site/timeline.ts). One reader, so the three cannot disagree about what a payload says.
//
// The kinds are the engine's award reasons plus a double walkover (D3: a forfeit "by both" is a double walkover, and
// its reason is always "walkover"). A bye is written with no event (stages.ts, fixture-bye.ts, fed-seats.ts) and
// `CoreForfeit` refuses reason "bye", so no ledger row carries one today; it is a kind because the vocabulary is total
// over `AWARD_REASONS`, not because a row renders it.
import { AWARD_REASONS, type AwardReason } from "@seazn/engine/core";

export type ForfeitCopyKind = AwardReason | "double_walkover";

const AWARD: ReadonlySet<string> = new Set(AWARD_REASONS);

/** The kind a forfeit payload records; null for a payload with no reason the engine declares (a pre-D3 row), which
 *  keeps each surface's reason-free line. */
export function forfeitCopyKind(payload: Readonly<Record<string, unknown>>): ForfeitCopyKind | null {
  if (payload.by === "both") return "double_walkover";
  return typeof payload.reason === "string" && AWARD.has(payload.reason) ? (payload.reason as AwardReason) : null;
}

/** D5 / PF-4: an abandon the withdrawal cascade wrote to take the match off the table (withdrawal.ts). */
export const isExpungeAbandon = (payload: Readonly<Record<string, unknown>>): boolean => payload.expunge === true;
