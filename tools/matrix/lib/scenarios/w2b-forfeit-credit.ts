// The W2b forfeit-credit scenarios (Task 2 Step 4; spec §5.6; Appendix A): LIFECYCLE's loop with forfeits, double
// walkovers, abandons and withdrawals forced onto the root stage through the round hooks (D12: stage 1 only), each
// judged by counted checks whose expectation is the rule row's. OPT-IN: planned only by `--set w1-driving --scenario
// <key>` (w1-driving-set.ts), on the cells w2b-cells.ts derives — never by a committed plan.
//
//   WO-PRE    a walkover before START on the first fixture of every round              X-RS-1, X-WO-1, BG-WO-2
//   RT-PART   a retirement or disqualification after partial play, every round        X-RT-1, *-RT-*
//   DW-ALL    a double walkover, and the refusal where the fixture has no next match  X-DW-1..4
//   AB-AWARD  an abandon with a result: leading / level (award policy), cricket's
//             minimum overs passed / not reached                                     X-AB-1, X-AB-2, CK-AB-1/2
//   WD-CASC   a knockout's withdrawal cascade: TBD seat, held / tie-break pending,
//             not started, a line whose two seats both die, and the final beside
//             that void: crowned by bye, or, on alternate cells, its finalist
//             withdrawn first (void, title vacant: W4's)                       X-WD-1..4, BG-WO-2/3
//
// A credited score the product shows in its table (X-WO-1) is judged against the walkover-credit reference family
// (@seazn/reference), asked with the drive's offender and, after START, the scoresheet so far (scoresheetOf); a credit
// the family refuses is a FAILING item, by name — never a skip. Every bracket drive, the forfeits among them, is
// judged against the bracket-finish family (life-reference-bracket-finish, I-3).
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { RefusedCall, type FixtureRow, type StageRef, type StandingsRowWire, type WithdrawOut } from "../driver/types.ts";
import { fieldSizeFor } from "../field-size.ts";
import { foldStream } from "../fold.ts";
import { isTerminal, toObservedOutcome, type ObservedFixture, type ObservedOutcome, type ObservedRun } from "../observed.ts";
import type { CreditCase } from "@seazn/reference";
import type { CheckResult } from "../results.ts";
import { sportModule } from "../sport-cfg.ts";
import { routeTo, type Route } from "../routing.ts";
import { generateStream, levelReachable, partialPlay } from "../streams/index.ts";
import { GeneratorUnsupported, OutcomeUnreachable, type ForfeitReason, type RequestedOutcome, type Side, type StreamEvent } from "../streams/types.ts";
import { AWARD_POLICY, DLS_ON, abandonOverride, inMatchReasons, w2bApplies, w2bCells } from "../w2b-cells.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { assertion, builtAsPosted, foldParity, lineupsPut, loopBounded, publicStandingsMatch, referenceBracketFinish, resultsAsPosted, stageCompleted, type Item } from "./assertions.ts";
import { Recorder, caseStageCfg, decideFixture, ensureLineups, liveEvents, playDivision, recordPosted, setUpDivision, snapshot, type DivisionSetup, type RoundHooks } from "./common.ts";
import {
  NO_PLACEMENT, ScoresheetUnread, creditExpectation, deadSeats, doubleWalkoverAdvancesNobody, doubleWalkoverRecorded, doubleWalkoverRefusedAtTheEnd, feedGraph, forfeitRecorded, hasNoNextMatch, isolatedTable, ladderUnmoved,
  partialPlayStands, pickDoubleWalkover, scoresheetOf, withRefusals, WITHDREW, type ExpectedDelta, type FeedGraph, type ForfeitDrive, type LocalDelta, type RefusalProbe,
} from "./w2b-checks.ts";
import { W2B_SCENARIO_KEYS, type Scenario, type ScenarioContext, type ScenarioOutput, type W2bScenarioKey } from "./types.ts";

/** The keys lane P1 reports into w2b-local-selection.json `newScenarios`. */
export const W2B_SCENARIOS: readonly string[] = W2B_SCENARIO_KEYS;

/** A forfeit-credit scenario planned on a cell it is not for: refused by name before any driver call, so a misplanned
 *  run cannot read as a vacuous red. */
export class W2bMisplanned extends Error {
  constructor(key: string, row: string, sport: string, why: string) {
    super(`scenario: ${key} was planned on ${row}|${sport} — ${why}`);
    this.name = "W2bMisplanned";
  }
}

const seated = (f: FixtureRow): boolean => f.home_entrant_id !== null && f.away_entrant_id !== null;
const byNo = (batch: readonly FixtureRow[]): FixtureRow[] => [...batch].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0));
/** The first seated, unstarted fixture of the batch, in the order decideRound decides them. */
const firstScheduled = (batch: readonly FixtureRow[]): FixtureRow | undefined => byNo(batch).find((f) => seated(f) && f.status === "scheduled");
const stageRows = async (ctx: ScenarioContext, setup: DivisionSetup, stage: StageRef = setup.stage): Promise<FixtureRow[]> =>
  (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id);
const fieldBySeed = (setup: DivisionSetup): string[] => [...setup.entrants].sort((a, b) => setup.seedOf(a.id) - setup.seedOf(b.id)).map((e) => e.id);
const ladderOrder = async (ctx: ScenarioContext, setup: DivisionSetup): Promise<string[] | null> => {
  const order = (await ctx.driver.listStages(setup.division.id)).find((s) => s.id === setup.stage.id)?.config.ladder_order;
  return Array.isArray(order) ? (order as string[]) : null;
};

/** Posts `outcome` on `f` through decideFixture. A forfeit recorded before START (a walkover, a double walkover) is
 *  one event, so a refusal writes nothing and is RECORDED (the fixture is then played as the policy asks); any other
 *  refusal propagates, naming its code (a refused retirement leaves its partial play behind). */
async function drive(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow, outcome: RequestedOutcome): Promise<ForfeitDrive> {
  const base = { fixtureId: f.id, home: f.home_entrant_id!, away: f.away_entrant_id!, asked: outcome };
  const bare = outcome.kind === "double_walkover" || (outcome.kind === "forfeit" && outcome.at === "before_start");
  try {
    await decideFixture(ctx, rec, setup, f, outcome);
  } catch (e) {
    if (!bare || !(e instanceof RefusedCall)) throw e;
    return { ...base, refusal: { status: e.status, code: e.code } };
  }
  return { ...base, refusal: null };
}

async function probe(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow): Promise<RefusalProbe> {
  const before = await ctx.driver.fixtureState(f.id);
  const d = await drive(ctx, rec, setup, f, { kind: "double_walkover" });
  const after = await ctx.driver.fixtureState(f.id);
  return { fixtureId: f.id, refusal: d.refusal, before: { status: before.status, seq: before.last_seq }, after: { status: after.status, seq: after.last_seq } };
}

// ---------------------------------------------------------------------------------------------------------------
// The table read (X-WO-1, X-DW-4, X-AB-1). Judged only where the root's standings rows are the division's entrants:
// a table kind, less americano (its table is per player of the pairs it mints).

