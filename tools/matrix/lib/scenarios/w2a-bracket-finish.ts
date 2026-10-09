// The W2a bracket-finish scenarios (Task 14 Step 4; spec §5.6.2; findings 16 and 24): LIFECYCLE's loop on a bracket
// whose every match is FORCED down one deciding path, so a run that turns green cannot have done so by luck of the
// policy's rotation. OPT-IN: planned only by `--set w1-driving --scenario <key>` (w1-driving-set.ts), never by a
// committed plan.
//
//   BRACKET_SETTLE_LEVEL    every match ends level and is closed by an organiser settle (X-BR-1, X-ST-1)
//   BRACKET_SETTLE_ABANDON  every match is abandoned at a score and closed by an organiser settle (X-BR-2)
//   BRACKET_TIEBREAK        every match is a drawn chess game closed by its tie-break rung (BG-KO-1)
//   BRACKET_EXTRA_BOARD     every carrom match plays the extra board on a level game, so none is ever held (CA-KO-1)
//   BRACKET_NO_DRAW_GENERIC the product REFUSES a generic draw in a bracket, by name, writing nothing (GN-KO-1)
//
// Each scenario carries the shared assertions of LIFECYCLE that apply to a bracket (the bracket-decider counter and
// the reference oracle among them), plus its own, which say what makes it THAT scenario. Expected values are the
// rulebook's and the engine's declared lists (SETTLE_METHODS, TIEBREAK_RUNGS), never read back from the generator.
import { SETTLE_METHODS, type StageKind } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { RefusedCall } from "../driver/types.ts";
import { fieldSizeFor } from "../field-size.ts";
import { bracketRootRows, w2aApplies } from "../w2a-cells.ts";
import type { ObservedRun } from "../observed.ts";
import { stageCfg } from "../sport-cfg.ts";
import { generateStream } from "../streams/index.ts";
import type { RequestedOutcome } from "../streams/types.ts";
import type { CheckResult } from "../results.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, bracketDeciderExercised, builtAsPosted, foldParity, lineupsPut, loopBounded, publicStandingsMatch, referenceBracketFinish, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, bracketPolicy, playDivision, recordPosted, setUpDivision, snapshot, type BracketPick, type DivisionSetup, type RoundHooks } from "./common.ts";
import type { FixtureRow } from "../driver/types.ts";
import { W2A_SCENARIO_KEYS, type Scenario, type ScenarioContext, type W2aScenarioKey } from "./types.ts";

/** The keys lane P1 reports into w2a-local-selection.json `newScenarios`. */
export const W2A_SCENARIOS: readonly string[] = W2A_SCENARIO_KEYS;

/** A bracket-finish scenario planned on a cell it is not for: a table row (nothing to hold), or a sport whose rule it
 *  is not. The planner never does this (w2a-cells.ts); a caller that does gets this, by name, before any DB write — not
 *  a vacuous red three assertions later. */
export class W2aMisplanned extends Error {
  constructor(key: string, row: string, sport: string, why: string) {
    super(`scenario: ${key} was planned on ${row}|${sport} — ${why}`);
    this.name = "W2aMisplanned";
  }
}

/** The product's refusal of a generic draw in a bracket (spec §5.4 item 3, §7): 409, this code, frozen by the spec. */
export const LEVEL_RESULT_IN_BRACKET = "LEVEL_RESULT_IN_BRACKET";
export const LEVEL_RESULT_STATUS = 409;

/** What the refused draw left behind, read from the product before and after. */
export interface RefusalProbe {
  readonly fixtureId: string;
  readonly refusal: { readonly status: number; readonly code: string | null } | null;
  readonly before: { readonly status: string; readonly seq: number };
  readonly after: { readonly status: string; readonly seq: number };
}

/** The settle method / tie-break rung the `n`th match rotates to — the engine's own lists, so a method added there is
 *  exercised without an edit here. */
