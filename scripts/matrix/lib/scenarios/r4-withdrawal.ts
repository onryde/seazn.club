// R4: seed 3 withdraws after round 1. W1a asserts only that the cascade is
// CONSISTENT with the policy the engine reported; which policy SHOULD apply is
// the rulebook's call (W2+). Canary: judge the cascade against the opposite
// policy.
import { isTerminal, sameResult, snap, toObservedOutcome, winnerOf, type FixtureSnap, type ObservedFixture, type WithdrawalObs } from "../observed.ts";
import { assertion, foldParity, loopBounded, type Item } from "./assertions.ts";
import { Recorder, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

const ENTRANTS = 8;
/** withdrawal.ts applyUpdate: these are reported as skipped, never touched. */
const LOCKED = new Set(["finalized", "cancelled"]);

/** What each policy implies for the withdrawn entrant's fixtures
 *  (withdrawal.ts:1-17 and 130-200, engine stage.ts withdrawTableEntrant):
 *  - expunge: every fixture it touched is abandoned, except locked ones;
 *  - walkover: each pending fixture is forfeited to the OPPONENT, or voided
 *    (abandoned) when that seat is still TBD; finished ones stand;
 *  and the reported walkover count equals the forfeits observed, and the
 *  reported voided count equals the fixtures the cascade itself abandoned
 *  (withdrawal.ts applyUpdate counts `voided` once per core.abandon it posts,
 *  so a fixture already abandoned before the withdrawal is not one of them). */
export function cascadeItems(policy: WithdrawalObs["policy"], w: string, before: readonly FixtureSnap[], after: readonly ObservedFixture[], walkoversReported: number, voidedReported: number): Item[] {
  const items: Item[] = [];
  let forfeitedByCascade = 0;
  let voidedByCascade = 0;
  const voids = (b: FixtureSnap, a: ObservedFixture) => { if (a.status === "abandoned" && b.status !== "abandoned") voidedByCascade++; };
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (a === undefined) { items.push({ ok: false, note: `${b.id}: vanished` }); continue; }
    if (policy === "walkover" && !isTerminal(b.status)) {
      const opponent = a.home === w ? a.away : a.home;
      if (opponent === null) {
        voids(b, a);
        items.push({ ok: a.status === "abandoned", note: `${b.id}: ${a.status} after walkover with a TBD opponent, expected abandoned` });
        continue;
      }
      const ok = a.status === "forfeited" && winnerOf(a.outcome) === opponent;
      if (ok) forfeitedByCascade++;
      items.push({ ok, note: `${b.id}: ${a.status}/${winnerOf(a.outcome)} after walkover, expected forfeited/${opponent}` });
    } else if (policy === "expunge" && !LOCKED.has(b.status)) {
      voids(b, a);
      items.push({ ok: a.status === "abandoned", note: `${b.id}: ${a.status} after expunge` });
    } else {
      items.push({ ok: sameResult(a, b), note: `${b.id}: changed ${b.status}→${a.status}` });
    }
  }
  if (policy === "walkover") items.push({ ok: forfeitedByCascade === walkoversReported, note: `reported ${walkoversReported} walkovers, observed ${forfeitedByCascade}` });
  items.push({ ok: voidedByCascade === voidedReported, note: `reported ${voidedReported} voided, observed ${voidedByCascade}` });
  return items;
}

export const r4Withdrawal: Scenario = {
  key: "R4",
  entrantCount: ENTRANTS,
  canaryCheck: "r4-cascade-consistent",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, ENTRANTS);
    const seed3 = setup.idOfSeed(3);
    let withdrawal: WithdrawalObs | null = null;
    await playStage(ctx, rec, setup, {
      afterRound: async (round) => {
        if (round !== 1 || withdrawal !== null) return;
        const before = (await ctx.driver.listFixtures(setup.division.id))
          .filter((f) => f.stage_id === setup.stage.id && (f.home_entrant_id === seed3 || f.away_entrant_id === seed3))
          .map((f) => snap({ id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome), declared: null }));
        const out = await ctx.driver.withdraw(seed3);
        rec.facts.add("withdrawn");
        if (out.policy === "expunge") rec.facts.add("expunged");
        withdrawal = { entrantId: seed3, afterRound: 1, policy: out.policy, walkovers: out.walkovers, voided: out.voided, skippedFinalized: out.skipped_finalized, before };
      },
    });
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal });
    const w = withdrawal as WithdrawalObs | null;
    if (w === null) {
      return {
        observed,
        events: rec.events,
        assertions: [foldParity(rec), assertion("r4-policy-reported", [{ ok: false, note: "round 1 never finished; nobody withdrew" }]), loopBounded(rec, observed)],
      };
    }
    const mine = observed.stages[0]!.fixtures.filter((f) => f.home === w.entrantId || f.away === w.entrantId);
    // Canary: judge the cascade against the OPPOSITE policy.
    const judged = ctx.spec.canary ? (w.policy === "walkover" ? "expunge" : "walkover") : w.policy;
    const later = observed.stages[0]!.fixtures.filter((f) => (f.roundNo ?? 0) > w.afterRound && f.home !== null && f.away !== null);
    return {
      observed,
      events: rec.events,
      assertions: [
        foldParity(rec),
        assertion("r4-policy-reported", [{ ok: w.policy !== "none", note: `policy ${w.policy} on a started division` }]),
        assertion("r4-cascade-consistent", cascadeItems(judged, w.entrantId, w.before, mine, w.walkovers, w.voided)),
        assertion("r4-not-paired-later",
          later.map((f) => ({ ok: f.home !== w.entrantId && f.away !== w.entrantId, note: `${f.id} (round ${f.roundNo}) seats the withdrawn entrant` })),
          setup.stage.kind === "swiss" ? null : "not a swiss stage"),
        loopBounded(rec, observed),
      ],
    };
  },
};
