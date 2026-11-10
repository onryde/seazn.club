// W4 app PR B, Task 15: what the Q3 / Q4a / Q5 scripts share - their field sizes, keys, the stage readers (a final, a place) and the one
// play-out loop that decides only the lines a script lets it.
import type { FixtureRow } from "../driver/types.ts";
import type { ObservedPlace } from "../observed.ts";
import { Recorder, decideRound, seatedOpen, type DivisionSetup } from "./common.ts";
import type { StageRef } from "../driver/types.ts";
import type { ScenarioContext } from "./types.ts";
import type { Line } from "./w4a-late-entry.ts";

/** Q3's field: a bracket of eight, so the semi-finals are real and a third-place match is offered (X-TP-1: a field of four or more). */
export const Q3_FIELD = 8;
/** Q3's both-out field: four, so the semi-final sides are exactly seeds 1 v 4 and 2 v 3 and two withdrawals empty the third-place line. */
export const Q3_OUT_FIELD = 4;
/** Q4a's field: four - two semi-finals, an unplayed final, and (Play-off row) a third-place line beside it. */
export const Q4A_FIELD = 4;
/** Q5a's field: eight, a full bracket - no byes, so the plate's field (the four round-1 losers) is known the moment round 1 is decided. */
export const Q5A_FIELD = 8;
/** Q5b's field: seven, ONE bye - seed 1 holds it, so the plate's field is NOT complete after round 1 (the bye holder has not met anybody)
 *  and a round-1 loser can decline while the plate is still open (RB4-P3). */
export const Q5B_FIELD = 7;

export type Q3Key = "W4B_Q3" | "W4B_Q3_OUT";

/** The final of a bracket's lines: the line the product flags `is_final`, else the one line of the last round that is no third-place match. */
export function finalOf(lines: readonly (Line & { readonly isFinal?: boolean })[]): Line | null {
  const flagged = lines.filter((l) => l.isFinal === true && !l.thirdPlace);
  if (flagged.length === 1) return flagged[0];
  const rounds = lines.filter((l) => !l.thirdPlace).map((l) => l.round ?? 0);
  if (rounds.length === 0) return null;
  const last = Math.max(...rounds);
  const closing = lines.filter((l) => !l.thirdPlace && l.round === last);
  return closing.length === 1 ? closing[0] : null;
}

/** An entrant's place, or null when no place names them. */
export const rankOf = (places: readonly ObservedPlace[], entrantId: string): number | null => places.find((p) => p.entrantId === entrantId)?.rank ?? null;

const MAX_PASSES = 64;

/** Decide every open, seated line of `stage` that `accept` lets through, round by round (lowest round first, as playStage does), until none is
 *  left; the number of lines decided. The harness's own decision rule (decideRound) is the one every other script plays by. A pass that decides
 *  nothing new would loop forever, so the pass count is bounded and an overrun is a harness error by name. */
export async function playOut(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, accept: (f: FixtureRow) => boolean = () => true): Promise<number> {
  let decided = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const open = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && seatedOpen(f) && accept(f));
    if (open.length === 0) return decided;
    const round = Math.min(...open.map((f) => f.round_no ?? 0));
    const batch = open.filter((f) => (f.round_no ?? 0) === round);
    await decideRound(ctx, rec, setup, stage, round, batch, {});
    decided += batch.length;
  }
  throw new Error(`scenario: playOut on stage ${stage.id} still had open lines after ${MAX_PASSES} passes`);
}
