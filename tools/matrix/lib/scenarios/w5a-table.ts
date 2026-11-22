// W5 app PR A (Task 24): what the round-robin scripts read of a TABLE stage - its lines with their pool, and the drive-through helpers every
// script shares (decide one line, finish the run). Pure where it can be; the rest is the OrganiserDriver's acts, as w4a-late-entry.ts's are.
import { DriverMisuse, RefusedCall, type FixtureRow, type OrganiserDriver, type StagePoolsOut } from "../driver/types.ts";
import { advanceRoundOneCrossesPools, advanceSeededAsDeclared } from "./advance.ts";
import { builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted } from "./assertions.ts";
import { Recorder, playDivision, snapshot, type DivisionSetup, type StagePlay } from "./common.ts";
import { snap, toObservedOutcome, type ObservedRun, type WithdrawalObs } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import { lineOf, type Line } from "./w4a-late-entry.ts";
import type { ScenarioContext, ScenarioOutput } from "./types.ts";

/** A line of a table stage as the scripts read it: seats, status and result (`Line`), plus the pool it sits in (null: a league). */
export interface TLine extends Line { readonly poolId: string | null }
export const tLineOf = (f: FixtureRow): TLine => ({ ...lineOf(f), poolId: f.pool_id });

/** The stage's lines, as the product lists them now. */
export const stageLines = async (ctx: ScenarioContext, setup: DivisionSetup, stageId: string): Promise<TLine[]> =>
  (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stageId).map(tLineOf);

/** The entrants a set of lines seats. */
export const seatsOf = (lines: readonly TLine[]): Set<string> => new Set(lines.flatMap((l) => [l.home, l.away]).filter((e): e is string => e !== null));

/** Lines by pool id (the league's one pool is the key null), in the order the pools first appear. */
export function byPool(lines: readonly TLine[]): Map<string | null, TLine[]> {
  const out = new Map<string | null, TLine[]>();
  for (const l of lines) {
    const at = out.get(l.poolId);
    if (at === undefined) out.set(l.poolId, [l]);
    else at.push(l);
  }
  return out;
}

/** A driver that can list the pools of a stage (the HTTP driver); a layer that cannot says so by name, never reads "no pools". */
export function drivesPools(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "stagePools">> {
  return d.stagePools !== undefined;
}
export async function poolsOf(ctx: ScenarioContext, stageId: string): Promise<StagePoolsOut> {
  const d = ctx.driver;
  if (!drivesPools(d)) throw new DriverMisuse("driver: this W5A script needs stagePools - the HTTP driver has it, a layer that does not drive the path says so");
  return d.stagePools(stageId);
}

/** A scripted driver call the product may refuse: the refusal is the run's finding, so it is returned, never thrown. */
export async function attempt<T>(rec: Recorder, what: string, call: () => Promise<T>): Promise<T | RefusedCall> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    rec.notes.push(`${what} refused ${e.status} ${e.code ?? "(no code)"}`);
    return e;
  }
}

/** The shared tail: play the division out (the standard loop) and judge the run by the standard life checks beside the script's own, which is
 *  read AFTER the play (`ownOf`: a script whose evidence is the advance or the final table needs the plays). */
export async function finishRun(
  ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup,
  ownOf: (plays: readonly StagePlay[], observed: ObservedRun) => readonly CheckResult[] | Promise<readonly CheckResult[]>,
  hooks: Parameters<typeof playDivision>[3] = {},
  withdrawal: WithdrawalObs | null | (() => WithdrawalObs | null) = null,
): Promise<ScenarioOutput> {
  const plays = await playDivision(ctx, rec, setup, hooks);
  const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: typeof withdrawal === "function" ? withdrawal() : withdrawal });
  const own = await ownOf(plays, observed);
  return {
    observed,
    events: rec.events,
    notes: rec.notes,
    assertions: [builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed), ...own, stageCompleted(observed), loopBounded(rec, observed), advanceSeededAsDeclared(plays, observed, rec.withdrawn), advanceRoundOneCrossesPools(plays, observed), lineupsPut(rec, setup)],
  };
}

/** The withdrawal a script performed, as the invariants read it (WithdrawalObs): the entrant's lines as they stood immediately before the call. Also
 *  records the facts every R4 withdrawal records, so the standard checks judge the cascade and not the harness's own posts on the entrant's lines. */
export async function withdrawEntrant(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, entrantId: string, afterRound: number): Promise<{ answer: Awaited<ReturnType<OrganiserDriver["withdraw"]>>; obs: WithdrawalObs }> {
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === setup.stage.id && (f.home_entrant_id === entrantId || f.away_entrant_id === entrantId));
  const before = rows.map((f) => snap({ id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome), declared: null }));
  const answer = await ctx.driver.withdraw(entrantId);
  rec.facts.add("withdrawn");
  rec.withdrawn.add(entrantId);
  if (answer.policy === "expunge") rec.facts.add("expunged");
  return { answer, obs: { entrantId, afterRound, policy: answer.policy, walkovers: answer.walkovers, voided: answer.voided, skippedCancelled: answer.skipped_cancelled, before } };
}
