// F1: an odd field of 7. Everyone is drawn, and each inspected round seats
// floor(7/2) pairs with one sit-out. Canary: also expect ceil — the answer
// that differs from the right one.
//
// On a ladder (ruling T7-R1) a "round" is one challenge and the format
// declares no rounds, so f1-round-size abstains by name there; F1 instead
// asserts the D8 sweep (W1-driving Task 7): n − 1 challenges over the
// seeded field, and every seeded entrant holding a finalRanks rung.
//
// On americano/mexicano (W1-driving Task 8, T7-R1 carry) a round seats
// pairs of PAIRS on courts: the size the engine declares comes from its own
// planner over the field (americano.ts:50, min(floor(n/4), courtCount)),
// never floor(n/2), and an entrant is drawn when its PERSON sits in a seated
// pair entrant.
import { fieldSizeFor } from "../field-size.ts";
import type { CompleteObs, ObservedFixture } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { americanoRoundSize } from "./americano-loop.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, seatsEntrant, stageCompleted, withCanary } from "./assertions.ts";
import { Recorder, playDivision, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

/** The scenario's default field. The call site asks fieldSizeFor, which
 *  answers the FORMAT's field (a page playoff seeds 4; W1-driving Task 2). */
const ENTRANTS = 7;

/** T7-R1: F1's meaning on a ladder. The D8 sweep over the seeded field
 *  issues and decides n − 1 challenges (n from the field, never a literal),
 *  and every seeded entrant holds a rung in the finalRanks the product
 *  minted (competition.ts: the raw ladder_order). Ladder only; abstains on
 *  every other kind, where f1-round-size judges the rounds. */
export function ladderSweep(kind: string, seeded: readonly string[], steps: readonly { readonly fixtureId: string }[], fixtures: readonly ObservedFixture[], complete: CompleteObs | null): CheckResult {
  const id = "f1-ladder-sweep";
  if (kind !== "ladder") return assertion(id, [], "ladder only: a challenge sweep exists on ladder stages alone");
  const n = seeded.length;
  const decided = steps.filter((s) => (fixtures.find((f) => f.id === s.fixtureId)?.outcome ?? null) !== null).length;
  const ranks = complete?.finalRanks ?? null;
  return assertion(id, [
    { ok: steps.length === n - 1, note: `${steps.length} challenge(s) issued, expected ${n - 1} (n − 1 over a seeded field of ${n})` },
    { ok: decided === n - 1, note: `${decided} challenge(s) decided, expected ${n - 1}` },
    ...seeded.map((e) => ({ ok: ranks !== null && ranks.includes(e), note: ranks === null ? `${e}: the stage minted no finalRanks` : `${e} is missing from finalRanks` })),
  ]);
}

export const f1OddField: Scenario = {
  key: "F1",
  entrantCount: ENTRANTS,
  canaryCheck: "f1-round-size",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, "F1", ctx.spec.template));
    const plays = await playDivision(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const s = observed.stages[0];
    const n = s.field.length;
    // floor(n/2) seated pairs per round, one bye; the canary ALSO expects ceil (m-1).
    // Americano: the engine's own round size; the canary ALSO expects one more court.
    const americano = setup.stage.kind === "americano";
    const courts = americano ? americanoRoundSize(setup.stage.config, n) : null;
    const right = americano ? courts ?? 0 : Math.floor(n / 2);
    const wrong = americano ? right + 1 : Math.ceil(n / 2);
    const rounds = [...new Set(s.fixtures.map((f) => f.roundNo ?? 0))].sort((a, b) => a - b);
    // A knockout's later rounds hold winners only, so just its first round.
    const inspected = setup.stage.kind === "knockout" ? rounds.slice(0, 1) : rounds;
    const seatedIn = (r: number) => s.fixtures.filter((f) => (f.roundNo ?? 0) === r && f.home !== null && f.away !== null).length;
    // T7-R1: a ladder declares no rounds — the round-size expectation has no source there (R9), so it abstains by name.
    const ladder = setup.stage.kind === "ladder";
    const seated = seatsEntrant(s);
    const sizeAbstain = ladder ? "ladder: a ladder declares no rounds (ruling T7-R1); F1 judges the challenge sweep instead (f1-ladder-sweep)"
      : americano && courts === null ? "americano: the stage declares no courtCount, so the engine's round size hangs on the live player count (stages.ts:757-758)"
      : null;
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        assertion("f1-everyone-drawn", s.field.map((e) => ({ ok: seated(e), note: `${e} appears in no fixture${americano ? " (its person sits in no seated pair entrant)" : ""}` }))),
        assertion("f1-round-size", sizeAbstain !== null ? [] : withCanary(
          inspected.map((r) => ({ ok: seatedIn(r) === right, note: `round ${r}: ${seatedIn(r)} seated, expected ${right}${americano ? " (the engine's round over the field)" : ""}` })),
          inspected.map((r) => ({ ok: seatedIn(r) === wrong, note: `round ${r}: ${seatedIn(r)} seated, expected ${wrong}` })),
          ctx.spec.canary,
        ), sizeAbstain),
        ladderSweep(setup.stage.kind, [...setup.entrants].sort((a, b) => setup.seedOf(a.id) - setup.seedOf(b.id)).map((e) => e.id), rec.ladderSteps, s.fixtures, s.complete),
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, observed, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
