// W4 app B, Task 12 (X-CH-4, X-CH-6): is "Declare joint winners" offered on this fixture? ONE predicate - the server
// (`server/usecases/joint-winners.ts`) and the desk both read it, so the button and the refusal cannot disagree.
//
// Offered on a deciding final (`is_final`, never a third-place match, never a double-elimination reset) with BOTH finalists
// seated and no decided result: scheduled, in play (rain stopped it), abandoned awaiting the settle, or held level
// (`needs_decision`, which a cricket final held under CK-KO-1 reaches). The settle stays offered beside it where a sport's
// rules provide one (X-CH-5, X-ST-1). A final already declared (`joint_winners_at`) is no longer offered (it is undone).
//
// Client-safe: no runtime import.

/** The statuses a final can hold with no decided result. */
export const JOINT_WINNERS_OPEN_STATUSES: ReadonlySet<string> = new Set(["scheduled", "in_play", "abandoned", "needs_decision"]);

export interface JointWinnersFixture {
  is_final: boolean;
  third_place: boolean;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  joint_winners_at: string | null;
  /** A double-elimination reset (`gf-reset`): owed only when the losers' champion wins the grand final - never a final to
   *  rule on. Optional: absent reads as not conditional. */
  conditional?: boolean;
  /** The fixture's stage kind. A double-elimination grand final feeds its own reset, which a joint grand final would leave
   *  owed for good (C32, parked), so only the kinds with ONE deciding final take a ruling. Optional: absent reads as a
   *  kind that does (the desk always passes it; the server passes it from the stage row). */
  stage_kind?: string | null;
}

export function jointWinnersOffered(f: JointWinnersFixture): boolean {
  return (
    f.is_final &&
    !f.third_place &&
    f.conditional !== true &&
    f.stage_kind !== "double_elim" &&
    f.joint_winners_at === null &&
    JOINT_WINNERS_OPEN_STATUSES.has(f.status) &&
    f.home_entrant_id !== null &&
    f.away_entrant_id !== null
  );
}
