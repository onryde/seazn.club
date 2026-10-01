// F1: an odd field of 7. Everyone is drawn, and each inspected round seats
// floor(7/2) pairs with one sit-out. Canary: also expect ceil — the answer
// that differs from the right one.
import { fieldSizeFor } from "../field-size.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, withCanary } from "./assertions.ts";
import { Recorder, playDivision, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

/** The scenario's default field. The call site asks fieldSizeFor, which
 *  answers the FORMAT's field (a page playoff seeds 4; W1-driving Task 2). */
const ENTRANTS = 7;

export const f1OddField: Scenario = {
  key: "F1",
  entrantCount: ENTRANTS,
  canaryCheck: "f1-round-size",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, "F1"));
    const plays = await playDivision(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const s = observed.stages[0];
    const n = s.field.length;
    // floor(n/2) seated pairs per round, one bye; the canary ALSO expects ceil (m-1).
    const right = Math.floor(n / 2);
    const wrong = Math.ceil(n / 2);
    const rounds = [...new Set(s.fixtures.map((f) => f.roundNo ?? 0))].sort((a, b) => a - b);
    // A knockout's later rounds hold winners only, so just its first round.
    const inspected = setup.stage.kind === "knockout" ? rounds.slice(0, 1) : rounds;
    const seatedIn = (r: number) => s.fixtures.filter((f) => (f.roundNo ?? 0) === r && f.home !== null && f.away !== null).length;
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        assertion("f1-everyone-drawn", s.field.map((e) => ({ ok: s.fixtures.some((f) => f.home === e || f.away === e), note: `${e} appears in no fixture` }))),
        assertion("f1-round-size", withCanary(
          inspected.map((r) => ({ ok: seatedIn(r) === right, note: `round ${r}: ${seatedIn(r)} seated, expected ${right}` })),
          inspected.map((r) => ({ ok: seatedIn(r) === wrong, note: `round ${r}: ${seatedIn(r)} seated, expected ${wrong}` })),
          ctx.spec.canary,
        )),
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