export const tableJudged = (kind: string): boolean => !forbidsLevelResult(kind) && kind !== "americano";

async function tableRows(ctx: ScenarioContext, stage: StageRef, fixtures: readonly ObservedFixture[]): Promise<Map<string, StandingsRowWire>> {
  const out = new Map<string, StandingsRowWire>();
  for (const pool of [...new Set(fixtures.map((f) => f.poolId))]) for (const r of (await ctx.driver.standings(stage.id, pool)).rows) out.set(r.entrantId, r);
  return out;
}

/** The sport's own contribution of a fixture the harness posted: standingsDelta over the folded stream, under the cfg
 *  and stage context the product folds it in. Null where the harness holds no stream or it folds no outcome. */
function localDelta(ctx: ScenarioContext, rec: Recorder, stage: StageRef): (f: ObservedFixture) => readonly [LocalDelta, LocalDelta] | null {
  const m = sportModule(ctx.spec.sport);
  const cfg = caseStageCfg(ctx, stage.kind as StageKind);
  return (f) => {
    const events = rec.streams.get(f.id);
    if (events === undefined || f.home === null || f.away === null) return null;
    const folded = foldStream(m, cfg, f.home, f.away, events);
    if (folded.outcome === null) return null;
    const sctx = { kind: stage.kind as StageKind, ...(f.poolId ? { poolId: f.poolId } : {}), ...(f.roundNo ? { roundNo: f.roundNo } : {}) };
    const [h, a] = m.standingsDelta(folded.outcome, cfg, sctx, folded.state);
    return [h, a];
  };
}

const creditCase = (ctx: ScenarioContext, stage: StageRef, reason: CreditCase["reason"], extra: Pick<CreditCase, "by" | "played"> = {}): CreditCase =>
  ({ sport: ctx.spec.sport, cfg: caseStageCfg(ctx, stage.kind as StageKind) as Record<string, unknown>, reason, ...extra });

/** The isolated table over the drives the family credited, with each refusal a failing item beside it (withRefusals):
 *  a refused credit is judged, never skipped. */
async function creditTable(id: string, ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, observed: ObservedRun, judged: ReadonlyMap<string, (e: string) => ExpectedDelta>, refused: readonly string[]): Promise<CheckResult> {
  const fixtures = observed.stages[0].fixtures;
  const table = judged.size === 0 ? assertion(id, []) : isolatedTable(id, { fixtures, rows: await tableRows(ctx, setup.stage, fixtures), judged, local: localDelta(ctx, rec, setup.stage) });
  return withRefusals(table, refused);
}

/** WO-PRE's table: each walked-over match credits the walkover-credit family's walkover (*-WO-1) to the side it went
 *  to (and its loser), a win and a loss — the family asked with the drive's own offender. */
async function walkoverCreditCheck(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, drives: readonly ForfeitDrive[], observed: ObservedRun): Promise<CheckResult> {
  const id = "w2b-walkover-credit";
  if (!tableJudged(setup.stage.kind)) return assertion(id, [], `the root stage is a ${setup.stage.kind}, not a table: a walkover's credit is the table's (X-WO-1)`);
  const judged = new Map<string, (e: string) => ExpectedDelta>();
  const refused: string[] = [];
  for (const d of drives) {
    if (d.refusal !== null || d.asked.kind !== "forfeit") continue;
    const x = creditExpectation(creditCase(ctx, setup.stage, "walkover", { by: d.asked.by }), { home: d.home, away: d.away, offender: d.asked.by });
    if ("refused" in x) refused.push(`${d.fixtureId}: ${x.refused}`);
    else judged.set(d.fixtureId, x.expect);
  }
  return creditTable(id, ctx, rec, setup, observed, judged, refused);
}

/** RT-PART's table: the retirement credit (*-RT-1, X-RT-1 — an in-match disqualification takes it too), asked of the
 *  walkover-credit family with the drive's offender and the scoresheet so far, read from the events the harness posted
 *  before its forfeit (scoresheetOf). A refusal — the family's or the reading's — is a failing item, by name. */
async function retirementCreditCheck(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, drives: readonly ForfeitDrive[], observed: ObservedRun): Promise<CheckResult> {
  const id = "w2b-retirement-credit";
  if (!tableJudged(setup.stage.kind)) return assertion(id, [], `the root stage is a ${setup.stage.kind}, not a table: a retirement's credit is the table's (X-WO-1)`);
  const cfg = caseStageCfg(ctx, setup.stage.kind as StageKind) as Record<string, unknown>;
  const judged = new Map<string, (e: string) => ExpectedDelta>();
  const refused: string[] = [];
  for (const d of drives) {
    if (d.refusal !== null || d.asked.kind !== "forfeit") continue;
    const live = liveEvents(rec.streams.get(d.fixtureId) ?? []);
    if (live.at(-1)?.type !== "core.forfeit") { refused.push(`${d.fixtureId}: the stream the harness holds ends with ${live.at(-1)?.type ?? "nothing"}, not its core.forfeit`); continue; }
    let played: { home: number[]; away: number[] };
    try {
      played = scoresheetOf(ctx.spec.sport, cfg, live.slice(0, -1), d.home, d.away);
    } catch (e) {
      if (!(e instanceof ScoresheetUnread)) throw e;
      refused.push(`${d.fixtureId}: ${e.message}`);
      continue;
    }
    const x = creditExpectation(creditCase(ctx, setup.stage, d.asked.reason, { by: d.asked.by, played }), { home: d.home, away: d.away, offender: d.asked.by });
    if ("refused" in x) refused.push(`${d.fixtureId}: ${x.refused}`);
    else judged.set(d.fixtureId, x.expect);
  }
  return creditTable(id, ctx, rec, setup, observed, judged, refused);
}

/** X-DW-4: a double walkover in a table is P+1, L+1, 0 points for both, nothing credited — the family's answer. */
async function doubleWalkoverTableCheck(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, d: ForfeitDrive | null, observed: ObservedRun): Promise<CheckResult> {
  const id = "w2b-double-walkover-table";
  if (!tableJudged(setup.stage.kind)) return assertion(id, [], `the root stage is a ${setup.stage.kind}, not a table (X-DW-4 is a table's rule)`);
  if (d === null || d.refusal !== null) return assertion(id, [{ ok: false, note: d === null ? "no double walkover was posted" : `${d.fixtureId}: refused ${d.refusal!.status} ${d.refusal!.code ?? "(no code)"}` }]);
  const x = creditExpectation(creditCase(ctx, setup.stage, "double_walkover"), { home: d.home, away: d.away, offender: "both" });
  return "refused" in x
    ? creditTable(id, ctx, rec, setup, observed, new Map(), [`${d.fixtureId}: ${x.refused}`])
    : creditTable(id, ctx, rec, setup, observed, new Map([[d.fixtureId, x.expect]]), []);
}

// ---------------------------------------------------------------------------------------------------------------
// AB-AWARD: the abandons and what their rule says they are.

