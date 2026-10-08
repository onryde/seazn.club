// W1-driving Task 7 (D8, ruling 52): a ladder stage is driven through
// challenges (POST /stages/:id/challenges), never through generate — its
// generator creates nothing (usecases/stages.ts ladder gen is []), so the
// generate loop would read "drained" over an unplayed stage.
//
// D8: one bottom-up sweep of adjacent upward challenges. Adjacent means every
// challenge is legal under any challengeRange ≥ 1, and swap vs leapfrog give
// the same order — so the expected order needs no ladder rulebook (W7's).
import { RefusedCall, type ChallengeOut, type StageRef } from "../driver/types.ts";
import type { RequestedOutcome, Side } from "../streams/types.ts";
import { decideFixture, hardPath, type DivisionSetup, type Recorder, type RoundHook } from "./common.ts";
import { stageCfg } from "../sport-cfg.ts";
import type { StageKind } from "@seazn/engine/core";
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

/** What the harness posts on one step. A step the challenger loses moves nobody whether it is the opponent's win or a
 *  draw (usecases/scoring.ts swaps only on a decided WIN: fed-seats.ts advancingSides gives a loser only for `win`).
 *  W2a: a ladder is a BRACKET kind (X-DR-1), so a draw is no longer posted here — a level result is held, and closed by
 *  an organiser settle. So the FIRST step (a climb: the settle gives the challenger the win, who swaps) and the FIRST
 *  non-climbing step (the settle gives the opponent the win, so nobody moves) each ask for the hard path
 *  (common.ts hardPath: a tie-break for chess, else a settle after a level result or an abandon). The order D8 expects is
 *  unchanged: the winner of each step is the one the plain win would have named. `hard` is how many hard paths this stage
 *  has asked for so far. */
function stepOutcome(c: LadderStep, challengerHome: boolean, hard: number, firstLoss: boolean, sport: string, cfg: unknown): RequestedOutcome {
  const winner: Side = c.challengerWins === challengerHome ? "home" : "away";
  if (c.step === 1 || firstLoss) return hardPath(sport, cfg, hard, winner);
  return { kind: "win", winner };
}

export async function playLadder(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook }): Promise<void> {
  const track = rec.track(stage.id);
  const plan = ladderSchedule(setup.entrants.length); // bound = field size − 1, derived
  if (plan.length === 0) {
    track.exit = rec.exit = "refused_challenge";
    rec.notes.push("ladder: a field of < 2 has no challenge");
    return;
  }
  const cfg = stageCfg(ctx.spec.sport, ctx.cfg, stage.kind as StageKind); // the cfg the product folds a ladder fixture under
  let hard = 0; // hard-path requests this stage has made (rotates the settle method / tie-break rung)
  let lossAsked = false; // the first non-climbing step asks for the hard path once
  // Until the first challenge writes ladder_order: the entrants addEntrants
  // answered, SORTED by seed (the product initialises it by seed; the answer's
  // own row order is not relied on — review m-6).
  let order: readonly string[] = [...setup.entrants].sort((a, b) => setup.seedOf(a.id) - setup.seedOf(b.id)).map((e) => e.id);
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
    const outcome = stepOutcome(c, f.home_entrant_id === challenger, hard, !c.challengerWins && !lossAsked, ctx.spec.sport, cfg);
    if (outcome.kind !== "win") { hard++; if (!c.challengerWins) lossAsked = true; }
    await decideFixture(ctx, rec, setup, f, outcome, stage);
    await hooks.afterRound?.(c.step, [f]);
    // The live order is the stage's, re-read after the result lands: the
    // challenge's own answer is the order at ISSUE, before this swap.
    const listed = (await ctx.driver.listStages(setup.division.id)).find((s) => s.id === stage.id)?.config.ladder_order;
    order = Array.isArray(listed) ? (listed as string[]) : out.ladder_order;
  }
  track.exit = rec.exit = "drained";
}