const methodAt = (n: number) => SETTLE_METHODS[n % SETTLE_METHODS.length];
const rungAt = (n: number) => TIEBREAK_RUNGS[n % TIEBREAK_RUNGS.length];

const settleEvery = (after: "level" | "abandon"): BracketPick => (_f, n, higher) => ({ kind: "settle", then: higher, method: methodAt(n), after });
const tiebreakEvery: BracketPick = (_f, n, higher) => ({ kind: "tiebreak", rung: rungAt(n), winner: higher });
const winEvery: BracketPick = (_f, _n, higher) => ({ kind: "win", winner: higher });

/** The first match of the round, in the order decideRound decides them. */
const firstOf = (batch: readonly FixtureRow[]): FixtureRow | undefined => [...batch].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0))[0];

/** GN-KO-1: starts the match, then posts a generic DRAW — the stream a LEAGUE builds — at the bracket. The start is
 *  accepted (a draw posted before the match began would be refused for that, not for being level); the draw is the
 *  event the product must refuse, by name, with nothing written. The fixture is then handed back to decideFixture as
 *  one the scenario already started (Recorder.resumed, nothing voided), to be finished by the policy's own pick. */
export async function refuseGenericDraw(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow): Promise<RefusalProbe> {
  const home = f.home_entrant_id!;
  const away = f.away_entrant_id!;
  const [start, ...level] = generateStream({ sportKey: ctx.spec.sport, cfg: ctx.cfg, stageKind: "league", home, away, outcome: { kind: "draw" } });
  if (start === undefined || level.length === 0) throw new Error(`scenario: the league's draw for ${f.id} is not a start and a result (${level.length} event(s) after the start)`);
  const started = await ctx.driver.postStream(f.id, [start], `${ctx.tag}:${f.id}`);
  recordPosted(rec, f.id, [], [start], started);
  const before = await ctx.driver.fixtureState(f.id);
  let refusal: RefusalProbe["refusal"] = null;
  try {
    await ctx.driver.postStream(f.id, level, `${ctx.tag}:${f.id}:draw`);
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    refusal = { status: e.status, code: e.code };
  }
  const after = await ctx.driver.fixtureState(f.id);
  // Finished as the policy would have asked of it: the root bracket's pick for this ordinal (nothing decided yet).
  const outcome = bracketPolicy(setup, f, ctx.spec.sport, rec.bracketOrdinal, stageCfg(ctx.spec.sport, ctx.cfg, setup.stage.kind as StageKind));
  rec.resumed.set(f.id, { outcome, live: 1, voidedType: null });
  return { fixtureId: f.id, refusal, before: { status: before.status, seq: before.last_seq }, after: { status: after.status, seq: after.last_seq } };
}

/** BRACKET_NO_DRAW_GENERIC's own check: the refusal exists, has the spec's status and code, and wrote nothing. */
export function genericDrawRefused(probe: RefusalProbe | null): CheckResult {
  if (probe === null) return assertion("w2a-generic-draw-refused", [{ ok: false, note: "the probe never ran: no bracket round was reached to post a draw at" }]);
  const items: Item[] = [
    { ok: probe.refusal !== null, note: `the product ACCEPTED a generic draw in a bracket (fixture ${probe.fixtureId}, GN-KO-1)` },
    { ok: probe.refusal?.status === LEVEL_RESULT_STATUS, note: `the refusal's status was ${probe.refusal?.status ?? "(none)"}, not ${LEVEL_RESULT_STATUS}` },
    { ok: probe.refusal?.code === LEVEL_RESULT_IN_BRACKET, note: `the refusal's code was ${probe.refusal?.code ?? "(none)"}, not ${LEVEL_RESULT_IN_BRACKET}` },
    { ok: probe.after.seq === probe.before.seq, note: `a refused draw wrote ${probe.after.seq - probe.before.seq} event(s)` },
    { ok: probe.after.status === probe.before.status, note: `a refused draw moved the fixture from ${probe.before.status} to ${probe.after.status}` },
  ];
  return assertion("w2a-generic-draw-refused", items);
}