type AbandonKind = "leading" | "level" | "past_min_overs" | "before_min_overs";
/** One abandon the scenario posted: its fixture, seats, kind and the events posted — and `rule`, the result the sport's
 *  own rule gives that stream: the real engine's fold of it (CK-AB-1: the DLS par is the engine's table, never the
 *  product's answer), the expected result past the minimum overs (review M-3). `drawStands` is whether the stage takes
 *  a draw at all — the sport's own `supportsDraws` for the case's cfg and stage kind, an engine declaration: FB-AB-1's
 *  level draw is a draw kind's result only where it does, and where it does not the level abandon has no result
 *  (X-AB-1; controller ruling R16-3). */
export interface AbandonDrive { readonly fixtureId: string; readonly home: string; readonly away: string; readonly kind: AbandonKind; readonly events: readonly StreamEvent[]; readonly rule: ObservedOutcome | null; readonly drawStands: boolean }

/** Past the minimum overs the rule's result is a DLS win or a tie (CK-AB-1); anything else the fold gives is named. */
function pastMinOversRule(d: AbandonDrive): { readonly winner: string | null } | { readonly unread: string } {
  const r = d.rule;
  if (r?.kind === "win" && r.method === "dls") return { winner: r.winner };
  if (r?.kind === "tie") return { winner: null };
  return { unread: `${d.fixtureId} (past_min_overs): the rule's own fold of the posted stream is ${r === null ? "no result" : JSON.stringify(r)} — neither a DLS win nor a tie, so past the minimum overs has nothing to expect (CK-AB-1)` };
}

/** The two abandons a sport's rule gives a result to, in the order the scenario posts them (round 1, round 2). */
export function abandonPlan(sport: string): readonly { readonly kind: AbandonKind; readonly request: RequestedOutcome }[] | null {
  const rule = abandonOverride(sport);
  if (rule === AWARD_POLICY) return [{ kind: "leading", request: { kind: "abandon", atScore: true } }, { kind: "level", request: { kind: "abandon", afterPartial: true } }];
  if (rule === DLS_ON) return [{ kind: "past_min_overs", request: { kind: "abandon", afterPartial: true } }, { kind: "before_min_overs", request: { kind: "abandon", atScore: true } }];
  return null;
}

/** Who leads at the abandon, from the goals the harness POSTED (`<sport>.goal {by}` before core.abandon): the rule's
 *  input, read from what was sent, never from the product. */
export function goalLead(events: readonly StreamEvent[], home: string, away: string): Side | "level" {
  const goals = events.filter((e) => e.type.endsWith(".goal")).map((e) => (e.payload as { by?: unknown }).by);
  const h = goals.filter((g) => g === home).length;
  const a = goals.filter((g) => g === away).length;
  return h === a ? "level" : h > a ? "home" : "away";
}

/** X-AB-2 (FB/HK/IH-AB-1, D8; CK-AB-1/2): an abandon with a result is decided, and the result is the rule's. */
export function abandonWithResult(drives: readonly AbandonDrive[], fixtures: readonly ObservedFixture[]): CheckResult {
  return assertion("w2b-abandon-with-result", drives.map((d): Item => {
    const f = fixtures.find((x) => x.id === d.fixtureId);
    if (f === undefined) return { ok: false, note: `${d.fixtureId}: not in the stage's fixtures after the run` };
    const o = f.outcome;
    const got = `${d.fixtureId} (${d.kind}): ${f.status} ${o === null ? "no outcome" : JSON.stringify(o)}`;
    switch (d.kind) {
      case "leading": {
        const lead = goalLead(d.events, d.home, d.away);
        const leader = lead === "home" ? d.home : lead === "away" ? d.away : null;
        return { ok: leader !== null && f.status === "decided" && o?.kind === "win" && o.winner === leader && o.method === "abandoned", note: `${got}, wanted decided win{${leader ?? "(no leader posted)"}, method abandoned}` };
      }
      case "level":
        // X-AB-1: where the stage refuses a draw, the level abandon decides nothing — abandoned, no outcome.
        return d.drawStands
          ? { ok: goalLead(d.events, d.home, d.away) === "level" && f.status === "decided" && o?.kind === "draw", note: `${got}, wanted decided draw (a level abandon in a table)` }
          : { ok: goalLead(d.events, d.home, d.away) === "level" && f.status === "abandoned" && o === null, note: `${got}, wanted abandoned with no outcome (a level abandon where the stage refuses a draw, X-AB-1)` };
      // CK-AB-1: the result the DLS method gives the posted stream (a win by DLS, or a tie at par) — the rule's fold, the
      // par the engine's DLS table, never the product's winner read back.
      case "past_min_overs": {
        const rule = pastMinOversRule(d);
        if ("unread" in rule) return { ok: false, note: rule.unread };
        const ok = f.status === "decided" && (rule.winner === null ? o?.kind === "tie" : o?.kind === "win" && o.winner === rule.winner && o.method === "dls");
        return { ok, note: `${got}, wanted decided ${rule.winner === null ? "tie" : `win{${rule.winner}, method dls}`} (the rule's result past the minimum overs)` };
      }
      case "before_min_overs":
        return { ok: f.status === "decided" && o?.kind === "no_result", note: `${got}, wanted decided no_result (CK-AB-2)` };
    }
  }));
}

export interface PointsCfg { readonly win?: unknown; readonly draw?: unknown; readonly loss?: unknown; readonly tie?: unknown; readonly noResult?: unknown }

/** X-AB-1: one abandon's table delta as its RULE has it — points from the cfg's own table (`p`), the winner the rule's
 *  (goalLead from the goals posted; past the minimum overs, the rule's fold — review M-3: never the product's winner).
 *  An abandon whose rule result cannot be read is refused by name, for the caller to count as a FAILING item. */
export function abandonDelta(d: AbandonDrive, p: (k: keyof PointsCfg) => number): { readonly expect: (e: string) => ExpectedDelta } | { readonly refused: string } {
  // Every abandon with a result is a match played (the sport's standingsDelta); the one with none is not (X-AB-1), so
  // `played` is judged on every kind — the key a match left out of the table differs on.
  const won = (winner: string | null) => (e: string): ExpectedDelta => (e === winner ? { scalars: { played: 1, won: 1, lost: 0, points: p("win") }, metrics: {} } : { scalars: { played: 1, won: 0, lost: 1, points: p("loss") }, metrics: {} });
  switch (d.kind) {
    case "leading": {
      const lead = goalLead(d.events, d.home, d.away);
      if (lead === "level") return { refused: `${d.fixtureId} (leading): the goals posted are level — no leader for the rule to credit` };
      return { expect: won(lead === "home" ? d.home : d.away) };
    }
    // X-AB-1: where the stage refuses a draw, a level abandon has no result, so it stays out of the table — not played.
    case "level": return d.drawStands
      ? { expect: () => ({ scalars: { played: 1, won: 0, drawn: 1, lost: 0, points: p("draw") }, metrics: {} }) }
      : { expect: () => ({ scalars: { played: 0, won: 0, drawn: 0, lost: 0, points: 0 }, metrics: {} }) };
    case "past_min_overs": {
      const rule = pastMinOversRule(d);
      if ("unread" in rule) return { refused: rule.unread };
      return { expect: rule.winner === null ? () => ({ scalars: { played: 1, points: p("tie") }, metrics: {} }) : won(rule.winner) };
    }
    // CK-AB-2: 1 point each (the cfg's noResult) and an entry in the no-result column.
    case "before_min_overs": return { expect: () => ({ scalars: { played: 1, won: 0, lost: 0, points: p("noResult") }, metrics: { no_results: 1 } }) };
  }
}

