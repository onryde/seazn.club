// W1-driving Task 7 (D8, ruling 52): a ladder stage is driven through
// challenges (POST /stages/:id/challenges), never through generate — its
// generator creates nothing (usecases/stages.ts ladder gen is []), so the
// generate loop would read "drained" over an unplayed stage.
//
// D8: one bottom-up sweep of adjacent upward challenges. Adjacent means every
// challenge is legal under any challengeRange ≥ 1, and swap vs leapfrog give
// the same order — so the expected order needs no ladder rulebook (W7's).
import { RefusedCall, type ChallengeOut, type StageRef } from "../driver/types.ts";
import type { RequestedOutcome } from "../streams/types.ts";
import { decideFixture, stageDrawsOk, type DivisionSetup, type Recorder, type RoundHook } from "./common.ts";
import type { ScenarioContext } from "./types.ts";

export interface LadderStep {
  readonly step: number;
  readonly challengerIdx: number;
  readonly opponentIdx: number;
  readonly challengerWins: boolean;
}

/** For a field of n: n − 1 challenges. Step k (1-based) has the entrant at
 *  index n − k challenge the one at n − k − 1; the challenger wins on odd
 *  steps. The bound is the field, never a literal. */
export function ladderSchedule(n: number): readonly LadderStep[] {
  return Array.from({ length: Math.max(0, n - 1) }, (_, j) => {
    const step = j + 1;
    return { step, challengerIdx: n - step, opponentIdx: n - step - 1, challengerWins: step % 2 === 1 };
  });
}

/** What the harness posts on one step. A step the challenger loses moves
 *  nobody whether it is the opponent's win or a draw (usecases/scoring.ts
 *  swaps only on a decided WIN: fed-seats.ts advancingSides gives a loser
 *  only for `win`), so where the engine declares a draw reachable on this
 *  stage (supportsDraws) the FIRST such step is a draw — life-draw-path-
 *  exercised's R9 path — and the order D8 expects is unchanged by it. */
function stepOutcome(c: LadderStep, challengerHome: boolean, drawOk: boolean, drawn: boolean): RequestedOutcome {
  if (!c.challengerWins && drawOk && !drawn) return { kind: "draw" };
  return { kind: "win", winner: c.challengerWins === challengerHome ? "home" : "away" };
}

export async function playLadder(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook }): Promise<void> {
  const track = rec.track(stage.id);
  const plan = ladderSchedule(setup.entrants.length); // bound = field size − 1, derived
  if (plan.length === 0) {
    track.exit = rec.exit = "refused_challenge";
    rec.notes.push("ladder: a field of < 2 has no challenge");
    return;
  }
  const drawOk = stageDrawsOk(ctx, stage);
  // A draw this stage POSTED (decideFixture counts it), not one merely asked for: a hook may finish the fixture first.
  const drawsBefore = rec.drawsPosted;
  // Until the first challenge writes ladder_order: the entrants addEntrants
  // answered, in seed order (the product initialises it by seed).
  let order: readonly string[] = setup.entrants.map((e) => e.id);
  for (const c of plan) {
    const live = order.filter((e) => !rec.withdrawn.has(e));
    const idx = live.length - c.step; // the same walk, over the live order
    if (idx < 1) break; // a withdrawal shortened the ladder
    const challenger = live[idx];
    const opponent = live[idx - 1];
    let out: ChallengeOut;
    try {
      out = await ctx.driver.challenge(stage.id, challenger, opponent);
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      rec.notes.push(`ladder step ${c.step}: challenge refused ${e.status} ${e.code ?? "(no code)"}`);
      track.exit = rec.exit = "refused_challenge";
      return;
    }
    rec.ladderSteps.push({ step: c.step, fixtureId: out.fixture_id });
    const f = (await ctx.driver.listFixtures(setup.division.id)).find((x) => x.id === out.fixture_id);
    if (f === undefined) throw new Error(`ladder: challenge answered fixture ${out.fixture_id}, which the division list does not hold`);
    await hooks.beforeRound?.(c.step, [f]);
    await decideFixture(ctx, rec, setup, f, stepOutcome(c, f.home_entrant_id === challenger, drawOk, rec.drawsPosted > drawsBefore), stage);
    await hooks.afterRound?.(c.step, [f]);
    // The live order is the stage's, re-read after the result lands: the
    // challenge's own answer is the order at ISSUE, before this swap.
    const listed = (await ctx.driver.listStages(setup.division.id)).find((s) => s.id === stage.id)?.config.ladder_order;
    order = Array.isArray(listed) ? (listed as string[]) : out.ladder_order;
  }
  track.exit = rec.exit = "drained";
}