/** SETTLE_LEVEL / SETTLE_ABANDON / TIEBREAK: every bracket match took the forced path and the product shows the
 *  decider's own method for the side asked — one item per match, so a match that took another path is named. */
export function everyMatchTookThePath(rec: Recorder, key: Exclude<W2aScenarioKey, "BRACKET_EXTRA_BOARD" | "BRACKET_NO_DRAW_GENERIC">): CheckResult {
  const items: Item[] = rec.bracketDrives.map((d): Item => {
    const a: RequestedOutcome = d.asked;
    if (key === "BRACKET_TIEBREAK") {
      const ok = a.kind === "tiebreak" && d.status === "decided" && d.outcome?.kind === "win" && d.outcome.method === `tiebreak_${a.rung}`;
      return { ok, note: `${d.fixtureId}: asked ${a.kind}, product ${d.status ?? "(no status)"} ${d.outcome?.kind ?? "(no outcome)"}${d.outcome !== null && "method" in d.outcome ? ` ${d.outcome.method}` : ""} (wanted a tiebreak_<rung> win)` };
    }
    const after = key === "BRACKET_SETTLE_LEVEL" ? "level" : "abandon";
    const ok = a.kind === "settle" && a.after === after && d.status === "decided" && d.outcome?.kind === "win" && d.outcome.method === `settled_${a.method}`;
    return { ok, note: `${d.fixtureId}: asked ${a.kind}${a.kind === "settle" ? ` after ${a.after}` : ""}, product ${d.status ?? "(no status)"} ${d.outcome?.kind ?? "(no outcome)"}${d.outcome !== null && "method" in d.outcome ? ` ${d.outcome.method}` : ""} (wanted a settled_<method> win after ${after})` };
  });
  return assertion(`w2a-every-match-${key === "BRACKET_TIEBREAK" ? "tiebroken" : "settled"}`, items);
}

/** EXTRA_BOARD (CA-KO-1): each game of a won carrom bracket match plays maxBoards boards and the extra one, so the
 *  match holds gamesToWin × (maxBoards + 1) boards — from the rule (Laws 56a/56b), not from the generator — and was
 *  decided, never held. */
export function everyGamePlayedTheExtraBoard(rec: Recorder, cfg: unknown): CheckResult {
  const c = cfg as { maxBoards: number; bestOf: number; tieBoard: string };
  const want = Math.ceil(c.bestOf / 2) * (c.maxBoards + 1);
  // Nobody needed an organiser: the extra board decided every match (a settle posted here is a scenario that left its path).
  const decider: Item[] = [{ ok: rec.settlesPosted + rec.tiebreaksPosted === 0, note: `${rec.settlesPosted} settle(s) and ${rec.tiebreaksPosted} tie-break(s) were posted — the extra board should have decided every carrom match` }];
  const items: Item[] = decider.concat(rec.bracketDrives.map((d): Item => {
    const boards = (rec.streams.get(d.fixtureId) ?? []).filter((e) => e.type === "carrom.board.summary").length;
    return { ok: c.tieBoard === "extra" && d.status === "decided" && d.outcome?.kind === "win" && boards === want, note: `${d.fixtureId}: ${boards} board(s) posted (wanted ${want}), product ${d.status ?? "(no status)"} ${d.outcome?.kind ?? "(no outcome)"}, tieBoard '${c.tieBoard}'` };
  }));
  return assertion("w2a-every-game-played-the-extra-board", rec.bracketDrives.length === 0 ? [] : items);
}