/** X-AB-1: the table counts an abandon the rule gives a result, as that result — points from the cfg's own table; each
 *  abandon whose rule result cannot be read is a failing item beside the table's own (withRefusals). */
async function abandonTableCheck(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, drives: readonly AbandonDrive[], observed: ObservedRun): Promise<CheckResult> {
  const id = "w2b-abandon-in-table";
  const pts = ((caseStageCfg(ctx, setup.stage.kind as StageKind) as { points?: PointsCfg }).points ?? {});
  const p = (k: keyof PointsCfg): number => {
    const v = pts[k];
    if (typeof v !== "number") throw new Error(`scenario: AB-AWARD on ${ctx.spec.sport} — the cfg's points table has no numeric '${k}'`);
    return v;
  };
  const fixtures = observed.stages[0].fixtures;
  const judged = new Map<string, (e: string) => ExpectedDelta>();
  const refused: string[] = [];
  for (const d of drives) {
    const x = abandonDelta(d, p);
    if ("refused" in x) refused.push(x.refused);
    else judged.set(d.fixtureId, x.expect);
  }
  const table = judged.size === 0 ? assertion(id, []) : isolatedTable(id, { fixtures, rows: await tableRows(ctx, setup.stage, fixtures), judged, local: localDelta(ctx, rec, setup.stage) });
  return withRefusals(table, refused);
}

// ---------------------------------------------------------------------------------------------------------------
// WD-CASC: the knockout choreography.

/** One withdrawal the choreography asked for: the product's answer, or its refusal (X-WD-3: a withdrawal whose fixture has
 *  a TBD opponent walks over, so a refusal there is the defect, recorded and judged — never a crash of the case). */
interface WithdrawStep { readonly entrantId: string; readonly label: string; readonly answer: WithdrawOut | null; readonly refusal?: { readonly status: number; readonly code: string | null } }
interface Line { readonly qf: readonly [FixtureRow, FixtureRow]; readonly sf: string }

/** WD-CASC stops here, by the rule's name: a fixture the choreography withdrew a side from is still open. */
export class W2bCascadeLeftOpen extends Error {
  constructor(why: string) {
    super(`scenario: WD-CASC — ${why}`);
    this.name = "W2bCascadeLeftOpen";
  }
}
/** Whether the case can play on past a fixture the choreography withdrew a side from. Terminal: yes. Open after an
 *  ACCEPTED withdrawal: no — the product did not walk it over (X-WD-1, BG-WO-3), and the harness never decides a withdrawn
 *  side's match. Open after a REFUSED one: yes when the fixture never started (the side is still in; the loop plays it and
 *  the refusal is judged), no when the choreography already posted to it (a held match cannot be replayed from the start). */
export function cascadeLeftOpen(fixtureId: string, label: string, status: string, withdrawal: "accepted" | "refused", posted: boolean): string | null {
  if (isTerminal(status)) return null;
  if (withdrawal === "refused" && !posted) return null;
  return withdrawal === "accepted"
    ? `${fixtureId} (${label}) is ${status} after its side withdrew: the product did not walk it over (X-WD-1), and the harness never decides a withdrawn side's match`
    : `${fixtureId} (${label}) is ${status} after its withdrawal was refused: the choreography already posted to it, so the stage cannot drain`;
}
/** QF1's semi-final line and the other one, from the feed graph (never fixture numbers), and the final. */
export function knockoutLines(g: FeedGraph, r1: readonly FixtureRow[]): { a: Line; b: Line; final: string } {
  const sorted = byNo(r1);
  const sfOf = (f: FixtureRow): string => {
    const e = f.ext_key == null ? undefined : g.winnerTo.get(f.ext_key);
    if (e === undefined) throw new W2bMisplanned("WD-CASC", "knockout", "-", `round-1 fixture ${f.id} feeds no semi-final`);
    return e.target;
  };
  if (sorted.length !== 4) throw new W2bMisplanned("WD-CASC", "knockout", "-", `the choreography is a knockout of 8 (four quarter-finals), this round 1 has ${sorted.length}`);
  const sfA = sfOf(sorted[0]);
  const a = sorted.filter((f) => sfOf(f) === sfA);
  const b = sorted.filter((f) => sfOf(f) !== sfA);
  const final = g.winnerTo.get(sfA)?.target;
  if (a.length !== 2 || b.length !== 2 || final === undefined || g.winnerTo.get(sfOf(b[0]))?.target !== final) throw new W2bMisplanned("WD-CASC", "knockout", "-", "the bracket is not two semi-final lines into one final");
  return { a: { qf: [a[0], a[1]], sf: sfA }, b: { qf: [b[0], b[1]], sf: sfOf(b[0]) }, final };
}

/** What QF2 is when its side withdraws: held level (X-WD-1), a chess tie-break pending (BG-WO-3), or else play under
 *  way (D3 R5: a withdrawal walks over in any phase but over). The first the sport's generator builds. */
export function heldStream(sport: string, cfg: unknown, home: string, away: string): { readonly label: "held" | "tie-break pending" | "in play"; readonly events: StreamEvent[] } {
  const req = { sportKey: sport, cfg, stageKind: "knockout" as StageKind, home, away };
  if (levelReachable(sport, cfg, "knockout")) return { label: "held", events: generateStream({ ...req, outcome: { kind: "level" } }) };
  try {
    const tb = generateStream({ ...req, outcome: { kind: "tiebreak", rung: TIEBREAK_RUNGS[0], winner: "home" } });
    if (tb.at(-1)?.type !== "boardgame.tiebreak") throw new Error(`scenario: WD-CASC — ${sport}'s tie-break stream ends ${tb.at(-1)?.type ?? "empty"}, not its boardgame.tiebreak`);
    return { label: "tie-break pending", events: tb.slice(0, -1) };
  } catch (e) {
    if (!(e instanceof OutcomeUnreachable || e instanceof GeneratorUnsupported)) throw e;
    return { label: "in play", events: partialPlay({ ...req, outcome: { kind: "abandon" } }) };
  }
}

/** WD-CASC's final half (re-review round 2, item 2). One bracket reaches only one of the two shapes the final can take
 *  beside SF2's void, so they alternate along WD-CASC's planned cells (w2bCells order). The seat rule reads seats and
 *  statuses, never the sport, and the sport's own part of the choreography (QF2's held stream) runs on every cell.
 *  - "crowned": a2 waits in the final; SF2's void kills its other seat, so a2 walks over by bye and is crowned (X-DW-2).
 *  - "vacant": a2 withdraws from the final while its other seat is TBD (X-WD-3), and SF2's void then kills that seat
 *    too: the final is void and nobody is crowned. That is the vacant title, which the spec hands to W4 (§2.2,
 *    W2b-R10): W2b pins the product's answer and changes nothing. */
