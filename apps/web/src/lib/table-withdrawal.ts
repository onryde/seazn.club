// spec 05 §5 — a table stage (league/group/swiss) decides what a withdrawal
// does from the entrant's PLAYED and PENDING fixtures: in a league or group,
// under 50% played its games are expunged (standings read as if it never
// entered), otherwise its remaining games walk over to the opponents; a Swiss
// withdrawal always walks over (owner ruling 2026-09-24). The rule itself is the engine's
// `withdrawTableEntrant`; this is the ONE reading of DB fixture rows into that
// rule's input, shared by the cascade that APPLIES it
// (server/usecases/withdrawal.ts) and the qualification builder that must know
// which way it goes (server/public-site/qualification-view.ts, ruling F1) —
// two readings could disagree about whether a departure voids results.
//
// Pure, type-only engine import, no `server-only`.
import type { TableFixture } from "@seazn/engine/competition";

/** DB statuses whose fixture counts as PLAYED when it carries a result. */
export const WITHDRAWAL_PLAYED_STATUSES: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);
/**
 * B3 fix wave (I-5; RB5-W2, RB5-W4): does this line count as one the entrant PLAYED? A played status with a result - or an
 * ABANDONED line that still carries one (a cricket no result, a football award-policy abandon): the match gave a result, so it
 * counts toward the 50 percent and an under-half withdrawal removes it with the rest. A line written since W2b D7 stores such
 * an abandon as `decided` already; this keeps a row stored in the older shape from being neither played nor pending (never
 * counted, never expunged, its points kept). An abandon with no result stays neither (X-AB-1). The ONE reading - the cascade,
 * its preview and the qualification builder all ask it.
 */
export function countsAsPlayed(f: { status: string; outcome: unknown }): boolean {
  return f.outcome !== null && (WITHDRAWAL_PLAYED_STATUSES.has(f.status) || f.status === "abandoned");
}
/** DB statuses whose fixture is still to be played. */
export const WITHDRAWAL_PENDING_STATUSES: ReadonlySet<string> = new Set(["scheduled", "in_play"]);

export interface WithdrawalFixtureRow {
  id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}

/** `withdrawTableEntrant`'s `fixtures` argument for `entrantId`, from the rows
 *  of ONE stage that seat it. The policy only counts involvement, so each
 *  played fixture carries a minimal zero delta per side. */
export function tableWithdrawalInputs(
  entrantId: string,
  mine: readonly WithdrawalFixtureRow[],
): { played: TableFixture[]; pending: { id: string; opponent: string }[] } {
  const zero = (id: string) => ({ entrantId: id, played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} });
  return {
    played: mine
      .filter(countsAsPlayed)
      .map((f) => ({
        id: f.id,
        status: "decided" as const,
        result: [zero(f.home_entrant_id ?? ""), zero(f.away_entrant_id ?? "")] as const,
      })),
    pending: mine
      .filter((f) => WITHDRAWAL_PENDING_STATUSES.has(f.status))
      .map((f) => ({
        id: f.id,
        opponent: (f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id) ?? "",
      })),
  };
}

/** W3 T15 Carry A (controller ruling 2026-11-02), widened by W4 T13 (RB4-V6, X-LL-5): the source stage kinds whose CUT
 *  a departed entrant leaves. A withdrawn or disqualified entrant is taken out of a Swiss, league or group table before
 *  its cut is read, so the next eligible entrant of that table backfills her place; the table itself keeps her row,
 *  marked departed. A knockout source has its own answer, the lucky loser in her place (RB4-V2; usecases/stage-seeding.ts
 *  `luckyLoserCut`); any other kind keeps her (setup: confirm stamps her seat a bye; on_complete: generation walks her
 *  opponent over). The ONE reading of that scope, shared by the seeding cut (usecases/stage-seeding.ts
 *  `cutEligiblePools`) and the public table's cut line (server/public-site/qualification-view.ts) — two readings could
 *  draw the line in one place and seat the knockout from another. */
export const CUT_SKIPS_DEPARTED_KINDS: ReadonlySet<string> = new Set(["swiss", "league", "group"]);

/** The tie trace a standings row carries (`StandingsRow.tieBreak` / `tieUnbroken`): `with` names the rows this one was tied with
 *  before the cascade split (or failed to split) them. Structural, so the table rows and the `stage_completed` places both fit. */
interface TieNotes {
  entrantId: string;
  rank?: number;
  tieUnbroken?: boolean;
  tieBreak?: { with: string[] };
}

/**
 * W5 T8 (RB5-W1, X-WDT-7; RB5-W5 for a disqualification): an entrant who leaves a league or group for good STAYS in its table,
 * marked, and is RANKED LAST — below everyone still competing, whatever her points (a walkover leaver who won her first
 * matches would otherwise top the table she left). Re-ranks one ranked list: the competing keep their order and their ties
 * (a rank is 1 + how many competing rows rank strictly above), and the departed follow, in their own order and ties. A list
 * with an unranked row is returned as it is (nothing to re-rank against), and so is one with nobody departed.
 *
 * W5 final fix wave (G1, review I1): the TIE NOTES move with the rows. The engine wrote them on the pre-move table, where a
 * leaver level on points with a competitor was split by a cascade step ("Tied with P1 — split on head-to-head"); once she is
 * ranked last it is her departure, not a tie-break, that places her, so a note naming her on a competing row (or one on her row
 * naming a competitor) is false on every public surface. A competing row's `tieBreak.with` loses the departed ids and the note
 * goes when nobody is left to be tied with (`tieUnbroken` is only ever written WITH a `tieBreak`, so it goes with it, and stays
 * while a partner does); a departed row carries no tie at all — the same reading `cutEligiblePools` gives the cut.
 */
export function departedRankedLast<T extends TieNotes>(rows: readonly T[], departed: (id: string) => boolean): T[] {
  if (rows.some((r) => r.rank === undefined) || !rows.some((r) => departed(r.entrantId))) return [...rows];
  const reRank = (group: readonly T[], base: number, untie: (r: T) => T): T[] =>
    [...group]
      .sort((a, b) => a.rank! - b.rank!)
      .map((r) => untie({ ...r, rank: base + 1 + group.filter((o) => o.rank! < r.rank!).length }));
  const withoutNotes = (r: T): T => {
    const { tieBreak: _tieBreak, tieUnbroken: _tieUnbroken, ...rest } = r;
    return rest as T;
  };
  const withoutDeparted = (r: T): T => {
    if (r.tieBreak === undefined) return r;
    const others = r.tieBreak.with.filter((id) => !departed(id));
    return others.length === 0 ? withoutNotes(r) : { ...r, tieBreak: { ...r.tieBreak, with: others } };
  };
  const competing = rows.filter((r) => !departed(r.entrantId));
  return [...reRank(competing, 0, withoutDeparted), ...reRank(rows.filter((r) => departed(r.entrantId)), competing.length, withoutNotes)];
}
