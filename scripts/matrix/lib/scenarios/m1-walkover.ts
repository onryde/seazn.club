// M1: seed 1's first opponent does not turn up. The walkover is recorded for
// seed 1 and, in a bracket, seed 1 goes on. Canary: expect the ABSENT side.
import { winnerOf } from "../observed.ts";
import { assertion, builtAsPosted, foldParity, loopBounded, resultsAsPosted, stageCompleted } from "./assertions.ts";
import { Recorder, decideFixture, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

const ENTRANTS = 8;
const BRACKETS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

interface Target { id: string; absent: string; round: number }

export const m1Walkover: Scenario = {
  key: "M1",
  entrantCount: ENTRANTS,
  canaryCheck: "m1-walkover-recorded",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, ENTRANTS);
    const seed1 = setup.idOfSeed(1);
    let target: Target | null = null;
    await playStage(ctx, rec, setup, {
      beforeRound: async (round, batch) => {
        if (target !== null) return;
        const f = batch.find((x) => x.home_entrant_id === seed1 || x.away_entrant_id === seed1);
        if (f === undefined) return;
        const absentSide = f.home_entrant_id === seed1 ? "away" : "home";
        target = { id: f.id, absent: absentSide === "home" ? f.home_entrant_id! : f.away_entrant_id!, round };
        // The fixture stays in this round's batch; decideFixture then finds it
        // finished and leaves it alone.
        await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: absentSide, reason: "walkover" });
      },
    });
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const t = target as Target | null;
    const fx = t === null ? undefined : observed.stages[0].fixtures.find((f) => f.id === t.id);
    // The canary asserts the deliberately WRONG winner (the absent side).
    const expected = ctx.spec.canary && t !== null ? t.absent : seed1;
    return {
      observed,
      events: rec.events,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        assertion("m1-walkover-recorded", fx === undefined ? [{ ok: false, note: "no round fixture seated seed 1" }] : [
          { ok: fx.status === "forfeited", note: `status ${fx.status}, expected forfeited` },
          { ok: winnerOf(fx.outcome) === expected, note: `winner ${winnerOf(fx.outcome)}, expected ${expected}` },
        ]),
        assertion("m1-winner-progresses",
          [{ ok: t !== null && observed.stages[0].fixtures.some((f) => (f.roundNo ?? 0) > t.round && (f.home === seed1 || f.away === seed1)), note: "seed 1 absent from every later round" }],
          BRACKETS.has(setup.stage.kind) ? null : "not a bracket stage"),
        stageCompleted(observed),
        loopBounded(rec, observed),
      ],
    };
  },
};