export type FinalHalf = "crowned" | "vacant";
export function wdCascFinalHalf(row: string, sport: string): FinalHalf {
  const i = w2bCells("WD-CASC").findIndex((c) => c.row === row && c.sport === sport);
  if (i < 0) throw new W2bMisplanned("WD-CASC", row, sport, "not one of the scenario's cells (w2b-cells.ts), so it has no final half");
  return i % 2 === 1 ? "vacant" : "crowned";
}
/** The vacant half's step: a2 withdraws from the final while its other seat is TBD. */
export const FINAL_TBD = "final opponent TBD";

interface WdRecord {
  readonly half: FinalHalf;
  readonly steps: WithdrawStep[];
  /** fixture → who withdrew from it, who remained, and what it was when they did. */
  readonly walked: { fixtureId: string; withdrawn: string; remaining: string; label: string }[];
  w1: string | null; a2: string | null; a3: string | null;
  lines: { a: Line; b: Line; final: string } | null;
  dw: ForfeitDrive | null;
}

/** walked_over_held (the plan's N1; X-WD-1, R14): the walkover a HELD line takes counts once — a held level result, or a
 *  chess tie-break pending (a decider owed). A line not started, under way with nothing owed, or with its opponent TBD
 *  counts nothing. By heldStream's label, stated from the rule. */
const HELD_LABELS: ReadonlySet<string> = new Set(["held", "tie-break pending"]);

export function withdrawalsWalkOver(r: WdRecord, fixtures: readonly ObservedFixture[]): CheckResult {
  const items: Item[] = r.walked.map((w): Item => {
    const f = fixtures.find((x) => x.id === w.fixtureId);
    const o = f?.outcome ?? null;
    const a = o !== null && o.kind === "award" ? o : null;
    return { ok: f?.status === "forfeited" && a !== null && a.winner === w.remaining && a.loser === w.withdrawn && a.reason === WITHDREW, note: `${w.fixtureId} (${w.label}): ${f?.status ?? "(missing)"} ${o === null ? "no outcome" : JSON.stringify(o)}, wanted forfeited award to ${w.remaining}, loser ${w.withdrawn}, reason ${WITHDREW}` };
  });
  for (const s of r.steps) {
    const a = s.answer;
    const want = HELD_LABELS.has(s.label) ? 1 : 0;
    items.push(a === null
      ? { ok: false, note: `withdrawal of ${s.entrantId} (${s.label}) refused ${s.refusal?.status ?? "?"} ${s.refusal?.code ?? "(no code)"}` }
      : {
        ok: a.policy === "walkover" && a.voided === 0 && a.walked_over_held === want,
        note: `withdrawal of ${s.entrantId} (${s.label}) answered policy ${a.policy}, voided ${a.voided}, walked_over_held ${a.walked_over_held}; wanted walkover, 0, ${want}`,
      });
  }
  return assertion("w2b-withdrawal-walks-over", r.walked.length === 0 ? [{ ok: false, note: "no withdrawal was recorded" }] : items);
}

const byExt = (fixtures: readonly ObservedFixture[], key: string): ObservedFixture | undefined => fixtures.find((f) => f.extKey === key);

/** X-WD-3: the semi-final whose seat went dead while its other seat was TBD walks the arriving opponent over — and,
 *  because a WINNER withdrew from that seat (w1 won QF1, then left), the walkover names her (owner ruling 116: loser w1,
 *  reason "withdrew", like any other walkover; it was a bye, W2b C-5) — and the withdrawn entrants are seated
 *  nowhere after the fixture they left. Nothing is voided but SF2, the dead-seat rule's void (bothSeatsDead), and in the
 *  vacant half the final, the same rule's (finalVacant). */
export function tbdSeatWalksOver(r: WdRecord, fixtures: readonly ObservedFixture[]): CheckResult {
  if (r.lines === null || r.w1 === null || r.a2 === null) return assertion("w2b-withdrawal-tbd-seat", [{ ok: false, note: "the choreography never reached its first withdrawal" }]);
  const sf = byExt(fixtures, r.lines.a.sf);
  const o = sf?.outcome ?? null;
  const a = o !== null && o.kind === "award" ? o : null;
  const items: Item[] = [{ ok: sf?.status === "forfeited" && a !== null && a.winner === r.a2 && a.loser === r.w1 && a.reason === WITHDREW, note: `${r.lines.a.sf}: ${sf?.status ?? "(missing)"} ${o === null ? "no outcome" : JSON.stringify(o)}, wanted the arriving ${r.a2} walked over ${r.w1}, who withdrew (loser ${r.w1}, reason ${WITHDREW})` }];
  const lines = r.lines;
  // Who departed, and the fixtures each keeps a seat in: the ones played before her withdrawal. The vacant half's a2
  // keeps QF2 and SF1 (both walked over to her) and leaves the final.
  const departed: [string | null, string[]][] = [[r.w1, [lines.a.qf[0].id]], [r.a3, [lines.b.qf[0].id]]];
  if (r.half === "vacant") departed.push([r.a2, [lines.a.qf[1].id, ...(sf === undefined ? [] : [sf.id])]]);
  for (const [who, kept] of departed) {
    if (who === null) continue;
    const again = fixtures.filter((f) => !kept.includes(f.id) && (f.home === who || f.away === who));
    items.push({ ok: again.length === 0, note: `${who} withdrew after ${kept.join(", ")} and is seated again in ${again.map((f) => f.id).join(", ")}` });
  }
  // The vacant half's final void is the dead-seat rule's too, and finalVacant judges it.
  const owed = r.half === "vacant" ? [lines.b.sf, lines.final] : [lines.b.sf];
  const voids = fixtures.filter((f) => (f.status === "abandoned" || f.status === "cancelled") && !owed.includes(f.extKey ?? ""));
  items.push({ ok: voids.length === 0, note: `the cascade voided ${voids.map((f) => f.id).join(", ")} (X-WD-2/3: it never voids; only the dead-seat rule's voids are owed: ${owed.join(", ")})` });
  return assertion("w2b-withdrawal-tbd-seat", items);
}

/** QF4's double walkover beside a3's departure (X-DW-2; loop F's resolver, stages.ts resolveBracketSeats/seatDeparted).
 *  - SF2: a3 withdrew while its other seat was TBD (her seat departed), and QF4's RECORDED double walkover feeds that
 *    other seat. Both seats are dead but only one departed — nobody withdrew from QF4 — so SF2 is a void: abandoned,
 *    no outcome, nobody seated. (Both departed would be X-WD-4's double walkover; the matrix cannot drive it — a second
 *    withdrawal there finds its opponent TBD or already walked over, never withdrawn — so it is the fake's unit test's.)
 *  - The final, in the crowned half (wdCascFinalHalf): a2 walked over SF1 beside w1's dead seat and waits there; the
 *    seat SF2's void feeds is dead, so a2 walks over by bye and holds the title. The vacant half's final is
 *    finalVacant's. */
