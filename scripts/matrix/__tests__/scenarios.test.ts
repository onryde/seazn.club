import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generatePagePlayoff } from "@seazn/engine/scheduling";
import { resolvePositions, validateLineup } from "@seazn/engine/sport";
import { describe, expect, it } from "vitest";
import { buildRuleOverride } from "../../../apps/web/src/lib/match-rules.ts";
import { RULES, decide } from "../lib/applicability.ts";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { NoFieldSize, fieldSizeFor } from "../lib/field-size.ts";
import { RefusedCall, type EntrantInput, type EntrantRow, type LineupSlotWire } from "../lib/driver/types.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { isTerminal, type ObservedFixture, type ObservedOutcome, type ObservedRun } from "../lib/observed.ts";
import { decideState } from "../lib/results.ts";
import { entrantKindFor, resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import {
  CANARY_MARK, FORMAT_LOCK, assertion, builtAsPosted, drawPathExercised, entrantsEditAccepted, foldParity, formatEditRefusedNamed, loopBounded, publicStandingsMatch, resultsAsPosted, stageCompleted,
} from "../lib/scenarios/assertions.ts";
import {
  DRIVING_WAVE, LINEUP_ISSUE_TEXT, LineupWarned, MAX_ITERATIONS, Recorder, buildDivision, byeDeclared, decideFixture, defaultPolicy, ensureLineups, finishStage, lineupWarningKind, personsNeeded, playStage, setUpDivision, snapshot,
  type BuiltReadback, type DivisionSetup, type ParityObs,
} from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { cascadeItems, skippedItem } from "../lib/scenarios/r4-withdrawal.ts";
import { SIDE_SIZE_ROUTE, rosterSize } from "../lib/scenarios/rosters.ts";
import { ScenarioUnsupported, type CaseSpec, type ScenarioContext, type ScenarioKey } from "../lib/scenarios/types.ts";
import { START } from "../lib/streams/types.ts";
import { offlineBuilderDefault, type VariantCase } from "../lib/variants.ts";
import { FakeKnockoutDriver, FakeLeagueDriver, FakeSwissDriver, type FakeFixture } from "./fake-driver.ts";
import { wireCodeFor } from "./product-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Task 8 m-7: the status api-v1 answers STAGE_NOT_READY with, read from the
 *  product's own ENGINE_HTTP table (server/api-v1/http.ts), never typed here. */
const STAGE_NOT_READY_STATUS = ((): number => {
  const m = /^\s*STAGE_NOT_READY: (\d{3}),$/m.exec(readFileSync(resolve(REPO, "apps/web/src/server/api-v1/http.ts"), "utf8"));
  if (m === null) throw new Error("server/api-v1/http.ts no longer maps STAGE_NOT_READY in ENGINE_HTTP");
  return Number(m[1]);
})();
type Row = CaseSpec["row"];
interface Opts { canary?: boolean; row?: Row; sport?: string; variant?: string }

function ctxFor(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}): ScenarioContext {
  const sport = opts.sport ?? "generic";
  const variant = opts.variant ?? "score";
  const row = opts.row ?? "league";
  const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${scenario}`, row, sport, variant, scenario, canary: opts.canary ?? false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
}

async function runOn(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}) {
  const out = await SCENARIOS[scenario].run(ctxFor(driver, scenario, opts));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }) };
}
const runFake = (scenario: ScenarioKey, opts: Opts = {}) => runOn(new FakeLeagueDriver(), scenario, opts);
const failed = (checks: { id: string; verdict: string }[]) => checks.filter((c) => c.verdict === "fail").map((c) => c.id);
/** The fixture-driving scenarios. DENIED (⛔, Task 9) builds no stage and runs
 *  only on a gated row whose org is denied; denied.test.ts is its suite.
 *  PADPROOF (W1c Task 7) scores on the pad and finalizes from the console,
 *  which the plain league fake does neither of; pad-proof.test.ts is its suite. */
const SCENARIO_KEYS = (Object.keys(SCENARIOS) as ScenarioKey[]).filter((k) => k !== "DENIED" && k !== "PADPROOF");

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
    stages: [{ id: "s1", seq: 1, kind: "league", config: {}, field: ["a", "b"], fieldSource: "division", fixtures, standings, generates: [], pairRounds: [], complete: null }],
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
    const posted = { sport: "generic", variant: "score", stages: [body], entrants: [{ displayName: "Matrix Player 1", seed: 1 }, { displayName: "Matrix Player 2", seed: 2 }], config: {} };
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
    // snapshot observes the ROOT stage, so its field is the division's (W1a carry 1)…
    expect(out.observed.stages.map((s) => [s.seq, s.fieldSource])).toEqual([[1, "division"]]);
    // …and the step-safe checks judge the whole lifecycle: C(8,2) pairs, every Generate answer.
    expect(checks.find((c) => c.id === "I7-rr-no-pair-over-legs")).toMatchObject({ verdict: "pass", checked: 28 });
    expect(checks.find((c) => c.id === "I8-generate-named")).toMatchObject({ verdict: "pass", checked: driver.calls.filter((c) => c === "generate").length });
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

describe("LIFECYCLE with a variant override (Task 10)", () => {
  // single-sport: the editor-built override path on the fake; the registry-wide sweep of the item is the next block.
  const inherited = sportModule("generic").variants.score as Record<string, unknown>;
  const overrides = buildRuleOverride("generic", { allowDraws: "off" }, inherited);
  const key = Object.keys(overrides)[0]!;
  const spec = (o?: Record<string, unknown>) => ({ caseId: "league|generic|score|LIFECYCLE|v", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, ...(o === undefined ? {} : { overrides: o }) }) as CaseSpec;
  const run = (driver: FakeLeagueDriver, o?: Record<string, unknown>) =>
    SCENARIOS.LIFECYCLE.run({ driver, spec: spec(o), orgSlug: "o", cfg: resolveSportCfg("generic", "score", o ?? {}), tag: "t", denied: [] });
  it("the override is non-empty and changes the preset (else this block proves nothing)", () => {
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
    expect(resolveSportCfg("generic", "score", overrides)).not.toEqual(resolveSportCfg("generic", "score"));
  });
  it("the division is CREATED with the override, and life-built-as-posted judges one more item per overridden key, and passes", async () => {
    const posted: unknown[] = [];
    class Records extends FakeLeagueDriver {
      override createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]) { posted.push(i.config); return super.createDivision(c, i); }
    }
    const plain = (await run(new Records())).assertions.find((a) => a.id === "life-built-as-posted")!;
    const withO = (await run(new Records(), overrides)).assertions.find((a) => a.id === "life-built-as-posted")!;
    expect(posted).toEqual([{}, overrides]);
    expect(plain.verdict).toBe("pass");
    expect(withO.verdict).toBe("pass");
    expect(withO.checked).toBe(plain.checked + Object.keys(overrides).length);
  });
  it("the fake scores under the override, as the product's config_snapshot does", async () => {
    const d = new FakeLeagueDriver();
    await run(d, overrides);
    expect(d.cfg).toEqual(resolveSportCfg("generic", "score", overrides));
    expect(d.cfg).not.toEqual(resolveSportCfg("generic", "score"));
  });
  it("a product that stores something else under the key reds it, naming config.<key>", async () => {
    class Tampered extends FakeLeagueDriver {
      override getDivision() { return super.getDivision().then((d) => ({ ...d, config: { ...d.config, [key]: !(d.config[key] as boolean) } })); }
    }
    const a = (await run(new Tampered(), overrides)).assertions.find((x) => x.id === "life-built-as-posted")!;
    expect(a.verdict).toBe("fail");
    expect(a.evidence.join(" ")).toContain(`config.${key}`);
  });
  it("a product that DROPS the override (stores the bare preset) reds it too", async () => {
    class Drops extends FakeLeagueDriver {
      override createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]) { return super.createDivision(c, { ...i, config: {} }); }
    }
    const a = (await run(new Drops(), overrides)).assertions.find((x) => x.id === "life-built-as-posted")!;
    expect(a.verdict).toBe("fail");
    expect(a.evidence).toEqual([`division config.${key}: built ${JSON.stringify(inherited[key])}, the engine resolves ${JSON.stringify(overrides[key])}`]);
  });
});

describe("builtAsPosted's override items, swept over the sport registry (Task 10)", () => {
  const committed = (JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/variants.json"), "utf8")) as { sports: { sport: string; cases: VariantCase[] }[] }).sports;
  const readback = (sport: string, variant: string, config: Record<string, unknown>, stored: Record<string, unknown>): BuiltReadback => ({
    posted: { sport, variant, stages: [], entrants: [], config },
    division: { id: "d1", slug: "d", sportKey: sport, variantKey: variant, config: stored },
    stages: [], entrants: [], echo: [],
  });
  const none: ObservedRun = { caseId: "c", facts: [], withdrawal: null, configEdit: null, stages: [] };
  it("every registry sport: its first committed override is one item per key, passing on the engine's parse and failing, by key, on any other stored value", () => {
    let keys = 0;
    for (const sport of SPORT_KEYS) {
      const vc = committed.find((s) => s.sport === sport)?.cases.find((c) => Object.keys(c.overrides).length > 0);
      expect(vc, `${sport}: no committed case carries an override`).toBeDefined();
      const cfg = resolveSportCfg(sport, vc!.preset, { ...vc!.overrides }) as Record<string, unknown>;
      const base = builtAsPosted(readback(sport, vc!.preset, {}, cfg), none);
      const ok = builtAsPosted(readback(sport, vc!.preset, { ...vc!.overrides }, cfg), none);
      expect(ok.verdict, `${sport}: ${ok.reason}`).toBe("pass");
      expect(ok.checked, sport).toBe(base.checked + Object.keys(vc!.overrides).length);
      for (const k of Object.keys(vc!.overrides)) {
        const bad = builtAsPosted(readback(sport, vc!.preset, { ...vc!.overrides }, { ...cfg, [k]: { tampered: k } }), none);
        expect(bad.verdict, `${sport}.${k}`).toBe("fail");
        expect(bad.evidence.length, `${sport}.${k}`).toBe(1);
        expect(bad.evidence[0], `${sport}.${k}`).toMatch(new RegExp(`^division config\\.${k}: built \\{"tampered":"${k}"\\}, the engine resolves `));
        keys++;
      }
    }
    expect(keys).toBeGreaterThanOrEqual(SPORT_KEYS.length);
  });
  it("the expected value is the engine's PARSE of preset + override, never the raw override (a product storing the raw one reds)", () => {
    // A committed override whose parse differs from what was sent: the schema
    // fills the rest of a partly-overridden nested object.
    let found: { vc: VariantCase; k: string; cfg: Record<string, unknown> } | null = null;
    for (const vc of committed.flatMap((s) => s.cases)) {
      let cfg: Record<string, unknown>;
      try { cfg = resolveSportCfg(vc.sport, vc.preset, { ...vc.overrides }) as Record<string, unknown>; } catch { continue; }
      const k = Object.keys(vc.overrides).find((x) => !isDeepStrictEqual(cfg[x], vc.overrides[x]));
      if (k !== undefined) { found = { vc, k, cfg }; break; }
    }
    expect(found, "no committed override parses to something other than what was sent").not.toBeNull();
    const { vc, k, cfg } = found!;
    expect(builtAsPosted(readback(vc.sport, vc.preset, { ...vc.overrides }, cfg), none).verdict).toBe("pass");
    const raw = builtAsPosted(readback(vc.sport, vc.preset, { ...vc.overrides }, { ...cfg, [k]: vc.overrides[k] }), none);
    expect(raw.verdict).toBe("fail");
    expect(raw.evidence[0]).toMatch(new RegExp(`^division config\\.${k}: `));
    // Key order inside a stored nested value is not a difference.
    const reordered = Object.fromEntries(Object.entries(cfg[k] as Record<string, unknown>).reverse());
    expect(builtAsPosted(readback(vc.sport, vc.preset, { ...vc.overrides }, { ...cfg, [k]: reordered }), none).verdict).toBe("pass");
  });
});

describe("knockout_third_place: the third-place match is BUILT, not only stored (T3 review G1)", () => {
  const tp = stagesForRow("knockout_third_place")[0]!;
  const ko = stagesForRow("knockout")[0]!;
  const fx = (over: Partial<ObservedFixture>): ObservedFixture =>
    ({ id: "f1", stageId: "s1", poolId: null, roundNo: 1, home: "a", away: "b", status: "decided", outcome: { kind: "win", winner: "a" }, declared: null, ...over });
  const readback = (body: typeof tp): BuiltReadback => ({
    posted: { sport: "generic", variant: "score", stages: [body], entrants: [], config: {} },
    division: { id: "d1", slug: "d", sportKey: "generic", variantKey: "score", config: {} },
    stages: [{ id: "s1", seq: 1, kind: body.kind, config: { ...body.config }, status: "active" }],
    entrants: [], echo: [],
  });
  const observed = (fixtures: ObservedFixture[]): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind: "knockout", config: {}, field: [], fieldSource: "division", fixtures, standings: [], generates: [], pairRounds: [], complete: null }],
  });
  it("the row posts a knockout with config.thirdPlace true; the plain knockout does not", () => {
    expect(tp.kind).toBe("knockout");
    expect(tp.config.thirdPlace).toBe(true);
    expect(ko.config.thirdPlace).toBeUndefined();
  });
  it("exactly one fixture flagged third place passes; none or two fail, naming the count", () => {
    const one = builtAsPosted(readback(tp), observed([fx({}), fx({ id: "f2", thirdPlace: true })]));
    expect(one).toMatchObject({ verdict: "pass" });
    expect(builtAsPosted(readback(tp), observed([fx({})]))).toMatchObject({ verdict: "fail", evidence: ["stage 1: posted thirdPlace, built 0 third-place fixture(s)"] });
    expect(builtAsPosted(readback(tp), observed([fx({ thirdPlace: true }), fx({ id: "f2", thirdPlace: true })]))).toMatchObject({ verdict: "fail", evidence: ["stage 1: posted thirdPlace, built 2 third-place fixture(s)"] });
  });
  it("fix round 1, m-4: two-sided — a plain knockout must build NO third-place fixture; one unasked reds, naming the count", () => {
    const one = builtAsPosted(readback(tp), observed([fx({}), fx({ id: "f2", thirdPlace: true })]));
    const plain = builtAsPosted(readback(ko), observed([fx({})]));
    expect(plain.verdict).toBe("pass");
    // The plain knockout carries its own third-place item: only the posted thirdPlace key differs.
    expect(plain.checked).toBe(one.checked - (Object.keys(tp.config).length - Object.keys(ko.config).length));
    expect(builtAsPosted(readback(ko), observed([fx({}), fx({ id: "f2", thirdPlace: true })]))).toMatchObject({ verdict: "fail", evidence: ["stage 1: posted no thirdPlace, built 1 third-place fixture(s)"] });
    // A non-knockout body judges no third-place item.
    const lg = stagesForRow("league")[0]!;
    expect(builtAsPosted(readback(lg), observed([fx({}), fx({ id: "f2", thirdPlace: true })])).evidence.join("\n")).not.toMatch(/third-place/);
  });
  it("the flag reaches the check from the product's row (`third_place`) through the real scenario's snapshot", async () => {
    /** A knockout product that also mints its third-place match, flagged as the product's row flags it. */
    class ThirdPlaceKo extends FakeKnockoutDriver {
      override async start() {
        const out = await super.start();
        if (this.stage!.config.thirdPlace === true) this.seat(Math.max(...this.fixtures.map((f) => f.round_no ?? 0)), null, null, { third_place: true } satisfies Partial<FakeFixture>);
        return out;
      }
    }
    const built = async (d: FakeKnockoutDriver, row: Row) => (await runOn(d, "M1", { row })).checks.find((c) => c.id === "life-built-as-posted")!;
    expect(await built(new ThirdPlaceKo(), "knockout_third_place")).toMatchObject({ verdict: "pass" });
    expect(await built(new FakeKnockoutDriver(), "knockout_third_place")).toMatchObject({ verdict: "fail", evidence: ["stage 1: posted thirdPlace, built 0 third-place fixture(s)"] });
    expect(await built(new ThirdPlaceKo(), "knockout")).toMatchObject({ verdict: "pass" });
    /** m-4: a product that mints the third-place match whether or not it was asked. */
    class AlwaysThirdPlaceKo extends FakeKnockoutDriver {
      override async start() {
        const out = await super.start();
        this.seat(Math.max(...this.fixtures.map((f) => f.round_no ?? 0)), null, null, { third_place: true } satisfies Partial<FakeFixture>);
        return out;
      }
    }
    expect(await built(new AlwaysThirdPlaceKo(), "knockout")).toMatchObject({ verdict: "fail", evidence: ["stage 1: posted no thirdPlace, built 1 third-place fixture(s)"] });
    expect(await built(new AlwaysThirdPlaceKo(), "knockout_third_place")).toMatchObject({ verdict: "pass" });
  });
  it("text pin: the org fixtures list the driver reads selects `f.third_place` and the route does not strip it", () => {
    const usecase = readFileSync(resolve(REPO, "apps/web/src/server/usecases/fixtures.ts"), "utf8");
    const body = /export async function listDivisionFixtures\([\s\S]*?\n}\n/.exec(usecase)?.[0] ?? "";
    expect(body).toMatch(/\bf\.third_place\b/);
    const route = readFileSync(resolve(REPO, "apps/web/src/app/api/v1/divisions/[id]/fixtures/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(route).toMatch(/listDivisionFixtures\(auth, id\)/);
    expect(route).not.toMatch(/third_place/);
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
    expect(Object.keys(SCENARIOS).sort()).toEqual(["DENIED", "F1", "LIFECYCLE", "M1", "PADPROOF", "R4"]);
    expect(SCENARIO_KEYS.sort()).toEqual(["F1", "LIFECYCLE", "M1", "R4"]);
    for (const k of Object.keys(SCENARIOS) as ScenarioKey[]) expect(SCENARIOS[k].key).toBe(k);
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
      if (this.answered++ >= 3) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", STAGE_NOT_READY_STATUS, "STAGE_NOT_READY", "not ready");
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
  it("the driving wave is the one ruling 28 (Q-A) names in the programme index", () => {
    const index = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md"), "utf8");
    const named = /^28\. \*\*Q-A — W1a's deferred driving work becomes a "([\w-]+)" wave/m.exec(index)?.[1];
    expect(named).toBeDefined();
    expect(DRIVING_WAVE).toBe(named);
  });
  // group_group_ko is the API-only multi-stage row Task 10's probe expects to
  // read ⏳ W1-driving; league_ko is the template one. CaseSpec.row is RowKey
  // (Task 9), so the API-only row needs no cast.
  it.each(["league_ko", "group_group_ko"] as const)("%s (multi-stage) is ScenarioUnsupported(DRIVING_WAVE), not a crash, before any driver call", async (key) => {
    const row: Row = key;
    expect(stagesForRow(row).length).toBeGreaterThan(1);
    const driver = new FakeLeagueDriver();
    await expect(runOn(driver, "LIFECYCLE", { row })).rejects.toBeInstanceOf(ScenarioUnsupported);
    await expect(runOn(driver, "LIFECYCLE", { row })).rejects.toMatchObject({ wave: DRIVING_WAVE, message: expect.stringMatching(/multi-stage/) });
    expect(driver.calls).toEqual([]);
  });
  it.each(["ladder", "americano", "mexicano"] as const)("%s is ScenarioUnsupported(DRIVING_WAVE) before any driver call", async (row) => {
    const driver = new FakeLeagueDriver();
    await expect(runOn(driver, "LIFECYCLE", { row })).rejects.toMatchObject({ name: "ScenarioUnsupported", wave: DRIVING_WAVE, message: `${row}: challenge/rotation driving lands in ${DRIVING_WAVE}` });
    expect(driver.calls).toEqual([]);
  });
});

// --- W1-driving Task 4: team rosters and per-fixture lineups (fold-in beneath ruling 49) ---------------
/** The wire slots as the engine reads them (fixtures.ts putLineup stores `order_no ?? i + 1`). */
const toEngine = (entrantId: string, slots: readonly LineupSlotWire[]) => ({
  entrantId,
  slots: slots.map((s, i) => ({ personId: s.person_id, slot: s.slot, ...(s.position_key !== undefined ? { positionKey: s.position_key } : {}), roles: [...(s.roles ?? [])], orderNo: s.order_no ?? i + 1 })),
});
const catalogOf = (sport: string, cfg: unknown) => resolvePositions(sportModule(sport) as never, cfg as never);
/** The lineup PUTs on fixture `f`, each with its place in the fake's id trace. */
const putsOn = (d: FakeLeagueDriver, f: string) => d.trace.flatMap((c, at) => (c.startsWith(`putLineup ${f} `) ? [{ entrant: c.split(" ")[2]!, at }] : []));
/** Every team sport at its builder default (ruling 24), read from the registry: the sweep's set. */
const TEAM_AT_DEFAULT = SPORT_KEYS.filter((s) => entrantKindFor(s, resolveSportCfg(s, offlineBuilderDefault(s))) === "team");
/** For every fixture a posted stream finished: one lineup PUT per side, both
 *  before the fixture's first post. Answers how many fixtures it judged. */
function expectLineupsFirst(d: FakeLeagueDriver, label: string): number {
  const decided = d.decidedFixtureIds();
  for (const id of decided) {
    const f = d.fixtures.find((x) => x.id === id)!;
    const first = d.trace.indexOf(`postStream ${id}`);
    expect(first, `${label} ${id}: posted`).toBeGreaterThan(-1);
    const puts = putsOn(d, id);
    expect(puts.map((p) => p.entrant).sort(), `${label} ${id}: one PUT per side`).toEqual([f.home_entrant_id!, f.away_entrant_id!].sort());
    for (const p of puts) expect(p.at, `${label} ${id}: ${p.entrant}'s lineup precedes the first post`).toBeLessThan(first);
  }
  return decided.length;
}
/** The league fake answering extra warnings on every lineup it checks. */
class WarnsToo extends FakeLeagueDriver {
  extra: readonly string[] = [];
  override putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]) {
    return super.putLineup(fixtureId, entrantId, slots).then((c) => ({ checked: true as const, warnings: [...c.warnings, ...this.extra] }));
  }
}
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

