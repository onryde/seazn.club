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
//
// On a bracket (W1-driving T15, live w1drv-l3) later rounds hold winners
// (and a double elim's losers), so only the FIRST round is judged, at the
// size the engine's own generator opens with over the field: a stepladder
// opens with ONE game, a knockout or a double elim with one board per
// two-sided line of the next power of two. floor(n/2) on every round redded
// all 22 stepladder and double-elim F1 cases. The generators are
// terminal-finals.ts's table, called with the stage's config (T15-R8 m-4);
// a field the engine refuses is a named abstain, never a throw (m-3).
import { EngineError } from "@seazn/engine/core";
import { RefusedCall, SetupRefused } from "../driver/types.ts";
import { fieldSizeFor } from "../field-size.ts";
import type { CompleteObs, ObservedFixture } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { americanoRoundSize } from "./americano-loop.ts";
import { assertion, type Item, bracketDeciderExercised, builtAsPosted, foldParity, lineupsPut, loopBounded, resultsAsPosted, seatsEntrant, stageCompleted, withCanary } from "./assertions.ts";
import { Recorder, playDivision, setUpDivision, snapshot } from "./common.ts";
import { BRACKET_OF } from "./terminal-finals.ts";
import { stagesForRow } from "../catalogue.ts";
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

/** A bracket's opening round: the boards it seats, or the engine's refusal to lay the field out at all. */
export type FirstRound = { readonly boards: number } | { readonly refused: string };

/** The boards a bracket's first round seats over `field`: the engine's
 *  round-0 fixtures with BOTH sides concrete (a bye line is one awarded
 *  side), drawn by terminal-finals.ts's BRACKET_OF with the stage's config
 *  as the product's Start passes it. null on a kind with no bracket
 *  generator — every round of those is judged instead. A field or config
 *  the engine refuses (a page playoff of anything but 4) is `refused`, named:
 *  the product's Start refuses it too, so there is no first round to judge. */
export function bracketFirstRound(kind: string, field: readonly string[], config: Record<string, unknown>): FirstRound | null {
  const generate = BRACKET_OF[kind];
  if (generate === undefined) return null;
  let fixtures;
  try {
    fixtures = generate(field, config).fixtures;
  } catch (e) {
    if (!EngineError.is(e)) throw e;
    return { refused: `${kind}: the engine refuses to lay out a field of ${field.length} (${e.code}: ${e.message}) — the product's own Start refuses it too, so there is no first round to judge` };
  }
  const first = Math.min(...fixtures.map((f) => f.round));
  return { boards: fixtures.filter((f) => f.round === first && f.home !== undefined && f.away !== undefined).length };
}

/** W5 T12 (X-BD-1, ST-G5, R12): the refusal a row's FIRST stage owes `entrants`, from its posted body, or null when the field fits.
 *  The rule is the product's stated one - each group needs at least 2, so a seeded snake of `entrants` into `groups` pools leaves a pool of
 *  floor(entrants / groups) - and `suggested` is the largest pool count under the ask that leaves every pool 2 strong. Typed here from the
 *  rulebook (RB5-E4), never read from the product's own gate, so a drift in either side reds the case. */
export function poolOfOneExpected(row: Parameters<typeof stagesForRow>[0], entrants: number): { groups: number; required: number; suggested: number | null } | null {
  const first = stagesForRow(row)[0];
  const pools = first?.kind === "group" ? (first.config as { pools?: { count?: unknown } } | undefined)?.pools?.count : undefined;
  if (typeof pools !== "number" || pools < 2 || Math.floor(entrants / pools) >= 2) return null;
  let suggested: number | null = null;
  for (let c = pools - 1; c >= 1 && suggested === null; c--) if (Math.floor(entrants / c) >= 2) suggested = c;
  return { groups: pools, required: pools * 2, suggested };
}

/** W5 T12b (RB5-E6, X-BD-8): the cut a row's first stage owes its second that `entrants` cannot supply, from the posted bodies, or null when the
 *  field supplies it. The cut is the progression's takes: a topNPerGroup n is n from each pool, a rankRange its width. The field supplies
 *  what its pots hold: the seeded snake leaves floor(entrants / pools) or one more in a pool, and a pool gives at most the pool it has, so
 *  7 into 4 pools (2, 2, 2, 1) supplies 7 against a top 2 of each (8). Typed from the rulebook, never read from the product's own gate. */