export function bothSeatsDead(r: WdRecord, fixtures: readonly ObservedFixture[], finalRanks: readonly string[] | null): CheckResult {
  if (r.lines === null || r.a2 === null) return assertion("w2b-withdrawal-both-seats-dead", [{ ok: false, note: "the choreography never reached the second line" }]);
  const sf = byExt(fixtures, r.lines.b.sf);
  const fin = byExt(fixtures, r.lines.final);
  const sfSeats = sf === undefined ? [] : [sf.home, sf.away].filter((e): e is string => e !== null);
  const fa = fin?.outcome?.kind === "award" ? fin.outcome : null;
  const text = (o: ObservedFixture["outcome"] | undefined) => (o == null ? "no outcome" : JSON.stringify(o));
  const items: Item[] = [
    { ok: r.dw !== null && r.dw.refusal === null, note: r.dw === null ? "the quarter-final double walkover was never posted" : `${r.dw.fixtureId}: the double walkover was refused ${r.dw.refusal?.status ?? ""} ${r.dw.refusal?.code ?? ""}` },
    { ok: sf?.status === "abandoned" && sf.outcome == null && sfSeats.length === 0, note: `${r.lines.b.sf}: ${sf?.status ?? "(missing)"} ${text(sf?.outcome)}, seats ${sfSeats.join(" v ") || "nobody"} — wanted abandoned with no outcome, seats nobody (a departed seat beside a recorded double walkover is a void)` },
  ];
  // The vacant half pins no finalRanks: the product ranks a first-round loser 1st while its banner names nobody — a W4
  // defect (VACANT_TITLE_ROUTE) a pin would freeze (class 4). finalVacant keeps the void and the no-champion items.
  if (r.half === "crowned") {
    items.push(
      { ok: fin?.status === "forfeited" && fa !== null && fa.winner === r.a2 && fa.loser === null && fa.reason === "bye", note: `${r.lines.final}: ${fin?.status ?? "(missing)"} ${text(fin?.outcome)} — wanted forfeited bye award to ${r.a2} (the seat SF2's void feeds is dead, X-DW-2)` },
      { ok: finalRanks?.[0] === r.a2, note: `the stage crowned ${finalRanks?.[0] ?? "(none)"} (finalRanks of ${finalRanks?.length ?? 0}), wanted ${r.a2}` },
    );
  }
  return assertion("w2b-withdrawal-both-seats-dead", items);
}

/** apps/web/src/server/public-site/champion.ts BRACKET_SETTLED: the statuses a bracket crown reads a winner off. A
 *  copy, because this layer may not import apps/web/src/server (boundary.test.ts); w2b-scenarios.test.ts pins it to
 *  the product's text. */
export const CROWN_SETTLED: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

/** Who the product crowns on a knockout stage, by champion.ts bracketChampion's rule: the final (isFinal, never a
 *  third-place match) when it is settled AND produced a winner. A knockout has exactly one final, so the rule's later-
 *  final clause (a double elimination's reset) never applies; a stage flagging any other number of finals is refused
 *  by name, never read as "nobody". */
export function knockoutCrown(fixtures: readonly ObservedFixture[]): { ok: true; winner: string | null } | { ok: false; why: string } {
  const finals = fixtures.filter((f) => f.isFinal === true && f.thirdPlace !== true);
  if (finals.length !== 1) return { ok: false, why: `the stage flags ${finals.length} finals (${finals.map((f) => f.id).join(", ") || "none"}), wanted one` };
  const [only] = finals;
  const o = only.outcome;
  const winner = o !== null && (o.kind === "win" || o.kind === "award") ? o.winner : null;
  return { ok: true, winner: CROWN_SETTLED.has(only.status) ? winner : null };
}

/** The vacant title's owner (spec §2.2's handover, W2b-R10: W4, with joint winners). A route, so the Q-A guard reads the
 *  wave it names (routing.ts). */
export const VACANT_TITLE_ROUTE: Route = routeTo("W4", "a vacant title: a finalist withdrawn beside a voided feeder leaves the final void and crowns nobody (X-WD-3); the forfeit-credit wave pins the product's answer and changes nothing");
/** The vacant half's title, naming the deferral. */
export const FINAL_VACANT_TITLE = `X-WD-3/${VACANT_TITLE_ROUTE.wave}: finalist withdraws beside a voided feeder — final void, title vacant (${VACANT_TITLE_ROUTE.wave} owns vacant titles)`;

/** The vacant half (wdCascFinalHalf). a2 withdrew from the final while its other seat was TBD, so her seat there is
 *  dead and departed; SF2's void then killed the other seat, which did not depart. Two dead seats, one departed, is a
 *  void (stages.ts resolveBracketSeats), and a void final crowns nobody (champion.ts). That is the vacant title: the
 *  spec hands it to W4, and W2b pins the product's answer without changing it. Both items read what the run observed:
 *  the final's row, and the crown the product's own rule gives the stage's rows. */
export function finalVacant(r: WdRecord, fixtures: readonly ObservedFixture[]): CheckResult {
  if (r.lines === null || r.a2 === null) return assertion("w2b-withdrawal-final-vacant", [{ ok: false, note: `${FINAL_VACANT_TITLE}: the choreography never reached the final` }]);
  const fin = byExt(fixtures, r.lines.final);
  const seats = fin === undefined ? [] : [fin.home, fin.away].filter((e): e is string => e !== null);
  const crown = knockoutCrown(fixtures);
  return assertion("w2b-withdrawal-final-vacant", [
    { ok: fin?.status === "abandoned" && fin.outcome == null && seats.length === 0, note: `${FINAL_VACANT_TITLE}: ${r.lines.final} is ${fin?.status ?? "(missing)"} ${fin?.outcome == null ? "no outcome" : JSON.stringify(fin.outcome)}, seats ${seats.join(" v ") || "nobody"} — wanted abandoned with no outcome, seats nobody` },
    crown.ok
      ? { ok: crown.winner === null, note: `${FINAL_VACANT_TITLE}: the product's crown rule names ${crown.winner ?? "nobody"} — wanted nobody` }
      : { ok: false, note: `${FINAL_VACANT_TITLE}: ${crown.why}` },
  ]);
}

// ---------------------------------------------------------------------------------------------------------------

function guard(key: W2bScenarioKey, ctx: ScenarioContext): void {
  const { row, sport } = ctx.spec;
  if (!w2bApplies(key, row, sport)) throw new W2bMisplanned(key, row, sport, "not one of the scenario's cells (w2b-cells.ts)");
  const want = key === "AB-AWARD" ? abandonOverride(sport) : null;
  if (want !== null && Object.entries(want).some(([k, v]) => JSON.stringify(ctx.spec.overrides?.[k]) !== JSON.stringify(v))) {
    throw new W2bMisplanned(key, row, sport, `the case carries no ${JSON.stringify(want)} override, so the sport's abandon takes no result by its rule`);
  }
}

