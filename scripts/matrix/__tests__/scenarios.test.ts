import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RefusedCall } from "../lib/driver/types.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { isTerminal, type ObservedFixture, type ObservedOutcome, type ObservedRun } from "../lib/observed.ts";
import { decideState } from "../lib/results.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import {
  CANARY_MARK, FORMAT_LOCK, assertion, builtAsPosted, drawPathExercised, entrantsEditAccepted, foldParity, formatEditRefusedNamed, loopBounded, publicStandingsMatch, resultsAsPosted, stageCompleted,
} from "../lib/scenarios/assertions.ts";
import {
  MAX_ITERATIONS, Recorder, byeDeclared, decideFixture, defaultPolicy, finishStage, playStage, setUpDivision, snapshot, type BuiltReadback, type DivisionSetup, type ParityObs,
} from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { cascadeItems, skippedItem } from "../lib/scenarios/r4-withdrawal.ts";
import { ScenarioUnsupported, type CaseSpec, type ScenarioContext, type ScenarioKey } from "../lib/scenarios/types.ts";
import { START } from "../lib/streams/types.ts";
import { FakeKnockoutDriver, FakeLeagueDriver, FakeSwissDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
type Row = CaseSpec["row"];
interface Opts { canary?: boolean; row?: Row; sport?: string; variant?: string }

function ctxFor(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}): ScenarioContext {
  const sport = opts.sport ?? "generic";
  const variant = opts.variant ?? "score";
  const row = opts.row ?? "league";
  const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${scenario}`, row, sport, variant, scenario, canary: opts.canary ?? false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t" };
}

async function runOn(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}) {
  const out = await SCENARIOS[scenario].run(ctxFor(driver, scenario, opts));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }) };
}
const runFake = (scenario: ScenarioKey, opts: Opts = {}) => runOn(new FakeLeagueDriver(), scenario, opts);
const failed = (checks: { id: string; verdict: string }[]) => checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const SCENARIO_KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

describe("assertion helper — empty first (R25)", () => {
  it("zero items is a fail, abstain carries a reason, one bad item fails", () => {
    expect(assertion("x", [])).toMatchObject({ verdict: "fail", checked: 0 });
    expect(assertion("x", [], "not a bracket")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(assertion("x", [{ ok: true, note: "a" }, { ok: false, note: "b" }])).toMatchObject({ verdict: "fail", checked: 2, evidence: ["b"] });
    expect(assertion("x", [{ ok: true, note: "a" }])).toMatchObject({ verdict: "pass", checked: 1, kind: "assertion" });
  });
});

describe("shared assertions — empty case first, then each way to go red", () => {
  const fx = (over: Partial<ObservedFixture>): ObservedFixture =>
    ({ id: "f1", stageId: "s1", poolId: null, roundNo: 1, home: "a", away: "b", status: "decided", outcome: { kind: "win", winner: "a" }, declared: null, ...over });
  const run = (standings: ObservedRun["stages"][number]["standings"], fixtures: ObservedFixture[] = []): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind: "league", config: {}, field: ["a", "b"], fixtures, standings, generates: [], pairRounds: [], complete: null }],
  });

  it("foldParity: nothing posted is vacuous; a differing product outcome fails; foreign events are unjudgeable", () => {
    expect(foldParity(new Recorder())).toMatchObject({ id: "life-fold-parity", verdict: "fail", checked: 0 });
    const rec = new Recorder();
    rec.parity.push({ fixtureId: "f1", local: { kind: "win", winner: "a" }, product: { kind: "win", winner: "a" }, foreign: 0, finishedBefore: null, request: "match" });
    expect(foldParity(rec)).toMatchObject({ verdict: "pass", checked: 1 });
    rec.parity.push({ fixtureId: "f2", local: { kind: "win", winner: "a" }, product: { kind: "draw" }, foreign: 0, finishedBefore: null, request: "match" });
    expect(foldParity(rec)).toMatchObject({ verdict: "fail", checked: 2, evidence: [expect.stringMatching(/^f2: engine/)] });
    const rec2 = new Recorder();
    rec2.parity.push({ fixtureId: "f3", local: null, product: { kind: "win", winner: "a" }, foreign: 1, finishedBefore: null, request: "match" });
    expect(foldParity(rec2)).toMatchObject({ verdict: "fail", checked: 1, evidence: [expect.stringMatching(/f3: 1 event\(s\) .*did not post/)] });
    // I-1: a fixture already finished before the harness posted fails even when
    // its event count reads 0 (a status written with no events).
    const rec3 = new Recorder();
    rec3.parity.push({ fixtureId: "f4", local: null, product: null, foreign: 0, finishedBefore: "decided", request: null });
    expect(foldParity(rec3)).toMatchObject({ verdict: "fail", checked: 1, evidence: ["f4: already decided before the harness posted — a result it never wrote, and no recorded withdrawal explains it"] });
  });

  it("foldParity (m-4): two nulls are not parity, and a fold that is not what the harness asked for fails even when the product agrees", () => {
    const one = (local: ObservedOutcome | null, product: ObservedOutcome | null, request: ParityObs["request"]) => {
      const rec = new Recorder();
      rec.parity.push({ fixtureId: "f1", local, product, foreign: 0, finishedBefore: null, request });
      return foldParity(rec);
    };
    const a = { kind: "win" as const, winner: "a" };
    expect(one(a, a, "match")).toMatchObject({ verdict: "pass", checked: 1 });
    // Shape drift that nulls both sides: the raw fold may still match the request, but nothing was compared.
    expect(one(null, null, "match")).toMatchObject({ verdict: "fail", checked: 1, evidence: ["f1: engine null vs product null"] });
    expect(one(null, null, "mismatch")).toMatchObject({ verdict: "fail", checked: 1 });
    expect(one(a, a, "mismatch")).toMatchObject({ verdict: "fail", checked: 1, evidence: ['f1: engine {"kind":"win","winner":"a"} vs product {"kind":"win","winner":"a"} — not the outcome the harness asked for'] });
    // An abandon is recorded, not asserted: a fold with no outcome is its answer.
    expect(one(null, null, "unasserted")).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it("builtAsPosted (final review I-2): each item is derived from the POSTED bodies; every way the build can differ fails", () => {
    const body = { kind: "swiss", name: "Swiss", config: { rounds: 5, tiebreak: { a: 1, b: 2 } }, progression: null, seq: 1 };
    const posted = { sport: "generic", variant: "score", stages: [body], entrants: [{ displayName: "Matrix Player 1", seed: 1 }, { displayName: "Matrix Player 2", seed: 2 }] };
    const rows = [{ id: "a", display_name: "Matrix Player 1", seed: 1, status: "active" }, { id: "b", display_name: "Matrix Player 2", seed: 2, status: "active" }];
    const good: BuiltReadback = {
      posted,
      division: { id: "d1", slug: "d", sportKey: "generic", variantKey: "score", config: {} },
      // The server adds keys it owns (rngSeed) and may reorder a nested object: neither is a difference.
      stages: [{ id: "s1", seq: 1, kind: "swiss", config: { tiebreak: { b: 2, a: 1 }, rounds: 5, rngSeed: 7 }, status: "active" }],
      entrants: rows,
      echo: rows,
    };
    const seatedBoth = run([], [fx({})]);
    const ok = builtAsPosted(good, seatedBoth);
    // 3 division/stage-count items + 1 kind + 2 config keys + 2 counts + 2 posted seeds + 2 seated = 12.
    expect(ok).toMatchObject({ id: "life-built-as-posted", verdict: "pass", checked: 12 });
    const bad = (over: Partial<BuiltReadback>, observed = seatedBoth) => builtAsPosted({ ...good, ...over }, observed);
    expect(bad({ division: { ...good.division, sportKey: "badminton" } })).toMatchObject({ verdict: "fail", evidence: ["division sport badminton, posted generic"] });
    expect(bad({ division: { ...good.division, variantKey: "win_loss" } })).toMatchObject({ verdict: "fail", evidence: ["division variant win_loss, posted score"] });
    // A knockout body built as a league.
    expect(bad({ stages: [{ ...good.stages[0]!, kind: "league" }] })).toMatchObject({ verdict: "fail", evidence: ["stage 1: built league, posted swiss"] });
    expect(bad({ stages: [{ ...good.stages[0]!, config: { rounds: 3, tiebreak: { a: 1, b: 2 } } }] })).toMatchObject({ verdict: "fail", evidence: ["stage 1 config.rounds: built 3, posted 5"] });
    expect(bad({ stages: [{ ...good.stages[0]!, config: { rounds: 5 } }] })).toMatchObject({ verdict: "fail", evidence: ['stage 1 config.tiebreak: built undefined, posted {"a":1,"b":2}'] });
    expect(bad({ stages: [{ ...good.stages[0]!, config: { rounds: 5, tiebreak: { a: 1, b: 3 } } }] })).toMatchObject({ verdict: "fail" });
    expect(bad({ stages: [] })).toMatchObject({ verdict: "fail", evidence: ["0 stage(s) built, 1 posted", "stage 1: built nothing, posted swiss", "stage 1 config.rounds: built undefined, posted 5", 'stage 1 config.tiebreak: built undefined, posted {"a":1,"b":2}'] });
    expect(bad({ stages: [...good.stages, { ...good.stages[0]!, id: "s2", seq: 2 }] })).toMatchObject({ verdict: "fail", evidence: ["2 stage(s) built, 1 posted"] });
    // 7 of 8, in miniature: a posted entrant not stored; the add answer short; one stored twice; a stored one seated nowhere.
    expect(bad({ entrants: rows.slice(0, 1) })).toMatchObject({ verdict: "fail", evidence: ["1 entrant(s) stored, 2 posted", "posted seed 2 (Matrix Player 2) stored 0 time(s)"] });
    expect(bad({ echo: rows.slice(0, 1) })).toMatchObject({ verdict: "fail", evidence: ["add answered 1 entrant(s), 2 posted"] });
    expect(bad({ entrants: [...rows, { ...rows[1]!, id: "c" }] })).toMatchObject({ verdict: "fail", evidence: ["3 entrant(s) stored, 2 posted", "posted seed 2 (Matrix Player 2) stored 2 time(s)", "c (seed 2) is seated in no fixture of the stage"] });
    expect(bad({ entrants: [rows[0]!, { ...rows[1]!, display_name: "Someone Else" }] })).toMatchObject({ verdict: "fail", evidence: ["posted seed 2 (Matrix Player 2) stored 0 time(s)"] });
    expect(bad({}, run([], [fx({ away: null, status: "forfeited", outcome: { kind: "award", winner: "a" } })]))).toMatchObject({ verdict: "fail", evidence: ["b (seed 2) is seated in no fixture of the stage"] });
  });

  it("resultsAsPosted (final review I-1): the STORED result of every finished fixture is the harness's fold, a bye, or the recorded cascade's — else it fails", () => {
    const win = (w: string) => ({ kind: "win" as const, winner: w });
    const posted = (rec: Recorder, id: string, local: ObservedOutcome | null, over: Partial<ParityObs> = {}) =>
      rec.parity.push({ fixtureId: id, local, product: local, foreign: 0, finishedBefore: null, request: "match", ...over });
    // Empty first: nothing finished is vacuous, and so is a stage whose only finished rows seat nobody.
    expect(resultsAsPosted(new Recorder(), run([]))).toMatchObject({ id: "life-results-as-posted", verdict: "fail", checked: 0 });
    expect(resultsAsPosted(new Recorder(), run([], [fx({ home: null, away: null, status: "abandoned", outcome: null }), fx({ id: "f2", status: "scheduled", outcome: null })])))
      .toMatchObject({ verdict: "fail", checked: 0 });
    const rec = new Recorder();
    posted(rec, "f1", win("a"));
    expect(resultsAsPosted(rec, run([], [fx({})]))).toMatchObject({ verdict: "pass", checked: 1 });
    // The method is not compared (the fold and the row may name it differently); kind and winner are.
    expect(resultsAsPosted(rec, run([], [fx({ outcome: { kind: "win", winner: "a", method: "regulation" } })]))).toMatchObject({ verdict: "pass" });
    // Stored with the other winner, though the harness posted and folded "a".
    expect(resultsAsPosted(rec, run([], [fx({ outcome: win("b") })])))
      .toMatchObject({ verdict: "fail", checked: 1, evidence: ['f1: stored decided {"kind":"win","winner":"b"}, the harness posted and folded {"kind":"win","winner":"a"}'] });
    // Posted, then voided by nobody the harness can name.
    expect(resultsAsPosted(rec, run([], [fx({ status: "abandoned", outcome: null })]))).toMatchObject({ verdict: "fail", checked: 1 });
    // A result the harness never posted: two-sided, then one-sided but not a bye.
    expect(resultsAsPosted(new Recorder(), run([], [fx({})])))
      .toMatchObject({ verdict: "fail", checked: 1, evidence: ['f1: stored decided {"kind":"win","winner":"a"} — the harness never posted it, and no bye or recorded withdrawal explains it'] });
    expect(resultsAsPosted(new Recorder(), run([], [fx({ away: null, status: "decided", outcome: win("a") })]))).toMatchObject({ verdict: "fail", checked: 1 });
    expect(resultsAsPosted(new Recorder(), run([], [fx({ away: null, status: "forfeited", outcome: { kind: "award", winner: "b" } })]))).toMatchObject({ verdict: "fail", checked: 1 });
    // A bye (a forfeited award to the seated side) is accounted for.
    expect(resultsAsPosted(new Recorder(), run([], [fx({ away: null, status: "forfeited", outcome: { kind: "award", winner: "a" } })]))).toMatchObject({ verdict: "pass", checked: 1 });
    // The harness cannot fold what it does not hold whole: foreign events, finished before it posted, a null local fold.
    for (const over of [{ foreign: 2 }, { finishedBefore: "decided" }, {}] as Partial<ParityObs>[]) {
      const r = new Recorder();
      posted(r, "f1", over.foreign === undefined && over.finishedBefore === undefined ? null : win("a"), over);
      expect(resultsAsPosted(r, run([], [fx({})])), JSON.stringify(over)).toMatchObject({ verdict: "fail", checked: 1, evidence: [expect.stringMatching(/cannot fold/)] });
    }
  });

  it("resultsAsPosted: only the RECORDED withdrawal's cascade explains a result the harness did not post", () => {
    const withW = (fixtures: ObservedFixture[], policy: "walkover" | "expunge", before: { id: string; status: string }[], entrantId = "b"): ObservedRun =>
      ({ ...run([], fixtures), withdrawal: { entrantId, afterRound: 1, policy, walkovers: 0, voided: 0, skippedFinalized: 0, before: before.map((b) => ({ ...b, outcome: null })) } });
    const wo = fx({ id: "wo", status: "forfeited", outcome: { kind: "award", winner: "a" } });
    expect(resultsAsPosted(new Recorder(), withW([wo], "walkover", [{ id: "wo", status: "scheduled" }]))).toMatchObject({ verdict: "pass", checked: 1 });
    // Its twins fail: the fixture was already decided before the withdrawal, another entrant withdrew, no snapshot, or no withdrawal at all.
    expect(resultsAsPosted(new Recorder(), withW([wo], "walkover", [{ id: "wo", status: "decided" }]))).toMatchObject({ verdict: "fail" });
    expect(resultsAsPosted(new Recorder(), withW([wo], "walkover", [{ id: "wo", status: "scheduled" }], "z"))).toMatchObject({ verdict: "fail" });
    expect(resultsAsPosted(new Recorder(), withW([wo], "walkover", []))).toMatchObject({ verdict: "fail" });
    expect(resultsAsPosted(new Recorder(), run([], [wo]))).toMatchObject({ verdict: "fail" });
    // An expunge strikes a result the harness posted: the stored void differs from the fold and is still accounted for...
    const rec = new Recorder();
    rec.parity.push({ fixtureId: "x", local: { kind: "win", winner: "a" }, product: { kind: "win", winner: "a" }, foreign: 0, finishedBefore: null, request: "match" });
    const struck = fx({ id: "x", status: "abandoned", outcome: null });
    expect(resultsAsPosted(rec, withW([struck], "expunge", [{ id: "x", status: "decided" }]))).toMatchObject({ verdict: "pass", checked: 1 });
    // ...but not when the fixture was locked before it, nor under a walkover (which leaves played results standing).
    expect(resultsAsPosted(rec, withW([struck], "expunge", [{ id: "x", status: "finalized" }]))).toMatchObject({ verdict: "fail" });
    expect(resultsAsPosted(rec, withW([struck], "walkover", [{ id: "x", status: "decided" }]))).toMatchObject({ verdict: "fail" });
  });

  it("publicStandingsMatch: nothing on either side is vacuous; a missing pool, a rank and a points drift each fail", () => {
    const pub = (rows: { entrantId: string; rank: number; points?: number }[], pool: string | null = null) =>
      ({ division_id: "d1", standings: [{ stage_id: "s1", pool_id: pool, rows }] });
    const org = [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }] }];
    expect(publicStandingsMatch(run([]), { division_id: "d1", standings: [] })).toMatchObject({ verdict: "fail", checked: 0 });
    expect(publicStandingsMatch(run(org), pub([{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }]))).toMatchObject({ verdict: "pass", checked: 2 });
    expect(publicStandingsMatch(run(org), pub([], "p9"))).toMatchObject({
      verdict: "fail", checked: 2,
      evidence: [expect.stringMatching(/pool null: missing from public/), "stage 1 pool p9: public table with no org table"],
    });
    expect(publicStandingsMatch(run(org), pub([{ entrantId: "a", rank: 2, points: 3 }, { entrantId: "b", rank: 1, points: 0 }]))).toMatchObject({ verdict: "fail", checked: 2 });
    expect(publicStandingsMatch(run(org), pub([{ entrantId: "a", rank: 1, points: 1 }, { entrantId: "b", rank: 2, points: 0 }]))).toMatchObject({ verdict: "fail", checked: 2, evidence: ["a: org 1/3 vs public 1/1"] });
  });

  it("publicStandingsMatch runs BOTH ways (m-4): public ⊆ org as well as org ⊆ public", () => {
    const org = [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }] }];
    const same = [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }];
    // An entrant only the public table shows.
    expect(publicStandingsMatch(run(org), { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: [...same, { entrantId: "z", rank: 3, points: 0 }] }] }))
      .toMatchObject({ verdict: "fail", checked: 3, evidence: ["z: public row (stage 1 pool null) with no org row"] });
    // A pool only the public table shows, beside a matching one.
    expect(publicStandingsMatch(run(org), { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: same }, { stage_id: "s1", pool_id: "p2", rows: [] }] }))
      .toMatchObject({ verdict: "fail", checked: 3, evidence: ["stage 1 pool p2: public table with no org table"] });
    // A stage the run never observed.
    expect(publicStandingsMatch(run(org), { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: same }, { stage_id: "s9", pool_id: null, rows: same }] }))
      .toMatchObject({ verdict: "fail", checked: 3, evidence: ["stage s9: public table for a stage the run never observed"] });
    // An org table with no rows beside a public one that has them: the public rows are extras.
    expect(publicStandingsMatch(run([{ poolId: null, rows: [] }]), { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: same }] }))
      .toMatchObject({ verdict: "fail", checked: 2, evidence: ["a: public row (stage 1 pool null) with no org row", "b: public row (stage 1 pool null) with no org row"] });
  });

  it("stageCompleted (1b): counts only stages whose fixtures are ALL finished, and each must have completed", () => {
    const withComplete = (fixtures: ObservedFixture[], complete: ObservedRun["stages"][number]["complete"]): ObservedRun => {
      const r = run([], fixtures);
      return { ...r, stages: [{ ...r.stages[0]!, complete }] };
    };
    const done = [fx({}), fx({ id: "f2", status: "abandoned", outcome: null })];
    const ok = { status: 200, code: null, completed: true, finalRanks: null };
    // Empty case first: a stage with no fixtures is not "all finished" (the empty set would say yes).
    expect(stageCompleted(withComplete([], ok))).toMatchObject({ id: "life-stage-completed", verdict: "abstain", checked: 0 });
    // An open fixture: not counted — life-loop-bounded owns that case.
    expect(stageCompleted(withComplete([fx({}), fx({ id: "f3", status: "scheduled", outcome: null })], { status: 409, code: "STAGE_INCOMPLETE", completed: false, finalRanks: null })))
      .toMatchObject({ verdict: "abstain", checked: 0 });
    expect(stageCompleted(withComplete(done, ok))).toMatchObject({ verdict: "pass", checked: 1 });
    // All finished, and the product would not finish it: named or not, and a 200 that says completed:false.
    expect(stageCompleted(withComplete(done, { status: 409, code: "STAGE_INCOMPLETE", completed: false, finalRanks: null })))
      .toMatchObject({ verdict: "fail", checked: 1, evidence: ["stage 1: all 2 fixtures finished, complete → 409 STAGE_INCOMPLETE completed=false"] });
    expect(stageCompleted(withComplete(done, { status: 500, code: null, completed: false, finalRanks: null }))).toMatchObject({ verdict: "fail", checked: 1 });
    expect(stageCompleted(withComplete(done, { status: 200, code: null, completed: false, finalRanks: null }))).toMatchObject({ verdict: "fail", checked: 1 });
    expect(stageCompleted(withComplete(done, null))).toMatchObject({ verdict: "fail", checked: 1, evidence: ["stage 1: all 2 fixtures finished, complete → never asked"] });
  });

  it("entrantsEditAccepted (I-2): the entrants-only save must be a 2xx; none attempted is vacuous", () => {
    const edit = (status: number, code: string | null) => ({ attempts: [{ kind: "format" as const, status: 409, code: "FORMAT_LOCKED" }, { kind: "entrants_only" as const, status, code }], before: [], after: [] });
    expect(entrantsEditAccepted({ attempts: [{ kind: "format", status: 409, code: "FORMAT_LOCKED" }], before: [], after: [] })).toMatchObject({ id: "life-entrants-edit-accepted", verdict: "fail", checked: 0 });
    expect(entrantsEditAccepted(edit(200, null))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(entrantsEditAccepted(edit(204, null))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(entrantsEditAccepted(edit(409, "FORMAT_LOCKED"))).toMatchObject({ verdict: "fail", checked: 1, evidence: ["entrants-only save → 409 FORMAT_LOCKED"] });
    expect(entrantsEditAccepted(edit(300, null))).toMatchObject({ verdict: "fail" });
    expect(entrantsEditAccepted(edit(199, null))).toMatchObject({ verdict: "fail" });
  });

  it("drawPathExercised: abstains only when the module declares no draws; zero posted or a lost draw fails", () => {
    expect(drawPathExercised(new Recorder(), run([]), false)).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(drawPathExercised(new Recorder(), run([]), true)).toMatchObject({ verdict: "fail", checked: 1 });
    const rec = new Recorder();
    rec.drawsPosted = 2;
    expect(drawPathExercised(rec, run([], [fx({ outcome: { kind: "draw" } })]), true)).toMatchObject({ verdict: "fail", evidence: ["posted 2 draws, product shows 1"] });
    expect(drawPathExercised(rec, run([], [fx({ outcome: { kind: "draw" } }), fx({ id: "f2", outcome: { kind: "draw" } })]), true)).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it("formatEditRefusedNamed: no format field abstains; only the lock's own 409 FORMAT_LOCKED passes (not 200, not generic CONFLICT, not 500, not another named 4xx)", () => {
    const edit = (status: number, code: string | null) => ({ attempts: [{ kind: "format" as const, status, code }], before: [], after: [] });
    expect(formatEditRefusedNamed({ attempts: [{ kind: "entrants_only", status: 200, code: null }], before: [], after: [] })).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(formatEditRefusedNamed(edit(409, "FORMAT_LOCKED"))).toMatchObject({ verdict: "pass", checked: 1 });
    expect(formatEditRefusedNamed(edit(200, null))).toMatchObject({ verdict: "fail" });
    expect(formatEditRefusedNamed(edit(409, "CONFLICT"))).toMatchObject({ verdict: "fail" });
    expect(formatEditRefusedNamed(edit(500, "MODULE_DUPLICATE"))).toMatchObject({ verdict: "fail" });
    // m-3: a named 4xx that is not the lock's (the lock gone, another domain guard answering) fails too.
    expect(formatEditRefusedNamed(edit(409, "ENTRANT_KIND_IN_USE")))
      .toMatchObject({ verdict: "fail", evidence: ["format edit → 409 ENTRANT_KIND_IN_USE, expected 409 FORMAT_LOCKED"] });
    expect(formatEditRefusedNamed(edit(422, "FORMAT_LOCKED"))).toMatchObject({ verdict: "fail" });
  });
  it("m-3: FORMAT_LOCK is the product's own lock answer, read from usecases/divisions.ts (derived, not typed)", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/server/usecases/divisions.ts"), "utf8");
    const all = [...src.matchAll(/"FORMAT_LOCKED"/g)];
    const thrown = [...src.matchAll(/new HttpError\((\d{3}),[^()]*?,\s*"FORMAT_LOCKED"\)/g)];
    expect(all.length).toBeGreaterThan(0);
    expect(thrown).toHaveLength(all.length); // every mention is a throw we read
    for (const m of thrown) expect({ status: Number(m[1]), code: "FORMAT_LOCKED" }).toEqual({ ...FORMAT_LOCK });
  });

  it("loopBounded (I-1): only a loop that ran dry AND left every fixture finished passes", () => {
    const rec = new Recorder();
    const done = run([], [fx({}), fx({ id: "f2", status: "abandoned", outcome: null })]);
    // A loop that never ran is not a finished one.
    expect(loopBounded(rec, done)).toMatchObject({ id: "life-loop-bounded", verdict: "fail", checked: 2, evidence: ["play loop exited never"] });
    rec.exit = "drained";
    expect(loopBounded(rec, done)).toMatchObject({ verdict: "pass", checked: 2 });
    // Ran dry, but a fixture is still open (a TBD seat nobody filled, a generate that stopped listing it).
    expect(loopBounded(rec, run([], [fx({}), fx({ id: "f3", status: "scheduled", outcome: null }), fx({ id: "f4", status: "in_play", outcome: null })])))
      .toMatchObject({ verdict: "fail", checked: 2, evidence: ["2 fixture(s) left unfinished: f3 scheduled, f4 in_play"] });
    for (const exit of ["cap", "refused_generate", "empty_pair_round"] as const) {
      rec.exit = exit;
      expect(loopBounded(rec, done)).toMatchObject({ verdict: "fail", checked: 2, evidence: [`play loop exited ${exit}`] });
    }
  });
});

describe("LIFECYCLE on the fake league (wiring, not product truth)", () => {
  it("drives the driver in lifecycle order and ends works", async () => {
    const { driver, state, out, checks } = await runFake("LIFECYCLE");
    const firsts = ["createCompetition", "createDivision", "postStages", "addEntrants", "start", "listStages", "getDivision", "listEntrants", "generate"];
    expect(driver.calls.slice(0, firsts.length)).toEqual(firsts);
    const i = (m: string) => driver.calls.lastIndexOf(m);
    expect(i("patchDivisionConfig")).toBeLessThan(i("completeStage"));
    expect(driver.calls.filter((c) => c === "completeStage")).toHaveLength(1);
    expect(i("publicStandings")).toBeGreaterThan(i("completeStage"));
    expect(out.observed.stages[0]!.fixtures).toHaveLength(28); // 8 entrants, single RR
    expect(state, JSON.stringify(checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    expect(checks.find((c) => c.id === "life-draw-path-exercised")).toMatchObject({ verdict: "pass" });
    expect(checks.find((c) => c.id === "life-fold-parity")!.checked).toBe(28);
    expect(checks.find((c) => c.id === "life-loop-bounded")).toMatchObject({ verdict: "pass", checked: 2 });
    expect(checks.find((c) => c.id === "life-entrants-edit-accepted")).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it("I-2: a product that 409s the entrants-only save reds life-entrants-edit-accepted, and only that", async () => {
    class LocksEntrantsToo extends FakeLeagueDriver {
      override async patchDivisionConfig(d: string, c: Record<string, unknown>) {
        return this.fixtures.length > 0 ? { status: 409, code: "FORMAT_LOCKED" } : super.patchDivisionConfig(d, c);
      }
    }
    const r = await runOn(new LocksEntrantsToo(), "LIFECYCLE");
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["life-entrants-edit-accepted"]);
    expect(r.checks.find((c) => c.id === "life-entrants-edit-accepted")!.evidence).toEqual(["entrants-only save → 409 FORMAT_LOCKED"]);
    // The format refusal beside it is still the expected one.
    expect(r.checks.find((c) => c.id === "life-format-edit-refused-named")).toMatchObject({ verdict: "pass" });
  });

  it("R15: a product outcome that differs from the engine's own fold fails life-fold-parity on every fixture", async () => {
    class ReportsNoResult extends FakeLeagueDriver {
      override async postStream(id: string, events: Parameters<FakeLeagueDriver["postStream"]>[1], p = "") {
        return (await super.postStream(id, events, p)).map((x) => (x.outcome === null ? x : { ...x, outcome: { kind: "no_result" } }));
      }
    }
    const r = await runOn(new ReportsNoResult(), "LIFECYCLE");
    const parity = r.checks.find((c) => c.id === "life-fold-parity")!;
    expect(parity).toMatchObject({ verdict: "fail", checked: 28 });
    expect(parity.evidence[0]).toMatch(/^f\d+: engine \{"kind":"(win|draw)".*\} vs product \{"kind":"no_result"\}$/);
  });

  it("every generate is recorded with the fixtures it answered (I4's population)", async () => {
    const { driver, out } = await runFake("LIFECYCLE");
    const g = out.observed.stages[0]!.generates;
    expect(g).toHaveLength(driver.calls.filter((c) => c === "generate").length);
    expect(g.every((x) => x.status === 200 && x.code === null && x.total === driver.fixtures.length)).toBe(true);
  });

  it("a fixture with a TBD seat is never decided; the rest of the stage still plays", async () => {
    class WithTbd extends FakeLeagueDriver {
      override async start() { const out = await super.start(); this.seat(99, this.entrants[0]!.id, null); return out; }
    }
    const driver = new WithTbd();
    await runOn(driver, "LIFECYCLE");
    const tbd = driver.fixtures.find((f) => f.away_entrant_id === null)!;
    expect(tbd).toMatchObject({ status: "scheduled", events: [] });
    expect(driver.fixtures.filter((f) => f !== tbd).every((f) => isTerminal(f.status))).toBe(true);
  });

  it("the config probe: format edit refused FORMAT_LOCKED, entrants-only save accepted (Task 6 ruling)", async () => {
    const { out, checks } = await runFake("LIFECYCLE");
    expect(out.observed.configEdit!.attempts).toEqual([
      { kind: "format", status: 409, code: "FORMAT_LOCKED" },
      { kind: "entrants_only", status: 200, code: null },
    ]);
    expect(checks.find((c) => c.id === "life-format-edit-refused-named")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(checks.find((c) => c.id === "I5-config-edit-never-rescores")).toMatchObject({ verdict: "pass", checked: 28 });
  });

  it("the entrants-only probe spreads the division's CURRENT config (a stored override would otherwise read as a format change)", async () => {
    class Overridden extends FakeLeagueDriver {
      override async createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]) {
        const d = await super.createDivision(c, i);
        this.divisionConfig = { ...this.divisionConfig, points: { w: 5, d: 2, l: 1 } };
        return d;
      }
    }
    const { out, checks } = await runOn(new Overridden(), "LIFECYCLE");
    expect(out.observed.configEdit!.attempts.find((a) => a.kind === "entrants_only")).toEqual({ kind: "entrants_only", status: 200, code: null });
    expect(checks.find((c) => c.id === "life-entrants-edit-accepted")).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it.each(["LIFECYCLE", "M1", "R4", "F1"] as const)("PF8: %s counts every event the harness posted, derived from what the product holds", async (k) => {
    const { driver, out } = await runFake(k);
    const held = driver.fixtures.reduce((n, f) => n + f.events.length, 0);
    expect(held).toBeGreaterThan(0);
    expect(out.events).toBe(held);
  });

  it.each([["generic", "win_loss"], ["badminton", "bwf"]])("%s/%s: a sport with no draws still works; the draw check abstains; its format field is probed", async (sport, variant) => {
    const { state, checks, out } = await runFake("LIFECYCLE", { sport, variant });
    expect(state, JSON.stringify(checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    expect(checks.find((c) => c.id === "life-draw-path-exercised")).toMatchObject({ verdict: "abstain" });
    expect(out.observed.configEdit!.attempts[0]).toEqual({ kind: "format", status: 409, code: "FORMAT_LOCKED" });
  });
});

describe("each scenario's assertion set is exactly its own (dropping one is caught)", () => {
  it.each([
    ["LIFECYCLE", ["life-built-as-posted", "life-fold-parity", "life-results-as-posted", "life-public-standings-match", "life-draw-path-exercised", "life-format-edit-refused-named", "life-entrants-edit-accepted", "life-stage-completed", "life-loop-bounded"]],
    ["M1", ["life-built-as-posted", "life-fold-parity", "life-results-as-posted", "m1-walkover-recorded", "m1-winner-progresses", "life-stage-completed", "life-loop-bounded"]],
    ["R4", ["life-built-as-posted", "life-fold-parity", "life-results-as-posted", "r4-policy-reported", "r4-cascade-consistent", "r4-not-paired-later", "life-stage-completed", "life-loop-bounded"]],
    ["F1", ["life-built-as-posted", "life-fold-parity", "life-results-as-posted", "f1-everyone-drawn", "f1-round-size", "life-stage-completed", "life-loop-bounded"]],
  ] as const)("%s", async (k, ids) => {
    expect((await runFake(k)).out.assertions.map((a) => a.id)).toEqual(ids);
  });
});

describe("final review I-2 on the fakes: a product that builds something other than what was posted reds the case", () => {
  /** Accepts any single stage body, and builds a league with its default config. */
  class SilentLeague extends FakeLeagueDriver {
    override acceptsStage(): boolean { return true; }
    override async postStages(d: string, stages: Parameters<FakeLeagueDriver["postStages"]>[1]) {
      return super.postStages(d, stages.map((b) => ({ ...b, kind: "league", config: { legs: 1 } })));
    }
  }
  /** Stores (and answers) only 7 of the 8 posted entrants. */
  class StoresSeven extends FakeLeagueDriver {
    override async addEntrants(d: string, es: Parameters<FakeLeagueDriver["addEntrants"]>[1]) { return super.addEntrants(d, es.slice(0, -1)); }
  }
  /** Stores all 8, but draws only 7. */
  class SeatsSeven extends FakeLeagueDriver {
    override circle() {
      const all = this.entrants;
      this.entrants = all.slice(0, -1);
      try { return super.circle(); } finally { this.entrants = all; }
    }
  }
  it.each(SCENARIO_KEYS)("knockout %s built as a league reds life-built-as-posted (it read works before)", async (k) => {
    const r = await runOn(new SilentLeague(), k, { row: "knockout" });
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toContain("life-built-as-posted");
    expect(r.checks.find((c) => c.id === "life-built-as-posted")!.evidence).toEqual(["stage 1: built league, posted knockout"]);
  });
  // F1 posts 7, not 8: its twin is the next test.
  it.each(SCENARIO_KEYS.filter((k) => k !== "F1"))("%s: 7 of 8 stored, or 8 stored and 7 seated, reds life-built-as-posted", async (k) => {
    const stored = await runOn(new StoresSeven(), k);
    expect(stored.state.state).toBe("red");
    expect(stored.checks.find((c) => c.id === "life-built-as-posted")!.evidence).toEqual(["7 entrant(s) stored, 8 posted", "add answered 7 entrant(s), 8 posted", "posted seed 8 (Matrix Player 8) stored 0 time(s)"]);
    const seats = await runOn(new SeatsSeven(), k);
    expect(seats.state.state).toBe("red");
    expect(seats.checks.find((c) => c.id === "life-built-as-posted")!.evidence).toEqual(["e8 (seed 8) is seated in no fixture of the stage"]);
  });
  it("F1 (7 posted): 6 stored, or 7 stored and 6 seated, reds it too", async () => {
    expect((await runOn(new StoresSeven(), "F1")).checks.find((c) => c.id === "life-built-as-posted")).toMatchObject({ verdict: "fail", evidence: ["6 entrant(s) stored, 7 posted", "add answered 6 entrant(s), 7 posted", "posted seed 7 (Matrix Player 7) stored 0 time(s)"] });
    expect((await runOn(new SeatsSeven(), "F1")).checks.find((c) => c.id === "life-built-as-posted")).toMatchObject({ verdict: "fail", evidence: ["e7 (seed 7) is seated in no fixture of the stage"] });
  });
  it("the READ-BACK is judged, not the create/add answers: echoing what was posted while storing something else still reds", async () => {
    /** Answers the posted sport/variant on create, but stores (and later reads back) another variant. */
    class StoresOtherVariant extends FakeLeagueDriver {
      override async getDivision() { return { ...(await super.getDivision()), variantKey: "win_loss" }; }
    }
    expect((await runOn(new StoresOtherVariant(), "LIFECYCLE")).checks.find((c) => c.id === "life-built-as-posted"))
      .toMatchObject({ verdict: "fail", evidence: ["division variant win_loss, posted score"] });
    /** Labels the division with a different variant from the one posted, in its create answer AND its read-back: the POSTED value is the spec's, never an answer. */
    class LabelsOtherVariant extends FakeLeagueDriver {
      override async createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]) {
        const d = await super.createDivision(c, i);
        this.variant = "win_loss";
        return { ...d, variantKey: this.variant };
      }
    }
    expect((await runOn(new LabelsOtherVariant(), "M1")).checks.find((c) => c.id === "life-built-as-posted"))
      .toMatchObject({ verdict: "fail", evidence: ["division variant win_loss, posted score"] });
    /** Answers all 8 on add, but stores and draws only 7. */
    class EchoesEight extends FakeLeagueDriver {
      override async addEntrants(d: string, es: Parameters<FakeLeagueDriver["addEntrants"]>[1]) {
        const echo = await super.addEntrants(d, es);
        this.entrants = this.entrants.slice(0, -1);
        return echo;
      }
    }
    expect((await runOn(new EchoesEight(), "LIFECYCLE")).checks.find((c) => c.id === "life-built-as-posted"))
      .toMatchObject({ verdict: "fail", evidence: ["7 entrant(s) stored, 8 posted", "posted seed 8 (Matrix Player 8) stored 0 time(s)"] });
  });
  it("the unmodified fakes pass it on every scenario, row and field size, reading back what was posted", async () => {
    const runs = [
      ...SCENARIO_KEYS.map((k) => runOn(new FakeLeagueDriver(), k)),
      runOn(new FakeKnockoutDriver(), "M1", { row: "knockout" }), runOn(new FakeKnockoutDriver(), "F1", { row: "knockout" }),
      runOn(new FakeSwissDriver(), "F1", { row: "swiss" }), runOn(new FakeSwissDriver(), "LIFECYCLE", { row: "swiss" }),
    ];
    for (const r of await Promise.all(runs)) {
      const c = r.checks.find((x) => x.id === "life-built-as-posted")!;
      expect(c, r.out.observed.caseId).toMatchObject({ verdict: "pass" });
      expect(c.checked, r.out.observed.caseId).toBeGreaterThanOrEqual(3 + 1 + 2 + 2 * 7);
    }
  });
});

describe("final review I-1 on the fakes: a result the harness did not post, or one stored differently, reds the case", () => {
  /** The product decides a seated fixture by itself when the division starts: no withdrawal, no bye. */
  function autoDecides<T extends new () => FakeLeagueDriver>(Base: T) {
    return class extends Base {
      override async start() {
        const out = await super.start();
        const f = this.fixtures.find((x) => x.home_entrant_id !== null && x.away_entrant_id !== null)!;
        await this.postStream(f.id, [START, { type: "core.forfeit", payload: { by: f.away_entrant_id, reason: "walkover" } }], "server");
        return out;
      }
    };
  }
  /** The product answers each POST correctly but READS BACK the first two-sided decided fixture with the other winner. */
  function flipsStored<T extends new () => FakeLeagueDriver>(Base: T) {
    return class extends Base {
      override rows() {
        const rows = super.rows();
        const r = rows.find((x) => x.status === "decided" && x.home_entrant_id !== null && x.away_entrant_id !== null && (x.outcome as { kind?: string } | null)?.kind === "win");
        if (r !== undefined) {
          const o = r.outcome as { winner: string };
          r.outcome = { ...o, winner: o.winner === r.home_entrant_id ? r.away_entrant_id : r.home_entrant_id };
        }
        return rows;
      }
    };
  }
  it.each(["LIFECYCLE", "F1"] as const)("league %s: a result the product wrote on start reds I3 and life-results-as-posted", async (k) => {
    const r = await runOn(new (autoDecides(FakeLeagueDriver))(), k);
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["I3-table-points-equal-declared", "life-results-as-posted"]);
    expect(r.checks.find((c) => c.id === "life-results-as-posted")!.evidence).toEqual([expect.stringMatching(/^f1: stored forfeited .* the harness never posted it/)]);
  });
  it.each(["LIFECYCLE", "F1"] as const)("league %s: a stored winner that differs from the posted one reds I3 and life-results-as-posted (parity reads the POST answer, so it passes)", async (k) => {
    const r = await runOn(new (flipsStored(FakeLeagueDriver))(), k);
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["I3-table-points-equal-declared", "life-results-as-posted"]);
    expect(r.checks.find((c) => c.id === "life-fold-parity")).toMatchObject({ verdict: "pass" });
  });
  it.each(["M1", "F1"] as const)("knockout %s: no table invariant applies — a result written on start reds life-results-as-posted ALONE; a flipped stored winner also reds I2", async (k) => {
    const auto = await runOn(new (autoDecides(FakeKnockoutDriver))(), k, { row: "knockout" });
    expect(auto.state.state).toBe("red");
    expect(failed(auto.checks)).toEqual(["life-results-as-posted"]);
    expect(auto.checks.find((c) => c.id === "life-results-as-posted")!.evidence).toEqual([expect.stringMatching(/^f\d+: stored forfeited \{"kind":"award".* the harness never posted it/)]);
    const flip = await runOn(new (flipsStored(FakeKnockoutDriver))(), k, { row: "knockout" });
    expect(failed(flip.checks)).toEqual(["I2-bracket-one-champion-ranks-permutation", "life-results-as-posted"]);
    expect(flip.checks.find((c) => c.id === "life-results-as-posted")!.evidence).toEqual([expect.stringMatching(/^f\d+: stored decided \{"kind":"win","winner":"(e\d+)".*\}, the harness posted and folded \{"kind":"win","winner":"(?!\1)e\d+"/)]);
  });
  it("R4: a fixture the RECORDED withdrawal finished is left alone even when a stale list still offers it as open", async () => {
    /** The first generate after the withdrawal answers the rows as they stood before it (a lagging read). */
    class StaleAfterWithdraw extends FakeLeagueDriver {
      stale: ReturnType<FakeLeagueDriver["rows"]> | null = null;
      /** Fixtures the harness asked about while they were already finished. */
      readonly askedFinished: string[] = [];
      override async withdraw(id: string) { this.stale = this.rows(); return super.withdraw(id); }
      override async fixtureState(id: string) {
        const s = await super.fixtureState(id);
        if (isTerminal(s.status)) this.askedFinished.push(id);
        return s;
      }
      override async generate() {
        if (this.stale === null) return super.generate();
        const fixtures = this.stale;
        this.stale = null;
        this.log("generate");
        return { created: 0, existing: fixtures.length, fixtures };
      }
    }
    const driver = new StaleAfterWithdraw();
    const r = await runOn(driver, "R4");
    const w = r.out.observed.withdrawal!;
    // The stale batch did offer fixtures the cascade had already finished (pending before it), and they were asked about, never posted over.
    const cascaded = w.before.filter((b) => !isTerminal(b.status)).map((b) => b.id);
    expect(driver.askedFinished.filter((id) => cascaded.includes(id)).length).toBeGreaterThan(0);
    expect(w.policy).toBe("expunge"); // 1 of 7 played after round 1
    expect(r.out.observed.stages[0]!.fixtures.filter((f) => cascaded.includes(f.id)).map((f) => f.status)).toEqual(cascaded.map(() => "abandoned"));
    expect(r.state.state, JSON.stringify(r.checks.filter((c) => c.verdict === "fail"))).toBe("works");
  });
  it("the unmodified fakes stay works on every scenario and row (the new check is not a blanket red)", async () => {
    for (const k of SCENARIO_KEYS) {
      const league = await runOn(new FakeLeagueDriver(), k);
      expect(league.checks.find((c) => c.id === "life-results-as-posted"), k).toMatchObject({ verdict: "pass" });
      expect(league.checks.find((c) => c.id === "life-results-as-posted")!.checked, k).toBeGreaterThan(0);
    }
    for (const k of ["M1", "F1"] as const) {
      const ko = await runOn(new FakeKnockoutDriver(), k, { row: "knockout" });
      expect(ko.checks.find((c) => c.id === "life-results-as-posted"), k).toMatchObject({ verdict: "pass" });
    }
    const swiss = await runOn(new FakeSwissDriver(), "F1", { row: "swiss" });
    expect(swiss.checks.find((c) => c.id === "life-results-as-posted")).toMatchObject({ verdict: "pass" });
  });
});

describe("pilots on the fake league", () => {
  /** m-1: the canary's own check keeps its right-answer items (they pass) and adds the marked wrong ones (they fail). */
  const differential = (r: Awaited<ReturnType<typeof runFake>>, id: string, right: number) => {
    const c = r.checks.find((x) => x.id === id)!;
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(c.evidence.every((l) => l.startsWith(CANARY_MARK)), c.evidence.join(" | ")).toBe(true);
    expect(c.checked).toBeGreaterThan(right); // the right items are still there, beside the wrong ones
  };
  it("M1: walkover recorded for seed 1; the canary ALSO expects the absent side and goes red on that check, for that reason only", async () => {
    const r = await runFake("M1");
    expect(r.state.state).toBe("works");
    const own = r.checks.find((c) => c.id === "m1-walkover-recorded")!;
    expect(own.checked).toBe(2);
    const canary = await runFake("M1", { canary: true });
    expect(canary.state.state).toBe("red");
    expect(failed(canary.checks)).toEqual(["m1-walkover-recorded"]);
    differential(canary, "m1-walkover-recorded", own.checked);
  });
  it("R4: policy reported and cascade consistent; the canary evaluates the opposite policy", async () => {
    const r = await runFake("R4");
    expect(r.out.observed.facts).toContain("withdrawn");
    expect(r.checks.find((c) => c.id === "r4-cascade-consistent")).toMatchObject({ verdict: "pass" });
    const canary = await runFake("R4", { canary: true });
    expect(failed(canary.checks)).toEqual(["r4-cascade-consistent"]);
    differential(canary, "r4-cascade-consistent", r.checks.find((c) => c.id === "r4-cascade-consistent")!.checked);
  });
  it("F1: 7 entrants, every round seats floor(7/2)=3; the canary's ceil goes red", async () => {
    const r = await runFake("F1");
    expect(r.checks.find((c) => c.id === "f1-round-size")).toMatchObject({ verdict: "pass", checked: 7 });
    const canary = await runFake("F1", { canary: true });
    expect(failed(canary.checks)).toEqual(["f1-round-size"]);
    differential(canary, "f1-round-size", 7);
    expect(canary.checks.find((c) => c.id === "f1-round-size")!.checked).toBe(14);
  });
  it("M1: exactly ONE walkover — seed 1's first fixture — and the bracket-only check abstains on a league", async () => {
    const r = await runFake("M1");
    const seed1 = r.driver.entrants.find((e) => e.seed === 1)!.id;
    const fixtures = r.out.observed.stages[0]!.fixtures;
    const firstRound = Math.min(...fixtures.filter((f) => f.home === seed1 || f.away === seed1).map((f) => f.roundNo ?? 0));
    const forfeited = fixtures.filter((f) => f.status === "forfeited");
    expect(forfeited).toHaveLength(1);
    expect(forfeited[0]).toMatchObject({ roundNo: firstRound });
    expect([forfeited[0]!.home, forfeited[0]!.away]).toContain(seed1);
    expect(r.checks.find((c) => c.id === "m1-winner-progresses")).toMatchObject({ verdict: "abstain", checked: 0 });
    // Through the driver's forfeit door, which re-reads the fixture before composing (http-driver.ts).
    expect(r.driver.calls.filter((c) => c === "forfeit")).toHaveLength(1);
  });
  it("M1: a walkover the product reads back as plain 'decided' fails m1-walkover-recorded on its status", async () => {
    class ForfeitReadsDecided extends FakeLeagueDriver {
      override async listFixtures() { return (await super.listFixtures()).map((f) => (f.status === "forfeited" ? { ...f, status: "decided" } : f)); }
    }
    const r = await runOn(new ForfeitReadsDecided(), "M1");
    expect(failed(r.checks)).toEqual(["m1-walkover-recorded"]);
    expect(r.checks.find((c) => c.id === "m1-walkover-recorded")!.evidence).toEqual(["status decided, expected forfeited"]);
  });
  it("R4 on the league fake: 1 of 7 played at the withdrawal, so the engine's policy is expunge; the case works", async () => {
    const r = await runFake("R4");
    expect(r.state, JSON.stringify(r.checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    const w = r.out.observed.withdrawal!;
    const played = w.before.filter((b) => isTerminal(b.status)).length;
    expect([played, w.before.length]).toEqual([1, 7]);
    expect(w).toMatchObject({ afterRound: 1, policy: played / w.before.length < 0.5 ? "expunge" : "walkover" });
    expect(r.out.observed.facts).toEqual(expect.arrayContaining(["withdrawn", "expunged"]));
  });
  it("R4 (m-3): a voided count that disagrees with the cascade observed fails r4-cascade-consistent, naming both", async () => {
    class MiscountsVoided extends FakeLeagueDriver {
      override async withdraw(id: string) { const o = await super.withdraw(id); return { ...o, voided: o.voided + 1 }; }
    }
    const r = await runOn(new MiscountsVoided(), "R4");
    const w = r.out.observed.withdrawal!;
    expect(w.policy).toBe("expunge");
    expect(failed(r.checks)).toEqual(["r4-cascade-consistent"]);
    expect(r.checks.find((c) => c.id === "r4-cascade-consistent")!.evidence).toEqual([`reported ${w.voided} voided, observed ${w.voided - 1}`]);
  });
  it("R4 (m-5): a skipped_finalized count that disagrees with the fixtures the cascade had to leave fails r4-cascade-consistent, naming both", async () => {
    class MiscountsSkipped extends FakeLeagueDriver {
      override async withdraw(id: string) { const o = await super.withdraw(id); return { ...o, skipped_finalized: o.skipped_finalized + 1 }; }
    }
    const r = await runOn(new MiscountsSkipped(), "R4");
    const w = r.out.observed.withdrawal!;
    expect(w.policy).toBe("expunge");
    expect(failed(r.checks)).toEqual(["r4-cascade-consistent"]);
    expect(r.checks.find((c) => c.id === "r4-cascade-consistent")!.evidence).toEqual([`reported ${w.skippedFinalized} locked fixture(s) skipped, observed ${w.skippedFinalized - 1}`]);
  });
  it("R4: a withdrawal the product reports as policy 'none' fails r4-policy-reported", async () => {
    class NoPolicy extends FakeLeagueDriver {
      override async withdraw(id: string) { return { ...(await super.withdraw(id)), policy: "none" as const }; }
    }
    const r = await runOn(new NoPolicy(), "R4");
    expect(r.checks.find((c) => c.id === "r4-policy-reported")).toMatchObject({ verdict: "fail", evidence: ["policy none on a started division"] });
  });
  it("R4: nothing to play means nobody withdrew — r4-policy-reported fails, never a vacuous green", async () => {
    class NothingOpen extends FakeLeagueDriver {
      override async generate() { return { ...(await super.generate()), fixtures: [] }; }
    }
    const r = await runOn(new NothingOpen(), "R4");
    expect(r.out.observed.withdrawal).toBeNull();
    expect(r.checks.find((c) => c.id === "r4-policy-reported")).toMatchObject({ verdict: "fail", evidence: ["round 1 never finished; nobody withdrew"] });
    // …and the empty generate itself is what I4 names (R13).
    expect(r.checks.find((c) => c.id === "I4-nothing-ends-stuck")!.evidence).toContain("stage 1: empty generate (R13)");
  });
  it("F1: an entrant the product never draws fails f1-everyone-drawn, naming it", async () => {
    class LeavesOneOut extends FakeLeagueDriver {
      override async start() {
        const out = await super.start();
        const last = this.entrants.at(-1)!.id;
        this.fixtures = this.fixtures.filter((f) => f.home_entrant_id !== last && f.away_entrant_id !== last);
        return out;
      }
    }
    const driver = new LeavesOneOut();
    const r = await runOn(driver, "F1");
    expect(r.checks.find((c) => c.id === "f1-everyone-drawn")).toMatchObject({ verdict: "fail", checked: 7, evidence: [`${driver.entrants.at(-1)!.id} appears in no fixture`] });
  });
  it("every scenario is registered under its own key and the three pilots name their canary check", () => {
    expect(SCENARIO_KEYS.sort()).toEqual(["F1", "LIFECYCLE", "M1", "R4"]);
    for (const k of SCENARIO_KEYS) expect(SCENARIOS[k].key).toBe(k);
    expect(SCENARIOS.LIFECYCLE.canaryCheck).toBeNull();
    expect([SCENARIOS.M1.canaryCheck, SCENARIOS.R4.canaryCheck, SCENARIOS.F1.canaryCheck]).toEqual(["m1-walkover-recorded", "r4-cascade-consistent", "f1-round-size"]);
  });
});

describe("PF5: a cut_short run is red in EVERY scenario, through life-loop-bounded", () => {
  // generate keeps answering the round-1 fixtures as still open while the
  // fixtures themselves are finished, so the loop never runs dry.
  class Stuck extends FakeLeagueDriver {
    override async generate() {
      const g = await super.generate();
      return { ...g, fixtures: g.fixtures.map((f) => (f.round_no === 1 ? { ...f, status: "scheduled", outcome: null } : f)).filter((f) => f.round_no === 1) };
    }
  }
  it.each(["LIFECYCLE", "M1", "R4", "F1"] as const)("%s", async (k) => {
    const driver = new Stuck();
    const r = await runOn(driver, k);
    expect(r.out.observed.facts).toContain("cut_short");
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["life-loop-bounded"]);
    expect(r.checks.find((c) => c.id === "life-loop-bounded")!.evidence[0]).toBe("play loop exited cap");
    // The cap is what stopped it: exactly MAX_ITERATIONS generates.
    expect(driver.calls.filter((c) => c === "generate")).toHaveLength(MAX_ITERATIONS);
  });
  it("the config probe reads FINISHED fixtures only, before and after (I5's population)", async () => {
    const driver = new Stuck();
    const r = await runOn(driver, "LIFECYCLE");
    const before = r.out.observed.configEdit!.before;
    expect(before.length).toBe(driver.fixtures.filter((f) => isTerminal(f.status)).length);
    expect(before.length).toBeLessThan(driver.fixtures.length);
    expect(before.every((b) => isTerminal(b.status))).toBe(true);
  });
});

describe("I-1: a stage the loop left unfinished is red in EVERY scenario, even when every refusal is named", () => {
  // The review's probe: generate answers three times, then is refused BY NAME;
  // complete is refused by name too. I4 accepts both (named refusals), so
  // before I-1 the loop's silent return read ✅ with most fixtures unplayed.
  class StopsEarly extends FakeLeagueDriver {
    answered = 0;
    override async generate() {
      if (this.answered++ >= 3) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", 409, "STAGE_NOT_READY", "not ready");
      return super.generate();
    }
    override async completeStage(): Promise<never> { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, "STAGE_INCOMPLETE", "open fixtures"); }
  }
  it.each(["LIFECYCLE", "M1", "R4", "F1"] as const)("%s", async (k) => {
    const driver = new StopsEarly();
    const r = await runOn(driver, k);
    const open = driver.fixtures.filter((f) => !isTerminal(f.status));
    expect(open.length).toBeGreaterThan(0);
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["life-loop-bounded"]);
    expect(r.checks.find((c) => c.id === "life-loop-bounded")!.evidence)
      .toEqual(["play loop exited refused_generate", expect.stringMatching(new RegExp(`^${open.length} fixture\\(s\\) left unfinished: ${open[0]!.id} scheduled`))]);
    // I4 is satisfied by the named refusals — life-loop-bounded is what reds it.
    expect(r.checks.find((c) => c.id === "I4-nothing-ends-stuck")).toMatchObject({ verdict: "pass" });
    // Open fixtures: the stage is not "all finished", so life-stage-completed does not count it.
    expect(r.checks.find((c) => c.id === "life-stage-completed")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(r.out.observed.stages[0]!.complete).toMatchObject({ status: 409, code: "STAGE_INCOMPLETE", completed: false });
  });
  it("a generate that answers 200 but stops LISTING open fixtures runs 'dry' and is still red (open fixtures)", async () => {
    class ForgetsFixtures extends FakeLeagueDriver {
      override async generate() { const g = await super.generate(); return { ...g, fixtures: g.fixtures.filter((f) => f.round_no === 1) }; }
    }
    const driver = new ForgetsFixtures();
    const r = await runOn(driver, "LIFECYCLE");
    const open = driver.fixtures.filter((f) => !isTerminal(f.status)).length;
    expect(open).toBe(24); // 28 fixtures, round 1's four played
    expect(r.checks.find((c) => c.id === "life-loop-bounded")).toMatchObject({ verdict: "fail", checked: 2, evidence: [expect.stringMatching(/^24 fixture\(s\) left unfinished: /)] });
  });
});

describe("1b: a stage whose fixtures are ALL finished must complete — in EVERY scenario", () => {
  class RefusesComplete extends FakeLeagueDriver {
    override async completeStage(): Promise<never> { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, "STAGE_INCOMPLETE", "open fixtures"); }
  }
  class CompletesFalse extends FakeLeagueDriver {
    override async completeStage() { return { completed: false, events: [] }; }
  }
  it.each(["LIFECYCLE", "M1", "R4", "F1"] as const)("%s: completed → pass; a NAMED refusal → red on exactly life-stage-completed", async (k) => {
    const good = await runFake(k);
    expect(good.checks.find((c) => c.id === "life-stage-completed")).toMatchObject({ verdict: "pass", checked: 1 });
    const driver = new RefusesComplete();
    const r = await runOn(driver, k);
    expect(driver.fixtures.every((f) => isTerminal(f.status))).toBe(true);
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual(["life-stage-completed"]);
    // I4 judges only that the refusal is named — it passes.
    expect(r.checks.find((c) => c.id === "I4-nothing-ends-stuck")).toMatchObject({ verdict: "pass" });
  });
  it("a 200 that answers completed:false is red here too (and I4 names it unnamed)", async () => {
    const r = await runOn(new CompletesFalse(), "LIFECYCLE");
    expect(failed(r.checks)).toEqual(["I4-nothing-ends-stuck", "life-stage-completed"]);
    expect(r.checks.find((c) => c.id === "life-stage-completed")!.evidence).toEqual(["stage 1: all 28 fixtures finished, complete → 200 (no code) completed=false"]);
  });
  it("on the swiss and knockout fakes too", async () => {
    class SwissRefuses extends FakeSwissDriver {
      override async completeStage(): Promise<never> { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, "STAGE_INCOMPLETE", "x"); }
    }
    class KnockoutRefuses extends FakeKnockoutDriver {
      override async completeStage(): Promise<never> { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, "STAGE_INCOMPLETE", "x"); }
    }
    const s = await runOn(new SwissRefuses(), "R4", { row: "swiss" });
    expect(failed(s.checks)).toEqual(["life-stage-completed"]);
    const k = await runOn(new KnockoutRefuses(), "F1", { row: "knockout" });
    // I2 needs a completed bracket, so it abstains; the stage check is what reds.
    expect(failed(k.checks)).toEqual(["life-stage-completed"]);
  });
});

describe("deferrals are named", () => {
  it("a multi-stage row is ScenarioUnsupported(W1b), not a crash, before any driver call", async () => {
    const driver = new FakeLeagueDriver();
    await expect(runOn(driver, "LIFECYCLE", { row: "league_ko" })).rejects.toBeInstanceOf(ScenarioUnsupported);
    await expect(runOn(driver, "LIFECYCLE", { row: "league_ko" })).rejects.toMatchObject({ wave: "W1b", message: expect.stringMatching(/multi-stage/) });
    expect(driver.calls).toEqual([]);
  });
  it.each(["ladder", "americano", "mexicano"] as const)("%s is ScenarioUnsupported(W1b) before any driver call", async (row) => {
    const driver = new FakeLeagueDriver();
    await expect(runOn(driver, "LIFECYCLE", { row })).rejects.toMatchObject({ name: "ScenarioUnsupported", wave: "W1b", message: expect.stringContaining(row) });
    expect(driver.calls).toEqual([]);
  });
  it("a team sport is ScenarioUnsupported(W1b, team rosters) before any driver call", async () => {
    const driver = new FakeLeagueDriver();
    const football = Object.keys(sportModule("football").variants as object)[0]!;
    await expect(runOn(driver, "LIFECYCLE", { sport: "football", variant: football })).rejects.toMatchObject({ name: "ScenarioUnsupported", wave: "W1b", message: "team rosters" });
    expect(driver.calls).toEqual([]);
  });
});

describe("setup, generate and complete — refusals are recorded, crashes propagate, gaps are named", () => {
  it("a division with no stage after start, or a seed nobody holds, is a named error", async () => {
    class NoStage extends FakeLeagueDriver { override async listStages() { return []; } }
    await expect(runOn(new NoStage(), "LIFECYCLE")).rejects.toThrow(/has no stage after start/);
    const driver = new FakeLeagueDriver();
    const setup = await setUpDivision(ctxFor(driver, "LIFECYCLE"), new Recorder(), 2);
    expect(setup.idOfSeed(2)).toBe(driver.entrants[1]!.id);
    expect(() => setup.idOfSeed(3)).toThrow("scenario: no entrant holds seed 3");
  });
  it("a generate refused with a code is recorded for I4 (a named refusal passes it); a crash is not swallowed", async () => {
    class Refuses extends FakeLeagueDriver {
      override async generate(): Promise<never> { throw new RefusedCall("POST", "/api/v1/stages/s1/generate", 409, "STAGE_NOT_READY", "not ready"); }
    }
    const r = await runOn(new Refuses(), "F1");
    expect(r.out.observed.stages[0]!.generates).toEqual([{ status: 409, code: "STAGE_NOT_READY", total: 0, created: 0 }]);
    class Crashes extends FakeLeagueDriver { override async generate(): Promise<never> { throw new TypeError("boom"); } }
    await expect(runOn(new Crashes(), "F1")).rejects.toThrow("boom");
  });
  it("finishStage: a refused complete is recorded with its code, finalRanks come from stage_completed, a crash propagates", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE");
    const setup = await setUpDivision(ctx, new Recorder(), 2);
    driver.completeStage = async () => { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, "STAGE_INCOMPLETE", "open fixtures"); };
    expect(await finishStage(ctx, new Recorder(), setup)).toEqual({ status: 409, code: "STAGE_INCOMPLETE", completed: false, finalRanks: null });
    driver.completeStage = async () => ({ completed: true, events: [{ type: "stage_opened" }, { type: "stage_completed", finalRanks: ["e2", "e1"] }] });
    expect(await finishStage(ctx, new Recorder(), setup)).toEqual({ status: 200, code: null, completed: true, finalRanks: ["e2", "e1"] });
    driver.completeStage = async () => { throw new TypeError("boom"); };
    await expect(finishStage(ctx, new Recorder(), setup)).rejects.toThrow("boom");
  });
});

describe("decideFixture — the local fold is the fixture's WHOLE stream (Task 6 ruling)", () => {
  async function onBadminton() {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "badminton", variant: "bwf" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    const f = (await driver.listFixtures("d1"))[0]!;
    return { driver, ctx, rec, setup, f };
  }
  it("a forfeit on a live fixture the harness already started posts only core.forfeit and folds the full stream", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await driver.postStream(f.id, [START], "t");
    rec.streams.set(f.id, [START]);
    await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "retired hurt" });
    const held = driver.fixtures.find((x) => x.id === f.id)!.events;
    expect(held.map((e) => e.type)).toEqual(["core.start", "core.forfeit"]);
    expect(rec.streams.get(f.id)).toEqual(held);
    expect(rec.events).toBe(1);
    expect(foldParity(rec)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(rec.declared.get(f.id)).toMatchObject({ forOutcome: { kind: "award", winner: f.home_entrant_id } });
    expect(rec.parity[0]!.request).toBe("match"); // m-4: the fold is the award to the side that did NOT forfeit
  });
  it("m-4: decideFixture records whether the fold is what it asked for, per requested outcome (an abandon is recorded, not asserted)", async () => {
    const cases = [
      [{ kind: "win", winner: "home" }, "match"], [{ kind: "win", winner: "away" }, "match"],
      [{ kind: "forfeit", by: "home", reason: "walkover" }, "match"], [{ kind: "abandon" }, "unasserted"],
    ] as const;
    for (const [outcome, want] of cases) {
      const { ctx, rec, setup, f } = await onBadminton();
      await decideFixture(ctx, rec, setup, f, outcome);
      expect(rec.parity, JSON.stringify(outcome)).toEqual([expect.objectContaining({ foreign: 0, request: want })]);
    }
  });
  it("m-2: a forfeit on a fixture the harness started UNDER THE SAME PREFIX is written, not replayed as the earlier START", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    const prefix = `${ctx.tag}:${f.id}`; // decideFixture's own prefix
    await driver.postStream(f.id, [START], prefix);
    rec.streams.set(f.id, [START]);
    await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "retired hurt" });
    expect(driver.fixtures.find((x) => x.id === f.id)!.events.map((e) => e.type)).toEqual(["core.start", "core.forfeit"]);
    expect([...driver.keys.get(f.id)!.keys()]).toEqual([`${prefix}:s0`, `${prefix}:s1`]);
    expect(foldParity(rec)).toMatchObject({ verdict: "pass", checked: 1 });
  });
  it("parked Task 6 (b): events that landed on a SEQ_CONFLICT retry are noted for the parity trace; none, no note", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "home" });
    expect(rec.notes.filter((n) => n.includes("SEQ_CONFLICT"))).toEqual([]);
    const g = driver.fixtures.find((x) => x.id !== f.id && x.status === "scheduled")!;
    const orig = driver.postStream.bind(driver);
    driver.postStream = async (id, evs, p) => (await orig(id, evs, p)).map((e, i) => (i === 0 ? { ...e, retried: true } : e));
    await decideFixture(ctx, rec, setup, g, { kind: "win", winner: "home" });
    expect(rec.notes.filter((n) => n.includes("SEQ_CONFLICT"))).toEqual([`${g.id}: 1 event(s) landed on a SEQ_CONFLICT retry`]);
  });
  it("m-2: the fake replays a repeated (fixture, key) like the product: the first answer, nothing appended", async () => {
    const { driver, f } = await onBadminton();
    const first = await driver.postStream(f.id, [START], "p");
    driver.fixtures.find((x) => x.id === f.id)!.events = []; // rewind the ledger so the same seq — and key — comes round again
    const again = await driver.postStream(f.id, [START], "p");
    expect(again).toEqual(first);
    expect(driver.fixtures.find((x) => x.id === f.id)!.events).toEqual([]);
  });
  it("events on the fixture the harness never posted make parity unjudgeable, not a silent pass", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await driver.postStream(f.id, [START], "t"); // not recorded: a foreign write
    await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "walkover" });
    expect(foldParity(rec)).toMatchObject({ verdict: "fail", checked: 1 });
    expect(rec.declared.has(f.id)).toBe(false);
  });
  // Final review I-1. This test used to be "a fixture already finished (a
  // server cascade) is left alone", with no cascade in its setup: it pinned a
  // silent return for ANY finished fixture, a frozen bug. A result the harness
  // never wrote now fails parity unless it posted there itself or a recorded
  // withdrawal's cascade could have.
  it("a fixture already finished by a write the harness never made is a failing parity item, not a silent return", async () => {
    const { driver, ctx, rec, setup, f } = await onBadminton();
    await driver.forfeit(f.id, f.away_entrant_id!, "walkover", "x"); // not recorded: a foreign write
    const before = driver.calls.length;
    await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "home" });
    expect(driver.calls.slice(before)).toEqual(["fixtureState"]); // still posts nothing over it
    expect(rec.parity).toEqual([{ fixtureId: f.id, local: null, product: { kind: "award", winner: f.home_entrant_id, method: "walkover" }, foreign: 2, finishedBefore: "forfeited", request: null }]);
    expect(foldParity(rec)).toMatchObject({ verdict: "fail", checked: 1, evidence: [`${f.id}: already forfeited before the harness posted — a result it never wrote, and no recorded withdrawal explains it`] });
    expect(rec.declared.has(f.id)).toBe(false);
  });
  it("...and left alone only when the harness posted there itself (M1's forfeit) or a RECORDED withdrawal seats it", async () => {
    for (const explain of ["own post", "withdrawn home", "withdrawn away"] as const) {
      const { driver, ctx, rec, setup, f } = await onBadminton();
      const posted = await driver.forfeit(f.id, f.away_entrant_id!, "walkover", "x");
      if (explain === "own post") rec.streams.set(f.id, driver.fixtures.find((x) => x.id === f.id)!.events);
      else rec.withdrawn.add(explain === "withdrawn home" ? f.home_entrant_id! : f.away_entrant_id!);
      expect(posted.at(-1)!.status).toBe("forfeited");
      const before = driver.calls.length;
      await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "home" });
      expect(driver.calls.slice(before), explain).toEqual(["fixtureState"]);
      expect(rec.parity, explain).toHaveLength(0);
    }
  });
});

describe("defaultPolicy — draws only where the module declares them, else the better seed wins", () => {
  const setup = { seedOf: (id: string) => Number(id.slice(1)) } as unknown as DivisionSetup;
  const f = { home_entrant_id: "e5", away_entrant_id: "e2" } as never;
  it("every third decision is a draw when drawOk, never otherwise; the lower seed number wins from either side", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => defaultPolicy(setup, f, true, n).kind)).toEqual(["win", "win", "draw", "win", "win", "draw"]);
    expect([0, 1, 2].map((n) => defaultPolicy(setup, f, false, n))).toEqual([0, 1, 2].map(() => ({ kind: "win", winner: "away" })));
    expect(defaultPolicy(setup, { home_entrant_id: "e1", away_entrant_id: "e2" } as never, false, 0)).toEqual({ kind: "win", winner: "home" });
  });
});

describe("snapshot — byes are declared, pools stay separate (Task 5 carries)", () => {
  it("byeDeclared is standingsDelta for the award, on the seated side; two-sided and non-award rows are not byes", () => {
    const cfg = resolveSportCfg("generic", "score", { points: { w: 5, d: 2, l: 1 } }) as { points: { w: number } };
    expect(cfg.points.w).toBe(5); // the override applied, and differs from the default 3
    const bye = (home: string | null, away: string | null): ObservedFixture =>
      ({ id: "b", stageId: "s1", poolId: null, roundNo: 2, home, away, status: "forfeited", outcome: { kind: "award", winner: "a", method: "bye" }, declared: null });
    expect(byeDeclared("generic", cfg, "swiss", bye("a", null))).toEqual({ home: cfg.points.w, away: 0, forOutcome: { kind: "award", winner: "a", method: "bye" } });
    expect(byeDeclared("generic", cfg, "swiss", bye(null, "a"))).toEqual({ home: 0, away: cfg.points.w, forOutcome: { kind: "award", winner: "a", method: "bye" } });
    expect(byeDeclared("generic", cfg, "swiss", bye("a", "c"))).toBeNull();
    expect(byeDeclared("generic", cfg, "swiss", { ...bye("a", null), outcome: { kind: "draw" } })).toBeNull();
    expect(byeDeclared("generic", cfg, "swiss", { ...bye("a", null), outcome: null })).toBeNull();
    // The engine's only legitimate one-sided finished shape is an AWARD to the seated side.
    expect(byeDeclared("generic", cfg, "swiss", { ...bye("a", null), outcome: { kind: "win", winner: "a" } })).toBeNull();
    expect(byeDeclared("generic", cfg, "swiss", bye("x", null))).toBeNull();
  });

  it("a 5-entrant 5-round swiss gives everyone a bye and I3 still checks all 5 (not vacuous)", async () => {
    const driver = new FakeSwissDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "swiss" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 5);
    await playStage(ctx, rec, setup);
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const byes = observed.stages[0]!.fixtures.filter((f) => f.away === null);
    expect(new Set(byes.map((f) => f.home))).toEqual(new Set(setup.entrants.map((e) => e.id)));
    expect(byes.every((f) => f.declared !== null)).toBe(true);
    expect(evaluateInvariants(observed).find((c) => c.id === "I3-table-points-equal-declared")).toMatchObject({ verdict: "pass", checked: 5 });
  });

  it("each pool's table is read on its own and keeps its poolId (a merged table would red I1/I3)", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE");
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    driver.fixtures.forEach((f, i) => { f.pool_id = i % 2 === 0 ? "p1" : "p2"; });
    const observed = await snapshot(ctx, rec, setup, { complete: { status: 200, code: null, completed: false, finalRanks: null }, configEdit: null, withdrawal: null });
    expect(observed.stages[0]!.standings.map((p) => p.poolId).sort()).toEqual(["p1", "p2"]);
    expect(driver.calls.filter((c) => c === "standings")).toHaveLength(2);
  });
});

describe("the swiss branch of playStage on the swiss fake", () => {
  it.each(SCENARIO_KEYS.map((k) => [k]))("%s works, and pairs exactly the round budget, one round per generate", async (k) => {
    const r = await runOn(new FakeSwissDriver(), k, { row: "swiss" });
    expect(r.state, JSON.stringify(r.checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    const s = r.out.observed.stages[0]!;
    const budget = Number(s.config.rounds);
    expect(budget).toBeGreaterThan(1);
    expect(s.pairRounds.map((p) => p.roundNo)).toEqual(Array.from({ length: budget }, (_, i) => i + 1));
    // Seated = floor(active field / 2): every entrant until the R4 withdrawal after round 1.
    const active = (round: number) => s.field.length - (k === "R4" && round > 1 ? 1 : 0);
    expect(s.pairRounds.map((p) => p.seated)).toEqual(s.pairRounds.map((p) => Math.floor(active(p.roundNo) / 2)));
    expect(r.checks.find((c) => c.id === "I6-swiss-no-rematch")).toMatchObject({ verdict: "pass" });
  });
  it("R4 on swiss: walkover policy, and the withdrawn entrant is never paired again", async () => {
    const r = await runOn(new FakeSwissDriver(), "R4", { row: "swiss" });
    expect(r.out.observed.withdrawal).toMatchObject({ policy: "walkover" });
    expect(r.checks.find((c) => c.id === "r4-not-paired-later")).toMatchObject({ verdict: "pass" });
    expect(r.checks.find((c) => c.id === "r4-not-paired-later")!.checked).toBeGreaterThan(0);
  });
  it("F1 on swiss inspects every round", async () => {
    const r = await runOn(new FakeSwissDriver(), "F1", { row: "swiss" });
    expect(r.checks.find((c) => c.id === "f1-round-size")).toMatchObject({ verdict: "pass", checked: Number(r.out.observed.stages[0]!.config.rounds) });
  });
  it("R4 on swiss: a product that keeps pairing the withdrawn entrant fails r4-not-paired-later", async () => {
    class KeepsPairing extends FakeSwissDriver { override sittingOut() { return new Set<string>(); } }
    const r = await runOn(new KeepsPairing(), "R4", { row: "swiss" });
    expect(r.checks.find((c) => c.id === "r4-not-paired-later")).toMatchObject({ verdict: "fail" });
  });
  it("an empty pair round stops the swiss loop there, and I4 names it", async () => {
    class StopsPairing extends FakeSwissDriver { override pairNext() { return this.paired === 0 ? super.pairNext() : 0; } }
    const r = await runOn(new StopsPairing(), "LIFECYCLE", { row: "swiss" });
    const n = r.out.observed.stages[0]!.field.length;
    expect(r.out.observed.stages[0]!.pairRounds).toEqual([{ roundNo: 1, seated: Math.floor(n / 2) }, { roundNo: 2, seated: 0 }]);
    expect(r.checks.find((c) => c.id === "I4-nothing-ends-stuck")!.evidence).toContain("stage 1: round 2 paired nobody (SW-H1)");
    // …and the loop says why it stopped, with round 2's empty shells still open.
    expect(r.checks.find((c) => c.id === "life-loop-bounded")!.evidence[0]).toBe("play loop exited empty_pair_round");
  });
  it("a Pair refused by name mid-stage stops the swiss loop and life-loop-bounded names the refusal", async () => {
    class RefusesRound3 extends FakeSwissDriver {
      override async generate() {
        if (this.paired === 2) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", 409, "STAGE_NOT_READY", "not ready");
        return super.generate();
      }
    }
    const r = await runOn(new RefusesRound3(), "LIFECYCLE", { row: "swiss" });
    expect(r.out.observed.stages[0]!.generates.at(-1)).toEqual({ status: 409, code: "STAGE_NOT_READY", total: 0, created: 0 });
    expect(r.checks.find((c) => c.id === "life-loop-bounded")).toMatchObject({ verdict: "fail", evidence: ["play loop exited refused_generate", expect.stringMatching(/fixture\(s\) left unfinished/)] });
  });
  it("a swiss batch is round r only, even when the stage already lists a later seated fixture (an ad-hoc addFixture at maxRound + 1)", async () => {
    class AdHocAhead extends FakeSwissDriver {
      override async start() { const out = await super.start(); this.seat(this.budget + 1, this.entrants[0]!.id, this.entrants[1]!.id); return out; }
    }
    const r = await runOn(new AdHocAhead(), "LIFECYCLE", { row: "swiss" });
    const n = r.out.observed.stages[0]!.field.length;
    expect(r.out.observed.stages[0]!.pairRounds.map((p) => p.seated)).toEqual(r.out.observed.stages[0]!.pairRounds.map(() => Math.floor(n / 2)));
  });
  it("m-5: start mints an empty shell per board for EVERY round and seats nobody; each generate seats one round onto its shells", async () => {
    const driver = new FakeSwissDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "swiss" });
    const setup = await setUpDivision(ctx, new Recorder(), 7);
    const budget = driver.budget;
    // swiss-shell.ts planSwissShells: floor(7/2) boards + one bye shell per round.
    expect(driver.fixtures).toHaveLength(budget * 4);
    expect(driver.fixtures.every((f) => f.home_entrant_id === null && f.away_entrant_id === null && f.status === "scheduled")).toBe(true);
    const ids = driver.fixtures.map((f) => f.id);
    const g = await driver.generate(setup.stage.id);
    expect(g.created).toBe(0); // seating UPDATEs shells (stages.ts swissGen)
    expect(driver.fixtures.map((f) => f.id)).toEqual(ids);
    const r1 = driver.fixtures.filter((f) => f.round_no === 1);
    expect(r1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)).toHaveLength(3);
    expect(r1.filter((f) => f.away_entrant_id === null)).toEqual([expect.objectContaining({ status: "forfeited", outcome: { kind: "award", winner: r1.find((f) => f.away_entrant_id === null)!.home_entrant_id } })]);
    expect(driver.fixtures.filter((f) => (f.round_no ?? 0) > 1).every((f) => f.home_entrant_id === null)).toBe(true);
    // The next round is refused while this one has an undecided board (stages.ts swissGen gate).
    await expect(driver.generate(setup.stage.id)).rejects.toMatchObject({ status: 409, code: "STAGE_NOT_READY" });
  });
  it("m-5: a withdrawal reshapes the next round's shells to the active field (8 → 7: one board shell dropped, a bye shell minted)", async () => {
    const r = await runOn(new FakeSwissDriver(), "R4", { row: "swiss" });
    const fx = r.out.observed.stages[0]!.fixtures;
    const inRound = (n: number) => fx.filter((f) => f.roundNo === n);
    expect(inRound(1).filter((f) => f.away === null)).toHaveLength(0);
    expect([inRound(2).filter((f) => f.home !== null && f.away !== null).length, inRound(2).filter((f) => f.away === null).length]).toEqual([3, 1]);
    expect(fx.every((f) => isTerminal(f.status))).toBe(true);
  });
});

describe("m-6: the swiss canaries each go red on their own check", () => {
  it.each(["M1", "R4", "F1"] as const)("%s", async (k) => {
    const r = await runOn(new FakeSwissDriver(), k, { row: "swiss", canary: true });
    expect(r.state.state).toBe("red");
    expect(failed(r.checks)).toEqual([SCENARIOS[k].canaryCheck]);
  });
});

describe("m-1: brackets on the knockout fake (M1's progression, F1's first round)", () => {
  it("M1 works: the walkover goes to seed 1 and seed 1 plays on in a later round", async () => {
    const r = await runOn(new FakeKnockoutDriver(), "M1", { row: "knockout" });
    expect(r.state, JSON.stringify(r.checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    expect(r.checks.find((c) => c.id === "m1-winner-progresses")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(r.checks.find((c) => c.id === "I2-bracket-one-champion-ranks-permutation")).toMatchObject({ verdict: "pass" });
    const canary = await runOn(new FakeKnockoutDriver(), "M1", { row: "knockout", canary: true });
    expect(failed(canary.checks)).toEqual(["m1-walkover-recorded"]);
  });
  it("M1: a bracket that does not carry a walkover's winner forward fails m1-winner-progresses", async () => {
    class DropsWalkoverWinner extends FakeKnockoutDriver { override carriesForward(f: { status: string }) { return f.status !== "forfeited"; } }
    const r = await runOn(new DropsWalkoverWinner(), "M1", { row: "knockout" });
    expect(r.checks.find((c) => c.id === "m1-winner-progresses")).toMatchObject({ verdict: "fail", evidence: ["seed 1 absent from every later round"] });
  });
  it("F1: 7 entrants — round 1 seats 3 boards beside seed 1's bye, only round 1 is inspected, and the canary's ceil goes red", async () => {
    const r = await runOn(new FakeKnockoutDriver(), "F1", { row: "knockout" });
    expect(r.state, JSON.stringify(r.checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    const rounds = new Set(r.out.observed.stages[0]!.fixtures.map((f) => f.roundNo));
    expect(rounds.size).toBe(3); // later rounds hold 2 and 1 boards: inspecting them would red
    expect(r.checks.find((c) => c.id === "f1-round-size")).toMatchObject({ verdict: "pass", checked: 1 });
    const bye = r.out.observed.stages[0]!.fixtures.filter((f) => f.roundNo === 1 && f.away === null);
    expect(bye).toEqual([expect.objectContaining({ home: r.driver.entrants[0]!.id, status: "forfeited", outcome: { kind: "award", winner: r.driver.entrants[0]!.id } })]);
    const canary = await runOn(new FakeKnockoutDriver(), "F1", { row: "knockout", canary: true });
    expect(failed(canary.checks)).toEqual(["f1-round-size"]);
  });
});

describe("cascadeItems — consistency with the policy the engine CHOSE", () => {
  const after = (id: string, status: string, outcome: ObservedFixture["outcome"], home: string | null = "w", away: string | null = "x"): ObservedFixture =>
    ({ id, stageId: "s1", poolId: null, roundNo: 2, home, away, status, outcome, declared: null });
  const ok = (items: { ok: boolean }[]) => items.map((i) => i.ok);

  it("expunge: every touched fixture abandons; finalized and cancelled are left as they were", () => {
    const before = [
      { id: "a", status: "decided", outcome: { kind: "win" as const, winner: "w" } },
      { id: "b", status: "scheduled", outcome: null },
      { id: "c", status: "finalized", outcome: { kind: "win" as const, winner: "x" } },
      { id: "d", status: "cancelled", outcome: null },
    ];
    const good = [after("a", "abandoned", null), after("b", "abandoned", null), after("c", "finalized", { kind: "win", winner: "x" }), after("d", "cancelled", null)];
    // The last item is the voided count (m-3): two fixtures abandoned by the cascade.
    expect(ok(cascadeItems("expunge", "w", before, good, 0, 2))).toEqual([true, true, true, true, true]);
    expect(ok(cascadeItems("expunge", "w", before, good, 0, 3))).toEqual([true, true, true, true, false]);
    const bad = [after("a", "decided", { kind: "win", winner: "w" }), after("b", "forfeited", { kind: "award", winner: "x" }), after("c", "abandoned", null), after("d", "abandoned", null)];
    expect(ok(cascadeItems("expunge", "w", before, bad, 0, 0))).toEqual([false, false, false, false, true]);
  });

  it("the voided count covers only what the cascade abandoned — a fixture already abandoned before it does not count (withdrawal.ts applyUpdate)", () => {
    const before = [{ id: "a", status: "abandoned", outcome: null }, { id: "b", status: "scheduled", outcome: null }];
    const after2 = [after("a", "abandoned", null), after("b", "abandoned", null)];
    expect(cascadeItems("expunge", "w", before, after2, 0, 1).at(-1)).toEqual({ ok: true, note: "reported 1 voided, observed 1" });
    expect(cascadeItems("expunge", "w", before, after2, 0, 2).at(-1)).toEqual({ ok: false, note: "reported 2 voided, observed 1" });
  });

  it("walkover: a pending game goes to the OPPONENT; a TBD seat is voided; the reported count must match", () => {
    const before = [
      { id: "a", status: "decided", outcome: { kind: "win" as const, winner: "w" } },
      { id: "b", status: "scheduled", outcome: null },
      { id: "t", status: "scheduled", outcome: null },
    ];
    const good = [after("a", "decided", { kind: "win", winner: "w" }), after("b", "forfeited", { kind: "award", winner: "x" }), after("t", "abandoned", null, "w", null)];
    // …then the walkover count, then the voided count (the TBD seat).
    expect(ok(cascadeItems("walkover", "w", before, good, 1, 1))).toEqual([true, true, true, true, true]);
    expect(ok(cascadeItems("walkover", "w", before, good, 2, 1))).toEqual([true, true, true, false, true]);
    expect(ok(cascadeItems("walkover", "w", before, good, 1, 0))).toEqual([true, true, true, true, false]);
    const toW = [good[0]!, after("b", "forfeited", { kind: "award", winner: "w" }), good[2]!];
    expect(ok(cascadeItems("walkover", "w", before, toW, 0, 1))).toEqual([true, false, true, true, true]);
    const toThirdParty = [good[0]!, after("b", "forfeited", { kind: "award", winner: "z" }), good[2]!];
    expect(ok(cascadeItems("walkover", "w", before, toThirdParty, 0, 1))).toEqual([true, false, true, true, true]);
    expect(ok(cascadeItems("walkover", "w", before, [good[0]!, good[1]!], 1, 1))).toEqual([true, true, false, true, false]);
  });
});

describe("skippedItem (m-5) — the locked fixtures withdrawal.ts reports it skipped", () => {
  const before = [
    { id: "a", status: "finalized", outcome: { kind: "win" as const, winner: "w" } },
    { id: "b", status: "finalized", outcome: { kind: "win" as const, winner: "x" } },
    { id: "c", status: "decided", outcome: { kind: "win" as const, winner: "w" } },
    { id: "d", status: "cancelled", outcome: null },
    { id: "e", status: "scheduled", outcome: null },
  ];
  it("expunge plans the PLAYED fixtures, so the finalized ones with a result are the ones it must skip", () => {
    expect(skippedItem("expunge", before, 2)).toEqual({ ok: true, note: "reported 2 locked fixture(s) skipped, observed 2" });
    expect(skippedItem("expunge", before, 0)).toEqual({ ok: false, note: "reported 0 locked fixture(s) skipped, observed 2" });
    expect(skippedItem("expunge", before, 3).ok).toBe(false);
  });
  it("a cancelled fixture has no result, so an expunge never planned it — it is not counted as skipped", () => {
    expect(skippedItem("expunge", [before[3]!], 0)).toEqual({ ok: true, note: "reported 0 locked fixture(s) skipped, observed 0" });
    expect(skippedItem("expunge", [before[3]!], 1).ok).toBe(false);
  });
  it("a finalized fixture WITHOUT a result was never played (lib/table-withdrawal.ts), so an expunge never planned it either", () => {
    const noResult = [{ id: "f", status: "finalized", outcome: null }];
    expect(skippedItem("expunge", noResult, 0)).toEqual({ ok: true, note: "reported 0 locked fixture(s) skipped, observed 0" });
    expect(skippedItem("expunge", noResult, 1).ok).toBe(false);
  });
  it("walkover plans pending fixtures only, and a pending fixture is never locked — it skips none", () => {
    expect(skippedItem("walkover", before, 0)).toEqual({ ok: true, note: "reported 0 locked fixture(s) skipped, observed 0" });
    expect(skippedItem("walkover", before, 2).ok).toBe(false);
  });
});
