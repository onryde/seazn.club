// M1: seed 1's first opponent does not turn up. The walkover is recorded for
// seed 1 and, in a bracket, seed 1 goes on. Canary: ALSO expect the ABSENT side.
//
// W1-driving T15 (live w1drv-l3): a stepladder seats seed 1 only in its last
// game, so there the walkover IS the terminal final (the engine's own,
// ObservedStage.terminalFinals) and no later round exists — "goes on" means
// the title: seed 1 holds rank 1 in the finalRanks the product minted.
//
// W1-driving Task 8 (D14, ruling 51): on an americano stage the fixtures seat
// the PAIR entrants the product mints, never seed 1 itself, so the target is
// the first fixture whose pair entrant holds seed 1's person (entrantMembers),
// and the walkover is recorded for that pair.
import type { FixtureRow } from "../driver/types.ts";
import { fieldSizeFor } from "../field-size.ts";
import { winnerOf } from "../observed.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, bracketDeciderExercised, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, stageCompleted, withCanary } from "./assertions.ts";
import { Recorder, decideFixture, playDivision, setUpDivision, snapshot, type DivisionSetup } from "./common.ts";
import { BRACKET_KINDS } from "./terminal-finals.ts";
import type { Scenario } from "./types.ts";

/** The scenario's default field. The call site asks fieldSizeFor, which
 *  answers the FORMAT's field (a page playoff seeds 4; W1-driving Task 2). */
const ENTRANTS = 8;
/** Final review m-3: terminal-finals.ts's bracket table, never a second list. */
const BRACKETS: ReadonlySet<string> = new Set(BRACKET_KINDS);

/** `winner`: the side the walkover is recorded for — seed 1, or on an
 *  americano stage seed 1's pair entrant. */
interface Target { id: string; absent: string; winner: string; round: number }
/** The fixture M1 forfeits and its absent side, or null when this batch seats no target. */
type Found = { f: FixtureRow; absentSide: "home" | "away"; winner: string } | null;
/** D14: how M1 finds seed 1's fixture in a round's batch, per stage family. */
type TargetOf = (setup: DivisionSetup, batch: readonly FixtureRow[], seed1: string, members: (entrantId: string) => Promise<readonly string[]>) => Promise<Found>;

export const TARGET_OF: Readonly<Record<"default" | "americano", TargetOf>> = Object.freeze({
  /** Every kind that seats the division's own entrants: an entrant-id match. */
  default: (_setup, batch, seed1) => {
    const f = batch.find((x) => x.home_entrant_id === seed1 || x.away_entrant_id === seed1);
    return Promise.resolve(f === undefined ? null : { f, absentSide: f.home_entrant_id === seed1 ? "away" : "home", winner: seed1 });
  },
  /** Ruling 51: the first fixture whose pair entrant holds seed 1's person. */
  americano: async (setup, batch, seed1, members) => {
    const mine = setup.persons.get(seed1) ?? [];
    if (mine.length === 0) throw new Error(`scenario: M1 on an americano stage, but seed 1 (${seed1}) has no linked person — the setup reads one for every entrant (personsNeeded)`);
    for (const f of batch) {
      for (const side of ["home", "away"] as const) {
        const id = side === "home" ? f.home_entrant_id : f.away_entrant_id;
        if (id !== null && (await members(id)).some((p) => mine.includes(p))) return { f, absentSide: side === "home" ? "away" : "home", winner: id };
      }
    }
    return null;
  },
});
const targetFamily = (kind: string): keyof typeof TARGET_OF => (kind === "americano" ? "americano" : "default");

export const m1Walkover: Scenario = {
  key: "M1",
  entrantCount: ENTRANTS,
  canaryCheck: "m1-walkover-recorded",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, "M1", ctx.spec.template));
    const seed1 = setup.idOfSeed(1);
    let target: Target | null = null;
    const targetOf = TARGET_OF[targetFamily(setup.stage.kind)];
    // An entrant's persons, read once per entrant (a pair entrant recurs across rounds).
    const cache = new Map<string, Promise<readonly string[]>>();
    const members = (id: string): Promise<readonly string[]> => {
      let p = cache.get(id);
      if (p === undefined) { p = ctx.driver.entrantMembers(id).then((ms) => ms.map((m) => m.person_id)); cache.set(id, p); }
      return p;
    };
    // D12: the walkover hook runs on stage 1 only (playDivision).
    const plays = await playDivision(ctx, rec, setup, {
      beforeRound: async (round, batch) => {
        if (target !== null) return;
        const found = await targetOf(setup, batch, seed1, members);
        if (found === null) return;
        const { f, absentSide } = found;
        target = { id: f.id, absent: absentSide === "home" ? f.home_entrant_id! : f.away_entrant_id!, winner: found.winner, round };
        // The fixture stays in this round's batch; decideFixture then finds it
        // finished and leaves it alone.
        await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: absentSide, reason: "walkover" });
      },
    });
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const t = target as Target | null;
    const fx = t === null ? undefined : observed.stages[0].fixtures.find((f) => f.id === t.id);
    const s0 = observed.stages[0];
    const finalWalkover = fx?.extKey != null && (s0.terminalFinals ?? []).includes(fx.extKey);
    const rankOne = s0.complete?.finalRanks?.[0];
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
          { ok: winnerOf(fx.outcome) === t.winner, note: `winner ${winnerOf(fx.outcome)}, expected ${t.winner}` },
        ], [{ ok: winnerOf(fx.outcome) === t.absent, note: `winner ${winnerOf(fx.outcome)}, expected ${t.absent}` }], ctx.spec.canary)),
        assertion("m1-winner-progresses",
          [finalWalkover
            ? { ok: rankOne === seed1, note: `the walkover was the terminal final, but finalRanks[0] is ${rankOne ?? "(none: no finalRanks)"}, not seed 1 (${seed1})` }
            : { ok: t !== null && s0.fixtures.some((f) => (f.roundNo ?? 0) > t.round && (f.home === seed1 || f.away === seed1)), note: "seed 1 absent from every later round" }],
          BRACKETS.has(setup.stage.kind) ? null : "not a bracket stage"),
        // W2a (M-6): a bracket stage in this run owes a decider; the walkover took the first bracket fixture, the policy's
        // next hard-path slot is the fourth.
        bracketDeciderExercised(rec, observed),
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, observed, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