async function finish(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, plays: Awaited<ReturnType<typeof playDivision>>, own: (observed: ObservedRun) => Promise<CheckResult[]>, opts: { resultsAsPosted?: false } = {}): Promise<ScenarioOutput> {
  const observed = await snapshot(ctx, rec, setup, plays, { configEdit: null, withdrawal: null });
  const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
  return {
    observed,
    events: rec.events,
    notes: rec.notes,
    assertions: [
      builtAsPosted(setup.built, observed),
      foldParity(rec),
      ...(opts.resultsAsPosted === false ? [] : [resultsAsPosted(rec, observed)]),
      publicStandingsMatch(observed, pub),
      stageCompleted(observed),
      loopBounded(rec, observed),
      advanceSeededAsDeclared(plays, observed, rec.withdrawn),
      lineupsPut(rec, setup),
      // I-3: every bracket drive — the scenario's forfeits and double walkovers among them — against the bracket-finish
      // oracle; where the root is a bracket kind (the hooks drive the root, D12) those forfeits are owed.
      referenceBracketFinish(rec, observed, { forfeitsOwed: forbidsLevelResult(setup.stage.kind) }),
      ...(await own(observed)),
    ],
  };
}

const ENTRANTS = 8;

function scenario(key: W2bScenarioKey, run: (ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup) => Promise<ScenarioOutput>): Scenario {
  return {
    key,
    entrantCount: ENTRANTS,
    canaryCheck: null,
    async run(ctx) {
      guard(key, ctx);
      const rec = new Recorder();
      const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, key, ctx.spec.template));
      return run(ctx, rec, setup);
    },
  };
}

const woPre = scenario("WO-PRE", async (ctx, rec, setup) => {
  const drives: ForfeitDrive[] = [];
  const hooks: RoundHooks = {
    beforeRound: async (_round, batch) => {
      const f = firstScheduled(batch);
      if (f === undefined) return;
      // The absent side alternates, so both the home and the away award are recorded.
      const by: Side = drives.length % 2 === 0 ? "away" : "home";
      drives.push(await drive(ctx, rec, setup, f, { kind: "forfeit", by, reason: "walkover", at: "before_start" }));
    },
  };
  const plays = await playDivision(ctx, rec, setup, hooks);
  return finish(ctx, rec, setup, plays, async (observed) => [
    forfeitRecorded("w2b-walkover-recorded", drives, observed.stages[0].fixtures),
    await walkoverCreditCheck(ctx, rec, setup, drives, observed),
  ]);
});

const rtPart = scenario("RT-PART", async (ctx, rec, setup) => {
  const drives: ForfeitDrive[] = [];
  // X-RT-1's two in-match reasons, as this sport's generator builds them under the stage's cfg: ruling 113 refuses a
  // retirement where nothing is played short of the result (chess), so there the disqualification is driven alone.
  const stageKind = setup.stage.kind as StageKind;
  const reasons: readonly ForfeitReason[] = inMatchReasons(ctx.spec.sport, caseStageCfg(ctx, stageKind), stageKind);
  if (reasons.length === 0) throw new Error(`RT-PART: ${ctx.spec.sport} on a ${stageKind} builds neither a retirement nor a disqualification after partial play — not an RT-PART cell`);
  const hooks: RoundHooks = {
    beforeRound: async (_round, batch) => {
      const f = firstScheduled(batch);
      if (f === undefined) return;
      const n = drives.length;
      const by: Side = n % 2 === 0 ? "home" : "away";
      // X-RT-1: an in-match disqualification takes the retirement's credit, so the two reasons alternate.
      const d = await drive(ctx, rec, setup, f, { kind: "forfeit", by, reason: reasons[n % reasons.length], at: "after_start" });
      const tip = (await ctx.driver.fixtureState(f.id)).last_seq;
      drives.push({ ...d, seq: tip, posted: rec.streams.get(f.id)?.length ?? 0 });
    },
  };
  const plays = await playDivision(ctx, rec, setup, hooks);
  return finish(ctx, rec, setup, plays, async (observed) => [
    forfeitRecorded("w2b-retirement-recorded", drives, observed.stages[0].fixtures),
    partialPlayStands(drives),
    await retirementCreditCheck(ctx, rec, setup, drives, observed),
  ]);
});

const dwAll = scenario("DW-ALL", async (ctx, rec, setup) => {
  const kind = setup.stage.kind;
  // X-DW-3: the bracket kinds whose generators wire feed edges refuse a double walkover with no next match; a table
  // kind and a ladder take one anywhere (the plan's D19).
  const refusesAtTheEnd = BRACKET_STAGE_KINDS.has(kind);
  let graph: FeedGraph | null = null;
  let dw: ForfeitDrive | null = null;
  let attempted = false;
  let noPlacement = false;
  let dead: ReadonlyMap<string, number> | null = null;
  const probes: RefusalProbe[] = [];
  let ladderBefore: string[] | null = null;
  let ladderAfter: string[] | null = null;
  const hooks: RoundHooks = {
    beforeRound: async (_round, batch) => {
      if (refusesAtTheEnd && graph === null) graph = feedGraph(kind, setup.stage.config, fieldBySeed(setup), await stageRows(ctx, setup));
      const g = graph;
      if (g !== null) {
        for (const f of byNo(batch)) if (seated(f) && f.status === "scheduled" && f.ext_key != null && hasNoNextMatch(g, f.ext_key)) probes.push(await probe(ctx, rec, setup, f));
      }
      // The accepted double walkover goes in the FIRST round (step) the loop reaches, or nowhere.
      if (attempted) return;
      attempted = true;
      const open = byNo(batch).filter((f) => seated(f) && f.status === "scheduled");
      const target = g === null ? open[0] : pickDoubleWalkover(g, open);
      if (target === undefined) { noPlacement = g !== null; if (g === null) rec.notes.push("DW-ALL: the first round had no seated, unstarted fixture"); return; }
      if (kind === "ladder") ladderBefore = await ladderOrder(ctx, setup);
      dw = await drive(ctx, rec, setup, target, { kind: "double_walkover" });
      if (kind === "ladder") ladderAfter = await ladderOrder(ctx, setup);
      if (g !== null && target.ext_key != null) dead = deadSeats(g, target.ext_key);
    },
  };
  const plays = await playDivision(ctx, rec, setup, hooks);
  const d = dw as ForfeitDrive | null;
  return finish(ctx, rec, setup, plays, async (observed) => {
    const fixtures = observed.stages[0].fixtures;
    const advances = noPlacement ? assertion("w2b-double-walkover-advances-nobody", [], NO_PLACEMENT)
      : kind === "ladder" ? ladderUnmoved(d, ladderBefore, ladderAfter)
      : refusesAtTheEnd ? doubleWalkoverAdvancesNobody(d, fixtures, dead)
      : assertion("w2b-double-walkover-advances-nobody", [], `a ${kind} table: nobody advances from any match there; its entry is w2b-double-walkover-table's (X-DW-4)`);
    return [
      noPlacement ? assertion("w2b-double-walkover-recorded", [], NO_PLACEMENT) : doubleWalkoverRecorded(d === null ? [] : [d], fixtures),
      advances,
      doubleWalkoverRefusedAtTheEnd(probes, refusesAtTheEnd ? null : `a ${kind} has no fixture a double walkover is refused at: the refusal is the feeding bracket kinds' alone (X-DW-3), a table and a ladder take one anywhere`),
      await doubleWalkoverTableCheck(ctx, rec, setup, d, observed),
    ];
  });
});

