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
      .filter((f) => WITHDRAWAL_PLAYED_STATUSES.has(f.status) && f.outcome !== null)
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