export function cutBeyondFieldExpected(row: Parameters<typeof stagesForRow>[0], entrants: number): { qualified: number; max: number } | null {
  const [first, next] = stagesForRow(row);
  const progression = next?.progression as { sources?: readonly { take?: readonly { kind: string; n?: number; from?: number; to?: number }[] }[] } | null | undefined;
  if (first === undefined || progression === null || progression === undefined) return null;
  const poolCount = first.kind === "group" ? (first.config as { pools?: { count?: unknown } } | undefined)?.pools?.count : undefined;
  const pools = typeof poolCount === "number" && poolCount >= 1 ? poolCount : 1;
  const sizes = Array.from({ length: pools }, (_, i) => Math.floor(entrants / pools) + (i < entrants % pools ? 1 : 0));
  let qualified = 0;
  let max = 0;
  for (const source of progression.sources ?? []) {
    for (const take of source.take ?? []) {
      if (take.kind === "topNPerGroup" && typeof take.n === "number") {
        qualified += take.n * pools;
        max += sizes.reduce((sum, size) => sum + Math.min(take.n!, size), 0);
      } else if (take.kind === "rankRange" && typeof take.from === "number" && typeof take.to === "number") {
        qualified += take.to - take.from + 1;
        max += Math.min(take.to - take.from + 1, entrants);
      }
    }
  }
  return qualified > max ? { qualified, max } : null;
}

/** The refusals an F1 case owes, either or both (template cases seed their own field and are not this one). The rulebook owes each by name
 *  (RB5-E4 the pool of one, RB5-E6 the cut beyond the field) and orders neither: where both apply, whichever the product's Start reaches
 *  first is the answer, and each is judged on its own numbers (`refusedRun`). */
function expectedRefusal(spec: { readonly row: Parameters<typeof stagesForRow>[0]; readonly template?: string }, field: number = ENTRANTS): { pool: ReturnType<typeof poolOfOneExpected>; cut: ReturnType<typeof cutBeyondFieldExpected> } | null {
  if (spec.template !== undefined) return null;
  const pool = poolOfOneExpected(spec.row, field);
  const cut = cutBeyondFieldExpected(spec.row, field);
  return pool === null && cut === null ? null : { pool, cut };
}

/** The two refusals' own items: the cut's (RB5-E6) is a 422 RR_CUT_EXCEEDS_FIELD whose sentence leads with the cut and ends with what the field
 *  supplies; the pool of one's (RB5-E4) is a 422 STAGE_NOT_READY group_too_few_entrants with the pools, the field and the count that works. */
export function cutItems(refusal: RefusedCall, owed: ReturnType<typeof cutBeyondFieldExpected>): Item[] {
  const said = /RR_CUT_EXCEEDS_FIELD: (\d+) can't qualify .* at most (\d+)\./.exec(refusal.message);
  return [
    { ok: owed !== null, note: "Start refused the cut (RR_CUT_EXCEEDS_FIELD) but the field supplies it (the gate over-refuses)" },
    { ok: refusal.status === 422, note: `Start answered ${refusal.status} RR_CUT_EXCEEDS_FIELD, want 422` },
    { ok: owed === null || (said !== null && Number(said[1]) === owed.qualified), note: `the refusal names a cut of ${said?.[1] ?? "none"}, want ${owed?.qualified}` },
    { ok: owed === null || (said !== null && Number(said[2]) === owed.max), note: `the refusal names a supply of ${said?.[2] ?? "none"}, want ${owed?.max}` },
  ];
}

export function poolItems(refusal: RefusedCall | null, field: number, owed: ReturnType<typeof poolOfOneExpected>, cut: ReturnType<typeof cutBeyondFieldExpected>): Item[] {
  if (refusal === null) return [{ ok: false, note: `Start accepted ${field} entrants${owed === null ? "" : ` in ${owed.groups} pools (the product drew a pool of one: ST-G5 is back)`}${cut === null ? "" : ` for a cut of ${cut.qualified} the field supplies ${cut.max} of (RB5-E6 is back)`}` }];
  const extra = refusal.extra ?? {};
  if (owed === null) return [{ ok: false, note: `Start answered ${refusal.status} ${refusal.code ?? "none"}, want 422 RR_CUT_EXCEEDS_FIELD (the field owes the cut's refusal alone)` }];
  return [
    { ok: refusal.status === 422 && refusal.code === "STAGE_NOT_READY", note: `Start answered ${refusal.status} ${refusal.code ?? "none"}, want 422 STAGE_NOT_READY` },
    { ok: extra.reason === "group_too_few_entrants", note: `reason ${String(extra.reason)}, want group_too_few_entrants` },
    { ok: extra.groups === owed.groups, note: `groups ${String(extra.groups)}, want ${owed.groups}` },
    { ok: extra.entrants === field, note: `entrants ${String(extra.entrants)}, want ${field}` },
    { ok: extra.required === owed.required, note: `required ${String(extra.required)}, want ${owed.required}` },
    { ok: extra.suggested === owed.suggested, note: `suggested ${String(extra.suggested)}, want ${String(owed.suggested)} (the largest pool count that leaves every pool 2 strong)` },
  ];
}

/** W5 T12 / T12b (R12): the case whose first stage the product refuses to draw. Setup runs as ever; Start is the act under test, and its answer is
 *  judged by name and by number, whichever refusal it reaches first (`expectedRefusal`). A product that DRAWS the field instead (the refusal
 *  regressed) fails the accepted item, so nothing mandates a pass over a defect. */