const abAward = scenario("AB-AWARD", async (ctx, rec, setup) => {
  const plan = abandonPlan(ctx.spec.sport);
  if (plan === null) throw new W2bMisplanned("AB-AWARD", ctx.spec.row, ctx.spec.sport, "the sport's rule gives no abandon a result");
  const drives: AbandonDrive[] = [];
  const hooks: RoundHooks = {
    beforeRound: async (_round, batch) => {
      const step = plan[drives.length];
      const f = firstScheduled(batch);
      if (step === undefined || f === undefined) return;
      await decideFixture(ctx, rec, setup, f, step.request);
      const home = f.home_entrant_id!;
      const away = f.away_entrant_id!;
      const events = rec.streams.get(f.id) ?? [];
      // The rule's result for this stream: the real engine's fold of what was posted (review M-3); and whether the stage
      // takes a draw: the sport's own declaration for this cfg and kind (X-AB-1).
      const cfg = caseStageCfg(ctx, setup.stage.kind as StageKind);
      const rule = toObservedOutcome(foldStream(sportModule(ctx.spec.sport), cfg, home, away, events).outcome);
      const drawStands = sportModule(ctx.spec.sport).supportsDraws(cfg, setup.stage.kind as StageKind);
      drives.push({ fixtureId: f.id, home, away, kind: step.kind, events, rule, drawStands });
    },
  };
  const plays = await playDivision(ctx, rec, setup, hooks);
  return finish(ctx, rec, setup, plays, async (observed) => [
    abandonWithResult(drives, observed.stages[0].fixtures),
    await abandonTableCheck(ctx, rec, setup, drives, observed),
  ]);
});

const wdCasc = scenario("WD-CASC", async (ctx, rec, setup) => {
  const r: WdRecord = { half: wdCascFinalHalf(ctx.spec.row, ctx.spec.sport), steps: [], walked: [], w1: null, a2: null, a3: null, lines: null, dw: null };
  const cfg = caseStageCfg(ctx, setup.stage.kind as StageKind);
  const withdraw = async (entrantId: string, label: string) => {
    let answer: WithdrawOut;
    try {
      answer = await ctx.driver.withdraw(entrantId);
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      // The entrant stays in: the rest of the choreography plays on, and the refusal is a failing item by name.
      r.steps.push({ entrantId, label, answer: null, refusal: { status: e.status, code: e.code } });
      rec.notes.push(`WD-CASC: the withdrawal of ${entrantId} (${label}) was refused ${e.status} ${e.code ?? "(no code)"}`);
      return;
    }
    rec.facts.add("withdrawn");
    rec.withdrawn.add(entrantId);
    r.steps.push({ entrantId, label, answer });
  };
  // The truth-run's find: left open, the fixture comes back to the round loop, which would post a fresh stream to it.
  const stopIfLeftOpen = async (fixtureId: string, label: string, entrantId: string, posted: boolean) => {
    const why = cascadeLeftOpen(fixtureId, label, (await ctx.driver.fixtureState(fixtureId)).status, rec.withdrawn.has(entrantId) ? "accepted" : "refused", posted);
    if (why !== null) throw new W2bCascadeLeftOpen(why);
  };
  let done = false;
  const hooks: RoundHooks = {
    beforeRound: async (_round, batch) => {
      if (done) return;
      done = true;
      const lines = knockoutLines(feedGraph(setup.stage.kind, setup.stage.config, fieldBySeed(setup), await stageRows(ctx, setup)), batch);
      r.lines = lines;
      const [qf1, qf2] = lines.a.qf;
      const [qf3, qf4] = lines.b.qf;
      // X-WD-3: QF1 is played; its winner withdraws while the semi-final's other seat is TBD.
      const higher: Side = setup.seedOf(qf1.home_entrant_id!) <= setup.seedOf(qf1.away_entrant_id!) ? "home" : "away";
      await decideFixture(ctx, rec, setup, qf1, { kind: "win", winner: higher });
      r.w1 = higher === "home" ? qf1.home_entrant_id! : qf1.away_entrant_id!;
      await withdraw(r.w1, "semi-final opponent TBD");
      // X-WD-1 / BG-WO-3 / D3 R5: QF2 is held (or a chess tie-break pending, or under way) when its home side withdraws.
      const held = heldStream(ctx.spec.sport, cfg, qf2.home_entrant_id!, qf2.away_entrant_id!);
      await ensureLineups(ctx, rec, setup, qf2);
      const posted = await ctx.driver.postStream(qf2.id, held.events, `${ctx.tag}:${qf2.id}`);
      recordPosted(rec, qf2.id, [], held.events, posted);
      rec.events += held.events.length;
      r.a2 = qf2.away_entrant_id!;
      await withdraw(qf2.home_entrant_id!, held.label);
      r.walked.push({ fixtureId: qf2.id, withdrawn: qf2.home_entrant_id!, remaining: r.a2, label: held.label });
      await stopIfLeftOpen(qf2.id, held.label, qf2.home_entrant_id!, true);
      // The vacant half (wdCascFinalHalf; re-review round 2, item 2): a2 walked over SF1 beside w1's dead seat and into
      // the final at once (X-WD-3), and withdraws from it while its other seat is TBD. SF2's void kills that seat later.
      if (r.half === "vacant") await withdraw(r.a2, FINAL_TBD);
      // BG-WO-2 and the bracket row: QF3 not started when its home side withdraws.
      await withdraw(qf3.home_entrant_id!, "not started");
      r.walked.push({ fixtureId: qf3.id, withdrawn: qf3.home_entrant_id!, remaining: qf3.away_entrant_id!, label: "not started" });
      await stopIfLeftOpen(qf3.id, "not started", qf3.home_entrant_id!, false);
      // QF3's walkover winner withdraws from the other semi-final while its seat there is TBD, and QF4 is a recorded
      // double walkover — so both of that semi-final's seats are dead, one of them departed (bothSeatsDead).
      r.a3 = qf3.away_entrant_id!;
      await withdraw(r.a3, "semi-final opponent TBD");
      r.dw = await drive(ctx, rec, setup, qf4, { kind: "double_walkover" });
    },
  };
  const plays = await playDivision(ctx, rec, setup, hooks);
  // The cascades wrote several fixtures no single recorded withdrawal explains: this scenario's own checks judge each.
  return finish(ctx, rec, setup, plays, (observed) => {
    const fixtures = observed.stages[0].fixtures;
    const own = [withdrawalsWalkOver(r, fixtures), tbdSeatWalksOver(r, fixtures), bothSeatsDead(r, fixtures, observed.stages[0].complete?.finalRanks ?? null)];
    return Promise.resolve(r.half === "vacant" ? [...own, finalVacant(r, fixtures)] : own);
  }, { resultsAsPosted: false });
});

export const w2bScenarios: Readonly<Record<W2bScenarioKey, Scenario>> = Object.freeze({
  "WO-PRE": woPre,
  "RT-PART": rtPart,
  "DW-ALL": dwAll,
  "AB-AWARD": abAward,
  "WD-CASC": wdCasc,
});

export type { ObservedOutcome };
