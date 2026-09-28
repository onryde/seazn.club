// F1: an odd field of 7. Everyone is drawn, and each inspected round seats
// floor(7/2) pairs with one sit-out. Canary: expect ceil — the answer that
// differs from the right one.
import { assertion, foldParity, resultsAsPosted, loopBounded, stageCompleted } from "./assertions.ts";
import { Recorder, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

const ENTRANTS = 7;

export const f1OddField: Scenario = {
  key: "F1",
  entrantCount: ENTRANTS,
  canaryCheck: "f1-round-size",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, ENTRANTS);
    await playStage(ctx, rec, setup);
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const s = observed.stages[0];
    const n = s.field.length;
    // floor(n/2) seated pairs per round, one bye; the canary expects ceil.
    const expectedPerRound = ctx.spec.canary ? Math.ceil(n / 2) : Math.floor(n / 2);
    const rounds = [...new Set(s.fixtures.map((f) => f.roundNo ?? 0))].sort((a, b) => a - b);
    // A knockout's later rounds hold winners only, so just its first round.
    const inspected = setup.stage.kind === "knockout" ? rounds.slice(0, 1) : rounds;
    const seatedIn = (r: number) => s.fixtures.filter((f) => (f.roundNo ?? 0) === r && f.home !== null && f.away !== null).length;
    return {
      observed,
      events: rec.events,
      assertions: [
        foldParity(rec),
        resultsAsPosted(rec, observed),
        assertion("f1-everyone-drawn", s.field.map((e) => ({ ok: s.fixtures.some((f) => f.home === e || f.away === e), note: `${e} appears in no fixture` }))),
        assertion("f1-round-size", inspected.map((r) => ({ ok: seatedIn(r) === expectedPerRound, note: `round ${r}: ${seatedIn(r)} seated, expected ${expectedPerRound}` }))),
        stageCompleted(observed),
        loopBounded(rec, observed),
      ],
    };
  },
};
