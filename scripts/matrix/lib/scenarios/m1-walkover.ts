// M1: seed 1's first opponent does not turn up. The walkover is recorded for
// seed 1 and, in a bracket, seed 1 goes on. Canary: ALSO expect the ABSENT side.
import { fieldSizeFor } from "../field-size.ts";
import { winnerOf } from "../observed.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, withCanary } from "./assertions.ts";
import { Recorder, decideFixture, playDivision, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

/** The scenario's default field. The call site asks fieldSizeFor, which
 *  answers the FORMAT's field (a page playoff seeds 4; W1-driving Task 2). */
const ENTRANTS = 8;
const BRACKETS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

interface Target { id: string; absent: string; round: number }

export const m1Walkover: Scenario = {
  key: "M1",
  entrantCount: ENTRANTS,
  canaryCheck: "m1-walkover-recorded",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, "M1"));
    const seed1 = setup.idOfSeed(1);
    let target: Target | null = null;
    // D12: the walkover hook runs on stage 1 only (playDivision).
    const plays = await playDivision(ctx, rec, setup, {
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
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const t = target as Target | null;
    const fx = t === null ? undefined : observed.stages[0].fixtures.find((f) => f.id === t.id);
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        // The canary adds the deliberately WRONG winner (the absent side) after the right one (m-1).
        assertion("m1-walkover-recorded", fx === undefined || t === null ? [{ ok: false, note: "no round fixture seated seed 1" }] : withCanary([
          { ok: fx.status === "forfeited", note: `status ${fx.status}, expected forfeited` },
          { ok: winnerOf(fx.outcome) === seed1, note: `winner ${winnerOf(fx.outcome)}, expected ${seed1}` },
        ], [{ ok: winnerOf(fx.outcome) === t.absent, note: `winner ${winnerOf(fx.outcome)}, expected ${t.absent}` }], ctx.spec.canary)),
        assertion("m1-winner-progresses",
          [{ ok: t !== null && observed.stages[0].fixtures.some((f) => (f.roundNo ?? 0) > t.round && (f.home === seed1 || f.away === seed1)), note: "seed 1 absent from every later round" }],
          BRACKETS.has(setup.stage.kind) ? null : "not a bracket stage"),
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, observed, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