async function refusedRun(ctx: Parameters<Scenario["run"]>[0], rec: Recorder, field: number, owed: NonNullable<ReturnType<typeof expectedRefusal>>): Promise<Awaited<ReturnType<Scenario["run"]>>> {
  let refusal: RefusedCall | null = null;
  try {
    await setUpDivision(ctx, rec, field);
  } catch (e) {
    // A refusal in the SETUP phase is the harness asking wrongly (SetupRefused), never the answer under test.
    if (!(e instanceof RefusedCall) || e instanceof SetupRefused) throw e;
    refusal = e;
  }
  const items: Item[] = refusal?.code === "RR_CUT_EXCEEDS_FIELD" ? cutItems(refusal, owed.cut) : poolItems(refusal, field, owed.pool, owed.cut);
  const extra = refusal?.extra ?? {};
  return {
    observed: { caseId: ctx.spec.caseId, facts: [], stages: [], withdrawal: null, configEdit: null },
    assertions: [assertion("f1-pool-of-one-refused", items)],
    events: rec.events,
    notes: [...rec.notes, refusal?.code === "RR_CUT_EXCEEDS_FIELD"
      ? `Start refused ${field} entrants: the cut of ${owed.cut?.qualified ?? "?"} exceeds what the field supplies (${owed.cut?.max ?? "?"})`
      : `Start refused ${field} entrants in ${owed.pool?.groups ?? "?"} pools: suggested ${typeof extra.suggested === "number" ? String(extra.suggested) : "none"}`],
  };
}

export const f1OddField: Scenario = {
  key: "F1",
  entrantCount: ENTRANTS,
  canaryCheck: "f1-round-size",
  // W5 T12 (R12): a case the product refuses to draw builds no stage, so the fixture invariants have nothing to judge there.
  evaluatesInvariants: (spec) => expectedRefusal(spec) === null,
  mandatedRefusal: (spec) => {
    const e = expectedRefusal(spec);
    if (e === null) return null;
    const why = [
      e.cut === null ? null : `a cut of ${e.cut.qualified} from a field that supplies ${e.cut.max} (RB5-E6)`,
      e.pool === null ? null : `${ENTRANTS} entrants into ${e.pool.groups} pools leave a pool of one, offering ${e.pool.suggested ?? "no count"} (C38, RB5-E4)`,
    ].filter((w) => w !== null).join("; ");
    return `${why}; Start refuses by name`;
  },
  async run(ctx) {
    const rec = new Recorder();
    const field = fieldSizeFor(ctx.spec.row, "F1", ctx.spec.template);
    const owed = expectedRefusal(ctx.spec, field);
    if (owed !== null) return refusedRun(ctx, rec, field, owed);
    const setup = await setUpDivision(ctx, rec, field);
    const plays = await playDivision(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
    const s = observed.stages[0];
    const n = s.field.length;
    // floor(n/2) seated pairs per round, one bye; the canary ALSO expects ceil (m-1).
    // Americano: the engine's own round size; the canary ALSO expects one more court.
    // A bracket (T15): the engine's opening round over the field; the canary ALSO expects one more board.
    const americano = setup.stage.kind === "americano";
    const courts = americano ? americanoRoundSize(setup.stage.config, n) : null;
    const opening = bracketFirstRound(setup.stage.kind, s.field, setup.stage.config);
    const boards = opening !== null && "boards" in opening ? opening.boards : null;
    const right = americano ? courts ?? 0 : boards ?? Math.floor(n / 2);
    const wrong = americano || opening !== null ? right + 1 : Math.ceil(n / 2);
    const rounds = [...new Set(s.fixtures.map((f) => f.roundNo ?? 0))].sort((a, b) => a - b);
    // A bracket's later rounds hold winners (and losers) of earlier ones, so just its first round.
    const inspected = opening !== null ? rounds.slice(0, 1) : rounds;
    const seatedIn = (r: number) => s.fixtures.filter((f) => (f.roundNo ?? 0) === r && f.home !== null && f.away !== null).length;
    // T7-R1: a ladder declares no rounds — the round-size expectation has no source there (R9), so it abstains by name.
    const ladder = setup.stage.kind === "ladder";
    const seated = seatsEntrant(s);
    const sizeAbstain = ladder ? "ladder: a ladder declares no rounds (ruling T7-R1); F1 judges the challenge sweep instead (f1-ladder-sweep)"
      : americano && courts === null ? "americano: the stage declares no courtCount, so the engine's round size hangs on the live player count (stages.ts:757-758)"
      : opening !== null && "refused" in opening ? opening.refused
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
        // W2a (M-6): a bracket stage in this run (a knockout row, or the knockout stage of a league_ko row) owes a decider.
        bracketDeciderExercised(rec, observed),
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, observed, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