interface Spec {
  readonly pick?: BracketPick;
  /** Posts the refusal probe before the first round (BRACKET_NO_DRAW_GENERIC). */
  readonly probe?: boolean;
  /** false: the sport's own rule decides the match, so no organiser settle or tie-break is owed — life-bracket-decider-
   *  exercised (which counts exactly those) is left out, and the scenario's own check is the counted proof that the rule
   *  decided every match (EXTRA_BOARD: CA-KO-1's extra board, so carrom never holds a bracket match). */
  readonly organiserDecides?: false;
  readonly checks: (rec: Recorder, ctx: ScenarioContext, probe: RefusalProbe | null) => CheckResult[];
}

function scenario(key: W2aScenarioKey, spec: Spec): Scenario {
  return {
    key,
    entrantCount: 8,
    canaryCheck: null,
    async run(ctx) {
      const { row, sport } = ctx.spec;
      if (!(bracketRootRows() as readonly string[]).includes(row)) throw new W2aMisplanned(key, row, sport, `the row's root stage is not a bracket kind, so no match is ever held (only ${bracketRootRows().join(", ")})`);
      if (!w2aApplies(key, sport)) throw new W2aMisplanned(key, row, sport, "this sport's rules do not build the path the scenario forces (w2a-cells.ts)");
      const rec = new Recorder();
      const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, key, ctx.spec.template));
      let probe: RefusalProbe | null = null;
      const hooks: RoundHooks = {
        ...(spec.pick === undefined ? {} : { bracketPick: spec.pick }),
        ...(spec.probe !== true ? {} : {
          // Once, at the first round the root stage plays: nothing is decided yet, so the policy's ordinal is 0.
          beforeRound: async (_round: number, batch: FixtureRow[]) => {
            const f = firstOf(batch);
            if (probe === null && f !== undefined) probe = await refuseGenericDraw(ctx, rec, setup, f);
          },
        }),
      };
      const plays = await playDivision(ctx, rec, setup, hooks);
      const observed: ObservedRun = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
      const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
      return {
        observed,
        events: rec.events,
        notes: rec.notes,
        assertions: [
          builtAsPosted(setup.built, observed),
          foldParity(rec),
          resultsAsPosted(rec, observed),
          publicStandingsMatch(observed, pub),
          ...(spec.organiserDecides === false ? [] : [bracketDeciderExercised(rec, observed)]),
          referenceBracketFinish(rec, observed),
          stageCompleted(observed),
          loopBounded(rec, observed),
          advanceSeededAsDeclared(plays, observed, rec.withdrawn),
          lineupsPut(rec, setup),
          ...spec.checks(rec, ctx, probe),
        ],
      };
    },
  };
}

export const w2aScenarios: Readonly<Record<W2aScenarioKey, Scenario>> = Object.freeze({
  BRACKET_SETTLE_LEVEL: scenario("BRACKET_SETTLE_LEVEL", { pick: settleEvery("level"), checks: (rec) => [everyMatchTookThePath(rec, "BRACKET_SETTLE_LEVEL")] }),
  BRACKET_SETTLE_ABANDON: scenario("BRACKET_SETTLE_ABANDON", { pick: settleEvery("abandon"), checks: (rec) => [everyMatchTookThePath(rec, "BRACKET_SETTLE_ABANDON")] }),
  BRACKET_TIEBREAK: scenario("BRACKET_TIEBREAK", { pick: tiebreakEvery, checks: (rec) => [everyMatchTookThePath(rec, "BRACKET_TIEBREAK")] }),
  BRACKET_EXTRA_BOARD: scenario("BRACKET_EXTRA_BOARD", { pick: winEvery, organiserDecides: false, checks: (rec, ctx) => [everyGamePlayedTheExtraBoard(rec, stageCfg(ctx.spec.sport, ctx.cfg, "knockout"))] }),
  // The default policy still asks the hard path every third match (generic: an abandon at a score, then a settle),
  // so the run owes its deciders; the probe is the scenario's own.
  BRACKET_NO_DRAW_GENERIC: scenario("BRACKET_NO_DRAW_GENERIC", { probe: true, checks: (_rec, _ctx, probe) => [genericDrawRefused(probe)] }),
});