describe("team rosters and per-fixture lineups (W1-driving Task 4, fold-in beneath ruling 49)", () => {
  // State transitions, the empty case first: an individual sport (no members,
  // no lineups, nothing thrown); the first team fixture; a second fixture with
  // the same entrants (a PUT per fixture); a second call on one fixture (no
  // second PUT); a side that is not a division entrant (skipped, one note per
  // stage); a bye (no PUT for the phantom seat); a withdrawn entrant's cascade
  // walkovers (no harness event, so no PUT); M1's own forfeit (lineups first);
  // a fixture a foreign write already started (no PUT); every team sport.
  const football = offlineBuilderDefault("football");

  it("empty case: an individual sport sends no members and reads no roster — the W1a path is byte-identical — and PUTs no lineup", async () => {
    const driver = new FakeLeagueDriver();
    const sent: EntrantInput[] = [];
    const add = driver.addEntrants.bind(driver);
    driver.addEntrants = (d, es) => { sent.push(...es); return add(d, es); };
    const { state } = await runOn(driver, "LIFECYCLE");
    expect(sent.length).toBe(fieldSizeFor("league", "LIFECYCLE"));
    expect(sent.filter((e) => Object.prototype.hasOwnProperty.call(e, "members"))).toEqual([]);
    expect(driver.calls.filter((c) => c === "putLineup" || c === "entrantMembers")).toEqual([]);
    expect(driver.memberCount()).toBe(0);
    expect(state).toMatchObject({ state: "works" });
  });

  it("ensureLineups: an individual sport (rosters empty, kind individual) PUTs nothing and throws nothing", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "badminton", variant: offlineBuilderDefault("badminton") });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    expect([setup.kind, setup.rosters.size, setup.rosterless]).toEqual(["individual", 0, false]);
    const rows = driver.rows();
    expect(rows.length).toBeGreaterThan(0);
    for (const f of rows) await ensureLineups(ctx, rec, setup, f);
    expect(driver.calls.filter((c) => c === "putLineup")).toEqual([]);
    expect(rec.lineupsPut).toBe(0);
    expect(rec.notes.filter((n) => /lineup/i.test(n))).toEqual([]);
  });

  it("a team sport plays with full rosters: members at add, a lineup per side before each fixture's first event", async () => {
    const driver = new FakeLeagueDriver();
    const { state } = await runOn(driver, "LIFECYCLE", { sport: "football", variant: football });
    const cfg = resolveSportCfg("football", football);
    const n = fieldSizeFor("league", "LIFECYCLE");
    expect(driver.calls.filter((c) => c === "addEntrants")).toHaveLength(1);
    expect(driver.memberCount()).toBe(n * rosterSize("football", cfg));
    // A single round robin of n: n(n-1)/2 fixtures, each decided by a post.
    expect(expectLineupsFirst(driver, "football")).toBe((n * (n - 1)) / 2);
    // A second fixture with the same entrants is PUT again: each entrant's lineup once per fixture it plays (n - 1).
    for (const e of driver.entrants) expect(driver.trace.filter((c) => c.startsWith("putLineup ") && c.endsWith(` ${e.id}`)).length, e.id).toBe(n - 1);
    // The seam is real: what was PUT is the product's people as it stored them (never the inputs), and the engine takes it.
    expect(driver.lineups.size).toBe(n * (n - 1));
    for (const [key, slots] of driver.lineups) {
      const entrant = key.split("|")[1]!;
      const roster = new Set(driver.members.get(entrant)!.map((m) => m.person_id));
      expect(slots.every((s) => roster.has(s.person_id)), key).toBe(true);
      expect(validateLineup(catalogOf("football", cfg), toEngine(entrant, slots)), key).toEqual([]);
    }
    expect(state, JSON.stringify(state)).toMatchObject({ state: "works" });
  });

  it("every team sport at its builder default plays LIFECYCLE with a lineup per side before each fixture's first post — counted", async () => {
    expect(TEAM_AT_DEFAULT.length, "team sports in the registry").toBeGreaterThan(0);
    const n = fieldSizeFor("league", "LIFECYCLE");
    let fixtures = 0;
    for (const sport of TEAM_AT_DEFAULT) {
      const driver = new FakeLeagueDriver();
      const { state } = await runOn(driver, "LIFECYCLE", { sport, variant: offlineBuilderDefault(sport) });
      const judged = expectLineupsFirst(driver, sport);
      expect(judged, sport).toBeGreaterThan(0);
      fixtures += judged;
      expect(state, `${sport}: ${JSON.stringify(state)}`).toMatchObject({ state: "works" });
    }
    // Each sport's single round robin of n decides n(n-1)/2 fixtures.
    expect(fixtures).toBe((TEAM_AT_DEFAULT.length * n * (n - 1)) / 2);
  });

  it("ensureLineups: a second call on a fixture PUTs nothing more; a second fixture with the same entrant gets its own PUTs", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "football", variant: football });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    const [f, ...rest] = driver.rows();
    await ensureLineups(ctx, rec, setup, f!);
    await ensureLineups(ctx, rec, setup, f!);
    expect(putsOn(driver, f!.id)).toHaveLength(2);
    expect(rec.lineupsPut).toBe(2);
    const g = rest.find((x) => x.home_entrant_id === f!.home_entrant_id || x.away_entrant_id === f!.home_entrant_id)!;
    await ensureLineups(ctx, rec, setup, g);
    expect(putsOn(driver, g.id)).toHaveLength(2);
    expect(rec.lineupsPut).toBe(4);
    expect([...rec.lineupFixtures]).toEqual([f!.id, g.id]);
  });

  it("ensureLineups: a side that is not a division entrant (a product-minted pair entrant) is skipped with one note per stage, never thrown", async () => {
    // Two fixtures of the stage seat a foreign side: still one note.
    class SeatsForeign extends FakeLeagueDriver {
      override start() {
        return super.start().then((o) => {
          this.fixtures[0]!.away_entrant_id = "pair-x";
          this.fixtures[1]!.away_entrant_id = "pair-y";
          return o;
        });
      }
    }
    const driver = new SeatsForeign();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "football", variant: football });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    const [f1, f2] = driver.rows();
    for (const f of [f1!, f2!]) await decideFixture(ctx, rec, setup, f, { kind: "win", winner: "home" });
    expect(putsOn(driver, f1!.id).map((p) => p.entrant)).toEqual([f1!.home_entrant_id]);
    expect(putsOn(driver, f2!.id).map((p) => p.entrant)).toEqual([f2!.home_entrant_id]);
    expect(rec.lineupsPut).toBe(2);
    expect(rec.notes.filter((n) => /not a division entrant/.test(n))).toEqual([
      `lineups: stage ${setup.stage.id} seats a side that is not a division entrant (a product-minted pair entrant) — no lineup PUT for such a side`,
    ]);
  });

  it("a bye: the phantom seat gets no PUT, and every fixture the harness decided, later rounds included, has its two lineups first", async () => {
    const driver = new FakeKnockoutDriver();
    const r = await runOn(driver, "F1", { row: "knockout", sport: "football", variant: football });
    const n = fieldSizeFor("knockout", "F1");
    const byes = driver.fixtures.filter((f) => (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    // An n-field bracket over the next power of two leaves that many seats empty.
    expect(byes.length).toBe(2 ** Math.ceil(Math.log2(n)) - n);
    for (const b of byes) expect(driver.trace.filter((c) => c.startsWith(`putLineup ${b.id} `)), b.id).toEqual([]);
    // A single elimination of n is decided by n - 1 eliminations; a bye eliminates nobody.
    expect(expectLineupsFirst(driver, "knockout")).toBe(n - 1);
    expect(r.state.reason).not.toMatch(/^error/);
  });

  it("a withdrawn entrant's cascade walkovers carry no harness event, so no lineup PUT", async () => {
    // The walkover policy (not the table fake's early expunge): the product forfeits every pending fixture itself.
    class WalksOver extends FakeLeagueDriver { override expungesEarly() { return false; } }
    const driver = new WalksOver();
    const r = await runOn(driver, "R4", { sport: "football", variant: football });
    const seed3 = driver.entrants.find((e) => e.seed === 3)!.id;
    const walked = driver.fixtures.filter((f) => (f.home_entrant_id === seed3 || f.away_entrant_id === seed3) && (f.round_no ?? 0) > 1);
    // Seed 3 meets n - 1 entrants and plays round 1 before withdrawing.
    expect(walked.length).toBe(fieldSizeFor("league", "R4") - 2);
    for (const f of walked) {
      expect(f.status, f.id).toBe("forfeited");
      expect(driver.trace, `${f.id}: the cascade's own forfeit`).toContain(`postStream ${f.id}`);
      expect(putsOn(driver, f.id), f.id).toEqual([]);
    }
    expect(r.state.reason).not.toMatch(/^error/);
  });

  it("M1's walkover: the harness's own forfeit gets its lineups first, because decideFixture covers the forfeit branch (Step 0: the product needs none)", async () => {
    const driver = new FakeLeagueDriver();
    const r = await runOn(driver, "M1", { sport: "football", variant: football });
    const forfeited = driver.fixtures.filter((f) => f.events.some((e) => e.type === "core.forfeit"));
    expect(forfeited.length).toBe(1);
    const f = forfeited[0]!;
    const first = driver.trace.indexOf(`postStream ${f.id}`);
    expect(putsOn(driver, f.id).map((p) => p.at < first)).toEqual([true, true]);
    expect(r.state, JSON.stringify(r.state)).toMatchObject({ state: "works" });
  });

  it("a team fixture a foreign write already started gets no PUT (the product locks lineups past scheduled): noted, and parity stays the unjudgeable item", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "football", variant: football });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 4);
    const f = driver.rows()[0]!;
    await driver.postStream(f.id, [START], "foreign"); // not recorded: a foreign write
    // A forfeit on a live fixture posts only core.forfeit (decideFixture), so the engine takes it.
    await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "walkover" });
    expect(putsOn(driver, f.id)).toEqual([]);
    expect(rec.lineupsPut).toBe(0);
    expect(rec.notes).toContain(`lineups: ${f.id} was in_play when the harness came to it — the product locks a lineup once a fixture is past scheduled; no lineup PUT`);
    expect(foldParity(rec)).toMatchObject({ verdict: "fail", checked: 1 });
  });

  it("roster guard: a product that stores one member fewer than posted is refused by name before the division starts", async () => {
    class DropsOne extends FakeLeagueDriver {
      override addEntrants(d: string, es: readonly EntrantInput[]) {
        return super.addEntrants(d, es).then((rows) => {
          this.members.set("e2", this.members.get("e2")!.slice(0, -1));
          return rows;
        });
      }
    }
    const driver = new DropsOne();
    const size = rosterSize("football", resolveSportCfg("football", football));
    await expect(setUpDivision(ctxFor(driver, "LIFECYCLE", { sport: "football", variant: football }), new Recorder(), 4))
      .rejects.toThrow(`scenario: entrant e2 (seed 2) reads back ${size - 1} roster member(s), ${size} posted — a short roster would play short`);
    // The read stops at the first short roster: e1 read, e2 refused.
    expect(driver.calls.filter((c) => c === "entrantMembers")).toHaveLength(2);
    expect(driver.calls).not.toContain("start");
  });

  it("roster guard, the other direction: an entrant the product never stored is life-built-as-posted's red, never a roster error — and one answered with no seed still has its roster read", async () => {
    // Stores (and answers) 7 of the 8 posted team entrants.
    class StoresSeven extends FakeLeagueDriver {
      override addEntrants(d: string, es: readonly EntrantInput[]) { return super.addEntrants(d, es.slice(0, -1)); }
    }
    const r = await runOn(new StoresSeven(), "LIFECYCLE", { sport: "football", variant: football });
    expect(r.state.state).toBe("red");
    expect(r.checks.find((c) => c.id === "life-built-as-posted")!.evidence).toEqual(["7 entrant(s) stored, 8 posted", "add answered 7 entrant(s), 8 posted", "posted seed 8 (Matrix Player 8) stored 0 time(s)"]);
    // An answer that drops an entrant's seed loses nothing the roster read needs.
    class AnswersNoSeed extends FakeLeagueDriver {
      override addEntrants(d: string, es: readonly EntrantInput[]): Promise<EntrantRow[]> {
        return super.addEntrants(d, es).then((rows) => rows.map((e) => (e.seed === 3 ? { ...e, seed: null } : e)));
      }
    }
    const setup = await setUpDivision(ctxFor(new AnswersNoSeed(), "LIFECYCLE", { sport: "football", variant: football }), new Recorder(), 4);
    expect(setup.rosters.size).toBe(4);
  });

  it("warnings (T3-R1): a starting-size warning on a known side-size row is ONE named note routed to its wave — the fake's issue JSON and the product's text alike", async () => {
    const forms = [JSON.stringify({ kind: "starting_size", expected: 2, actual: 6 }), "Starting lineup has 6 player(s), expected 2"];
    for (const w of forms) {
      const driver = new WarnsToo();
      driver.extra = [w];
      const { out, state } = await runOn(driver, "LIFECYCLE", { sport: "volleyball", variant: "beach" });
      expect(driver.calls.filter((c) => c === "putLineup").length, w).toBeGreaterThan(1);
      expect(out.notes.filter((x) => x.startsWith("lineup-side-size-warning: ")), w).toEqual([
        `lineup-side-size-warning: volleyball/beach [starting_size] ${w} — the known side-size finding (rosters.ts SIDE_SIZE_ROUTE) → ${SIDE_SIZE_ROUTE.wave}`,
      ]);
      expect(state, w).toMatchObject({ state: "works" });
    }
  });

  it("warnings (T3-R1): any other warning reds by name — another kind, the same kind on another row, or text in neither shape", async () => {
    const cases = [
      { sport: "volleyball", variant: "beach", w: JSON.stringify({ kind: "group_min", groupKey: "x", min: 1, actual: 0 }), kind: "group_min" },
      { sport: "volleyball", variant: "beach", w: 'Position group "x" has 0 starting player(s), minimum is 1', kind: "group_min" },
      { sport: "football", variant: football, w: JSON.stringify({ kind: "starting_size", expected: 7, actual: 11 }), kind: "starting_size" },
      { sport: "volleyball", variant: "beach", w: "the product said something new", kind: null },
    ];
    for (const c of cases) {
      const driver = new WarnsToo();
      driver.extra = [c.w];
      const err = await runOn(driver, "LIFECYCLE", { sport: c.sport, variant: c.variant }).catch((e: unknown) => e);
      expect(err, c.w).toBeInstanceOf(LineupWarned);
      expect(err, c.w).toMatchObject({ name: "LineupWarned", kind: c.kind, warning: c.w });
      expect((err as LineupWarned).message, c.w).toContain(`${c.sport}/${c.variant}`);
    }
  });

  it("lineupWarningKind reads the product's formatLineupIssue templates and the engine's issue JSON, kind for kind", () => {
    const engineKinds = [...(/\nexport type LineupIssue =([\s\S]*?);\n/.exec(read("packages/engine/src/sport/catalog.ts"))?.[1] ?? "").matchAll(/kind: "([a-z_]+)"/g)].map((m) => m[1]!);
    const fmt = /\nfunction formatLineupIssue\(issue: LineupIssue\): string \{([\s\S]*?)\n\}\n/.exec(read("apps/web/src/server/usecases/fixtures.ts"))?.[1] ?? "";
    // Every placeholder rendered as "7": a count, an id or a key alike.
    const rendered = [...fmt.matchAll(/case "([a-z_]+)":\s*return `([^`]*)`;/g)].map((m) => ({ kind: m[1]!, text: m[2]!.replace(/\$\{[^}]*\}/g, "7") }));
    expect(engineKinds.length, "engine LineupIssue kinds").toBeGreaterThan(0);
    expect(rendered.map((r) => r.kind).sort()).toEqual([...engineKinds].sort());
    expect(Object.keys(LINEUP_ISSUE_TEXT).sort()).toEqual([...engineKinds].sort());
    for (const r of rendered) {
      expect(lineupWarningKind(r.text), r.text).toBe(r.kind);
      expect(Object.values(LINEUP_ISSUE_TEXT).filter((re) => re.test(r.text)).length, `${r.text}: one template`).toBe(1);
    }
    for (const kind of engineKinds) expect(lineupWarningKind(JSON.stringify({ kind, actual: 1 })), kind).toBe(kind);
    expect(lineupWarningKind("nothing the product says")).toBeNull();
    expect(lineupWarningKind(JSON.stringify({ kind: 3 }))).toBeNull();
    expect(lineupWarningKind("[]")).toBeNull();
  });

  it("Step 0: the product's lineup PUT, pinned from its source — the refusal codes, replace-not-append, a warning-only check, no event-time assertLineup", () => {
    const fixtures = read("apps/web/src/server/usecases/fixtures.ts");
    const put = /\nexport async function putLineup\([\s\S]*?\n\}\n/.exec(fixtures)?.[0] ?? "";
    expect(put, "putLineup").not.toBe("");
    // The structural refusals are codeless 422s, in this order, so the wire code is http.ts's for a 422.
    expect([...put.matchAll(/throw new HttpError\(422, ["`]([^"`]*)["`]\);/g)].map((m) => m[1])).toEqual([
      "entrant is not a side of this fixture", "lineup is locked once a fixture is ${fixture.status}", "duplicate person in lineup", "lineup contains a person who is not a member of the entrant",
    ]);
    expect(wireCodeFor(422)).toBe("ERROR");
    // Then the two roster gates, each with its own code.
    const gateElig = put.indexOf("await gateRosterEligibility(tx,");
    expect(gateElig).toBeGreaterThan(put.indexOf("not a member of the entrant"));
    expect(put.indexOf("await gateLineupSuspensions(tx,")).toBeGreaterThan(gateElig);
    expect(/\nexport async function gateRosterEligibility\([\s\S]*?\n\}\n/.exec(read("apps/web/src/server/usecases/registration-eligibility.ts"))?.[0]).toMatch(/throw new HttpError\(\s*422,[^;]*"ELIGIBILITY_VIOLATION"/);
    expect(/\nexport async function gateLineupSuspensions\([\s\S]*?\n\}\n/.exec(read("apps/web/src/server/usecases/discipline.ts"))?.[0]).toMatch(/throw new HttpError\(\s*422,[^;]*"SUSPENDED_PLAYER"/);
    // A malformed person id never reaches the usecase: a Uuid in the schema, a ZodError answered 400 VALIDATION.
    expect(read("apps/web/src/server/api-v1/schemas.ts")).toMatch(/export const LineupSlotInput = z\.object\(\{\s*person_id: Uuid,/);
    expect(read("apps/web/src/server/api-v1/http.ts")).toMatch(/if \(err instanceof ZodError\) \{\s*return errorResponse\(requestId, 400, "VALIDATION"/);
    // A second PUT replaces the first: delete, then insert.
    const del = put.indexOf("delete from lineups where fixture_id = ${fixtureId} and entrant_id = ${entrantId}");
    expect(del).toBeGreaterThan(-1);
    expect(put.indexOf("insert into lineups")).toBeGreaterThan(del);
    // A lineup validateLineup flags is SAVED, then warned: the check reads the stored rows and never throws.
    expect(put.indexOf("checkStoredLineup(")).toBeGreaterThan(put.indexOf("insert into lineups"));
    const check = /\nfunction checkStoredLineup\([\s\S]*?\n\}\n/.exec(fixtures)?.[0] ?? "";
    expect(check).toMatch(/return \{ checked: true, warnings: issues\.map\(formatLineupIssue\) \};/);
    expect(check).toMatch(/catch \(err\) \{[\s\S]*return \{ checked: false, warnings: \[\], reason:/);
    expect(check).not.toMatch(/\bthrow\b/);
    // No event refuses through assertLineup: nothing outside its own definition (and the engine's tests) calls it,
    // so no lineup is required to post — a forfeit or a walkover needs none, and M1's hook is left alone.
    const sources = ["apps/web/src", "packages/engine/src"].flatMap((root) => (readdirSync(resolve(REPO, root), { recursive: true }) as string[])
      .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$|__tests__/.test(p)).map((p) => `${root}/${p}`));
    expect(sources.length, "product and engine sources scanned").toBeGreaterThan(100);
    const callers = sources.filter((p) => /\bassertLineup\(/.test(read(p)));
    expect(callers).toEqual(["packages/engine/src/sport/catalog.ts"]);
    expect(read("packages/engine/src/sport/catalog.ts").match(/\bassertLineup\(/g)).toHaveLength(1);
  });
});

// --- W1-driving Task 5: linked persons for americano/mexicano individuals (fold-in beneath ruling 49) ---
/** Takes an americano stage (the fake league refuses every kind but its own)
 *  and keeps the addEntrants payload exactly as posted. */
class AmericanoFake extends FakeLeagueDriver {
  readonly posted: EntrantInput[] = [];
  override acceptsStage(kind: string): boolean { return kind === "americano"; }
  override addEntrants(d: string, es: readonly EntrantInput[]): Promise<EntrantRow[]> {
    this.posted.push(...es);
    return super.addEntrants(d, es);
  }
}
/** The brief's field: americano needs at least 4 players (stages.ts americanoGen STAGE_NOT_READY). */
const AMERICANO_ENTRANTS = 8;
/** The rows the brief names: americano and mexicano are one stage kind, and the row's mode decides. */
const AMERICANO_ROWS = ["americano", "mexicano"] as const;
const builtOn = (driver: FakeLeagueDriver, row: Row, sport: string) =>
  buildDivision(ctxFor(driver, "LIFECYCLE", { row, sport, variant: offlineBuilderDefault(sport) }), new Recorder(), AMERICANO_ENTRANTS);

describe("linked persons for americano and mexicano individuals (W1-driving Task 5, fold-in beneath ruling 49)", () => {
  it("empty case first: no stage bodies need no persons; across every catalogue row, exactly the two americano rows do", () => {
    expect(personsNeeded([])).toBe(false);
    const needing = ROW_KEYS.filter((r) => personsNeeded(stagesForRow(r)));
    expect(ROW_KEYS.length, "rows checked").toBeGreaterThan(AMERICANO_ROWS.length);
    expect(needing).toEqual([...AMERICANO_ROWS]);
  });

  it("a non-americano individual row is unchanged: no members key, no member read, both maps empty", async () => {
    const driver = new FakeLeagueDriver();
    const setup = await setUpDivision(ctxFor(driver, "LIFECYCLE", { sport: "badminton", variant: offlineBuilderDefault("badminton") }), new Recorder(), AMERICANO_ENTRANTS);
    expect(setup.entrants).toHaveLength(AMERICANO_ENTRANTS);
    expect(driver.calls.filter((c) => c === "entrantMembers")).toEqual([]);
    expect(driver.memberCount()).toBe(0);
    expect(setup.persons.size).toBe(0);
    expect(setup.rosters.size).toBe(0);
  });

  it("a non-americano team row seats rosters (Task 4) and still maps no persons — persons is the americano rows' map alone", async () => {
    const setup = await setUpDivision(ctxFor(new FakeLeagueDriver(), "LIFECYCLE", { sport: "football", variant: offlineBuilderDefault("football") }), new Recorder(), AMERICANO_ENTRANTS);
    expect(setup.rosters.size).toBe(AMERICANO_ENTRANTS);
    expect(setup.persons.size).toBe(0);
  });

  it.each(AMERICANO_ROWS)("%s, every sport at its builder default: an individual carries exactly one linked person, a team its full roster, and persons holds the product's ids — counted", async (row) => {
    let individuals = 0;
    let teams = 0;
    for (const sport of SPORT_KEYS) {
      const driver = new AmericanoFake();
      const setup = await builtOn(driver, row, sport);
      const label = `${row}|${sport}`;
      expect(driver.posted, label).toHaveLength(AMERICANO_ENTRANTS);
      expect(setup.persons.size, `${label}: persons per entrant`).toBe(AMERICANO_ENTRANTS);
      for (const e of setup.entrants) {
        // The product's ids, as entrantMembers answers them — never the inputs.
        const stored = (await driver.entrantMembers(e.id)).map((m) => m.person_id);
        expect(setup.persons.get(e.id), `${label} ${e.id}`).toEqual(stored);
      }
      if (entrantKindFor(sport, resolveSportCfg(sport, offlineBuilderDefault(sport))) === "team") {
        teams++;
        const size = rosterSize(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)));
        expect(driver.posted.map((p) => p.members?.length), label).toEqual(Array.from({ length: AMERICANO_ENTRANTS }, () => size));
        expect(setup.rosters.size, `${label}: full rosters`).toBe(AMERICANO_ENTRANTS);
        for (const e of setup.entrants) expect(setup.persons.get(e.id), `${label} ${e.id}: the whole roster`).toEqual(setup.rosters.get(e.id)!.map((m) => m.person_id));
      } else {
        individuals++;
        // The brief's member: one synthetic person with the entrant's own name.
        expect(driver.posted.map((p) => p.members), label).toEqual(Array.from({ length: AMERICANO_ENTRANTS }, (_, i) => [{ fullName: `Matrix Player ${i + 1}`, squadNumber: 1, isCaptain: true }]));
        expect(setup.rosters.size, `${label}: an individual is never a roster`).toBe(0);
        const ids = [...setup.persons.values()];
        expect(ids.every((p) => p.length === 1), `${label}: one person each`).toBe(true);
        expect(new Set(ids.flat()).size, `${label}: distinct persons`).toBe(AMERICANO_ENTRANTS);
      }
    }
    expect(individuals, "individual sports checked").toBeGreaterThan(0);
    expect(teams, "team sports checked").toBeGreaterThan(0);
    expect(individuals + teams).toBe(SPORT_KEYS.length);
  });

  it("the posted mode rides the stage body: americano and mexicano post the same stage kind with their own mode", async () => {
    const modes: string[] = [];
    for (const row of AMERICANO_ROWS) {
      const setup = await builtOn(new AmericanoFake(), row, "badminton");
      expect(setup.built.posted.stages.map((s) => s.kind)).toEqual(["americano"]);
      modes.push(String((setup.built.posted.stages[0]!.config as { mode?: unknown }).mode));
    }
    expect(modes).toEqual([...AMERICANO_ROWS]);
  });

  it("persons guard: an individual the product stores with no linked person is refused by name before the division starts", async () => {
    class DropsAPerson extends AmericanoFake {
      override entrantMembers(id: string) { return super.entrantMembers(id).then((ms) => (id === "e3" ? [] : ms)); }
    }
    const driver = new DropsAPerson();
    await expect(builtOn(driver, "americano", "badminton"))
      .rejects.toThrow("scenario: entrant e3 (seed 3) reads back 0 linked person(s), 1 posted — americano plays the person behind each entrant (stages.ts americanoGen)");
    expect(driver.calls).not.toContain("start");
  });

  it("a pair-kind division on an americano row is refused by name before any driver call — the harness defines no pair members", async () => {
    const driver = new AmericanoFake();
    const base = ctxFor(driver, "LIFECYCLE", { row: "americano", sport: "badminton", variant: offlineBuilderDefault("badminton") });
    const ctx: ScenarioContext = { ...base, cfg: { ...(base.cfg as Record<string, unknown>), entrants: { kinds: ["pair"] } } };
    expect(entrantKindFor("badminton", ctx.cfg)).toBe("pair");
    await expect(buildDivision(ctx, new Recorder(), AMERICANO_ENTRANTS))
      .rejects.toThrow("scenario: americano on a pair-kind division — americano plays one person per entrant (stages.ts americanoGen) and the harness posts no pair members");
    expect(driver.calls).toEqual([]);
  });

  it.each(AMERICANO_ROWS)("%s through setUpDivision is still the format deferral, before any driver call, until the americano loop lands", async (row) => {
    const driver = new AmericanoFake();
    await expect(setUpDivision(ctxFor(driver, "LIFECYCLE", { row, sport: "badminton", variant: offlineBuilderDefault("badminton") }), new Recorder(), AMERICANO_ENTRANTS))
      .rejects.toBeInstanceOf(ScenarioUnsupported);
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
      override async generate(): Promise<never> { throw new RefusedCall("POST", "/api/v1/stages/s1/generate", STAGE_NOT_READY_STATUS, "STAGE_NOT_READY", "not ready"); }
    }
    const r = await runOn(new Refuses(), "F1");
    expect(r.out.observed.stages[0]!.generates).toEqual([{ status: STAGE_NOT_READY_STATUS, code: "STAGE_NOT_READY", total: 0, created: 0 }]);
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
        if (this.paired === 2) throw new RefusedCall("POST", "/api/v1/stages/s1/generate", STAGE_NOT_READY_STATUS, "STAGE_NOT_READY", "not ready");
        return super.generate();
      }
    }
    const r = await runOn(new RefusesRound3(), "LIFECYCLE", { row: "swiss" });
    expect(r.out.observed.stages[0]!.generates.at(-1)).toEqual({ status: STAGE_NOT_READY_STATUS, code: "STAGE_NOT_READY", total: 0, created: 0 });
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
    // The next round is refused while this one has an undecided board (stages.ts swissGen gate),
    // with the status the product maps STAGE_NOT_READY to (Task 8 m-7: it is 422, not 409).
    await expect(driver.generate(setup.stage.id)).rejects.toMatchObject({ status: STAGE_NOT_READY_STATUS, code: "STAGE_NOT_READY" });
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

describe("page_playoff_only: the field is the FORMAT's, not a fixed 8 (W1-driving Task 2)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
  /** The one field size the ENGINE's page playoff accepts (generatePagePlayoff), never typed here. */
  const ppField = ((): number => {
    const ok = ids(16).map((_, i) => i + 1).filter((n) => n >= 2).filter((n) => { try { generatePagePlayoff({ entrants: ids(n) }); return true; } catch { return false; } });
    if (ok.length !== 1) throw new Error(`the engine's page playoff accepts ${ok.length} sizes, expected exactly one`);
    return ok[0]!;
  })();
  const ppRow = { row: "page_playoff_only" as const };

  it("text pin: page_playoff is NOT a bracket-walkover kind, so a withdrawal takes the open-format branch (voids pending, forfeits nothing)", () => {
    const stages = readFileSync(resolve(REPO, "apps/web/src/server/usecases/stages.ts"), "utf8");
    const set = /export const BRACKET_WALKOVER_KINDS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(stages)?.[1];
    expect(set, "BRACKET_WALKOVER_KINDS literal not found").toBeDefined();
    const kinds = [...set!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toContain("knockout"); // the positive pair: the literal was read
    expect(kinds).not.toContain("page_playoff");
    const withdrawal = readFileSync(resolve(REPO, "apps/web/src/server/usecases/withdrawal.ts"), "utf8");
    expect(withdrawal).toContain('if (PENDING.has(f.status)) plan.push({ update: { fixtureId: f.id, status: "void" }, fixture: f });');
    expect(withdrawal).toContain('if (out.policy === "none" && plan.length > 0) out.policy = "walkover";');
  });
  it("empty case first: the old fixed 8 is refused by the engine's page playoff at Start — the harness red this task removes", async () => {
    const driver = new FakeKnockoutDriver({ pagePlayoff: true });
    await expect(setUpDivision(ctxFor(driver, "LIFECYCLE", ppRow), new Recorder(), 8)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(driver.fixtures).toEqual([]);
  });
  it("page_playoff_only LIFECYCLE adds exactly 4 entrants (the engine's page-playoff field), in one add, and the fake builds the engine's pp-* shape on them", async () => {
    expect(ppField).toBe(4);
    const driver = new FakeKnockoutDriver({ pagePlayoff: true });
    const r = await runOn(driver, "LIFECYCLE", ppRow);
    expect(driver.calls.filter((c) => c === "addEntrants")).toHaveLength(1);
    expect(driver.entrants.length).toBe(ppField);
    expect(r.out.observed.stages[0]!.field).toHaveLength(ppField);
    expect([...driver.extIds.keys()]).toEqual(generatePagePlayoff({ entrants: ids(ppField) }).fixtures.map((f) => f.id));
    // A second, different row on the same scenario keeps the default 8 (the differing case).
    const league = await runOn(new FakeLeagueDriver(), "LIFECYCLE");
    expect(league.driver.entrants.length).toBe(8);
  });
  it("M1 and R4 seed the same 4 there", async () => {
    for (const k of ["M1", "R4"] as const) {
      const driver = new FakeKnockoutDriver({ pagePlayoff: true });
      await runOn(driver, k, ppRow);
      expect(driver.entrants.length, k).toBe(ppField);
    }
  });
  it("F1 on page_playoff_only is never planned: its applicability decision is a drop with the unfit reason; asked anyway, the scenario refuses by name before any driver call", async () => {
    const d = decide(RULES.F1!, "page_playoff_only", "generic", []);
    expect(d.applies).toBe(false);
    expect(RULES.F1!.reason).toMatch(/odd field cannot enter a fixed 4-seat page playoff/);
    expect(decide(RULES.F1!, "league", "generic", []).applies).toBe(true); // the positive pair
    const driver = new FakeKnockoutDriver({ pagePlayoff: true });
    await expect(runOn(driver, "F1", ppRow)).rejects.toThrow(NoFieldSize);
    expect(driver.calls).toEqual([]);
  });
  it("R4 once it seeds 4 (plan review 1 m-5, review 2 I-1): seed 3 wins pp-elim, withdraws, pp-q2 is ABANDONED, nothing forfeited, pp-final never seated, /complete asked once", async () => {
    const driver = new FakeKnockoutDriver({ pagePlayoff: true });
    const r = await runOn(driver, "R4", ppRow);
    const seed = (n: number) => driver.entrants.find((e) => e.seed === n)!.id;
    const fx = (ext: string) => r.out.observed.stages[0]!.fixtures.find((f) => f.id === driver.extIds.get(ext))!;
    // Seed 3 plays pp-elim in round 1 against seed 4 and, as the better seed, wins it.
    expect(fx("pp-elim")).toMatchObject({ roundNo: 1, home: seed(3), away: seed(4), status: "decided", outcome: { kind: "win", winner: seed(3) } });
    // So it is seated in pp-q2 (away: winnerOf pp-elim) against the loser of pp-q1 when it withdraws.
    expect(fx("pp-q2")).toMatchObject({ home: seed(2), away: seed(3), status: "abandoned" });
    const w = r.out.observed.withdrawal!;
    expect(w).toMatchObject({ entrantId: seed(3), afterRound: 1, policy: "walkover", walkovers: 0, voided: 1, skippedFinalized: 0 });
    expect(r.out.observed.stages[0]!.fixtures.filter((f) => f.status === "forfeited")).toEqual([]);
    // pp-final's away seat is winnerOf("pp-q2"), which never comes.
    expect(fx("pp-final")).toMatchObject({ home: seed(1), away: null, status: "scheduled" });
    expect(driver.calls.filter((c) => c === "completeStage")).toHaveLength(1);
    expect(r.out.observed.stages[0]!.complete).toMatchObject({ status: 200, code: null, completed: false });
  });
});
