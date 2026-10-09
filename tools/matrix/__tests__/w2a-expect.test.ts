// The W2a "the 77 are green" judge (Task 16 Step 3) and its expectation (phase 3 review R-2 and D-P2).
//
// Task 16 reads `expect-77.json` (the 77 SC-O1/SC-O2 reds Task 1 reproduced) and demands every one is now green. Two
// things about that expectation are not data the harness can derive, and both are tested here, not trusted:
//   R-2   every id in it is a CURRENT plan id. One was keyed to a width the plan has since re-widthed
//         (league_ko|boardgame|blitz|F1@834 is @430 now), so Task 16 would have reported it "missing" - a refusal that
//         reads as a product defect. The guard counts what it checked (77 of 77, 0 missing).
//   D-P2  six boardgame L3 cells are not W2a's to turn green (controller ruling, ledgered in progress.md under "P1 phase 3
//         review"): five R4 cells re-key SC-O1 -> CD-T13 (W2b, BG-WO-2), and the ko_plate F1 cell SC-O1 -> FX-G14 (W4).
//         The judge passes for "71 works + 6 red with the pinned reason"; any OTHER red, or a re-keyed cell red for a
//         different reason, fails it. Right reason passes, wrong reason fails, an unexpected red fails.
//
// Expected values here come from the ruling's own text (ids, owners, reasons) and the plan's declarations (livePlan),
// never from the judge's output.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { livePlan, noVariant } from "../lib/expected-plan.ts";
import { LAYER_GRID_PLANNERS, layerCaseId } from "../lib/layers.ts";
import { stripe } from "../lib/shard.ts";
import { ExpectRefused, judgeExpectation, parseExpect, parseRekeys, type Rekey } from "../lib/w2a-expect.ts";
import type { CaseResult, CaseState, CheckResult, RunResults } from "../lib/results.ts";
import { main } from "../w2a-expect.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";

const REPRO = `${TRUTH_RUNS}/w2a-repro`;
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const WANT = readJson(`${REPRO}/expect-77.json`) as string[];
const REKEYS_FILE = readJson(`${REPRO}/expect-77-rekeys.json`) as { rekeys: Rekey[] };

// --- the ruling (D-P2), typed from its text -----------------------------------------------------------------------

const R4_REASON = 'forfeit not allowed in phase "pre"';
/** Controller ruling D-P2: the five boardgame R4 cells, W2b's (BG-WO-2). */
const R4_CELLS = ["knockout", "knockout_third_place", "double_elim", "ko_plate", "qualifying_main"].map((row) => `${row}|boardgame|blitz|R4`);
const F1_CELL = "ko_plate|boardgame|blitz|F1";
const SIX = [...R4_CELLS, F1_CELL];

// --- builders -------------------------------------------------------------------------------------------------------

const check = (verdict: "pass" | "fail", reason = "", evidence: string[] = []): CheckResult => ({ id: verdict === "pass" ? "k-pass" : "k-fail", kind: "invariant", verdict, checked: 1, reason, evidence });
function kase(caseId: string, state: CaseState = "works", reason = "", checks: CheckResult[] = state === "works" ? [check("pass")] : []): CaseResult {
  const [row, sport, variant, scenario] = caseId.replace(/@\d+$/, "").split("|") as [string, string, string, string];
  return { caseId, row, sport, variant, scenario, canary: false, state, reason, checks, counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 5, notes: [], layer: "L3", driver: "http", width: null };
}
const R4_RED = (id: string): CaseResult => kase(id, "red", `error: RefusedCall: POST /api/v1/entrants/e1/withdraw → HTTP 422 WRONG_PHASE: ${R4_REASON}`);
const F1_RED = (id: string): CaseResult => kase(id, "red", "I4-nothing-ends-stuck: stage 2: never asked to complete; advance-seeded-as-declared: stage 2: no proposal — stage 1's /complete answered 409 STAGE_COMPLETED_SEEDING_FAILED", [check("fail", "stage 2: never asked to complete")]);
/** The 77, each as the ruling expects it: green, except the six, red for their pinned reason. */
function expectedRun(over: (c: CaseResult) => CaseResult = (c) => c): CaseResult[] {
  return WANT.map((id) => over(R4_CELLS.includes(id) ? R4_RED(id) : id === F1_CELL ? F1_RED(id) : kase(id)));
}
const judge = (cases: CaseResult[], rekeys: readonly Rekey[] = REKEYS_FILE.rekeys) => judgeExpectation({ want: WANT, rekeys, sources: [{ label: "now", cases }] });
const refusal = (f: () => unknown): ExpectRefused => {
  try { f(); } catch (e) { if (e instanceof ExpectRefused) return e; throw e; }
  throw new Error("expected a refusal");
};

// --- R-2: the expectation names current plan ids ---------------------------------------------------------------------

describe("expect-77.json - every id is a current plan id (R-2)", () => {
  it("holds exactly 77 distinct, sorted ids, and each is in a plan the W1d baseline recorded, as TODAY's planners build it - counted, 0 missing", () => {
    expect(WANT).toHaveLength(77);
    expect(new Set(WANT).size).toBe(77);
    expect([...WANT].sort()).toEqual(WANT);
    const planned = new Set<string>();
    let plans = 0;
    for (const L of ["L1", "L2", "L3"]) {
      const recorded = (readJson(`${TRUTH_RUNS}/w1d-baseline/${L}/results.json`) as { plan: string }).plan;
      const p = livePlan(recorded);
      for (const k of [...p.driven, ...p.planned.keys()]) planned.add(k);
      expect(p.driven.size + p.planned.size, `${L}: ${recorded} plans something`).toBeGreaterThan(0);
      plans++;
    }
    expect(plans).toBe(3);
    const missing = WANT.filter((id) => !planned.has(noVariant(id)));
    expect(missing, "ids no current plan holds").toEqual([]);
    expect(WANT.length - missing.length).toBe(77);
  });

  it("the id the plan re-widthed is keyed to the width the plan has now (league_ko|boardgame|blitz|F1: @430, not @834), and the other 14 layered ids keep theirs", () => {
    expect(WANT).toContain("league_ko|boardgame|blitz|F1@430");
    expect(WANT).not.toContain("league_ko|boardgame|blitz|F1@834");
    expect(WANT.filter((id) => /@\d+$/.test(id))).toHaveLength(15);
  });
});

describe("w2a-local-selection.json - the L1/L2 stripes hold the 77's grid cells (R-2)", () => {
  const SHARDS = 64;
  const SELECTION = readJson(`${TRUTH_RUNS}/w2a-local-selection.json`) as { browserShards: { of: number; scope: string; L1: number[]; L2: number[] } };
  /** A grid plan in the order `--shard k/64` stripes it: the keys, variant-free (the plan's own order, never a typed one). */
  const order = (L: "L1" | "L2"): string[] => LAYER_GRID_PLANNERS[L]({}).layered((sport) => sport).map((c) => noVariant(layerCaseId(c)));

  it("each layer's listed stripes are exactly the stripes the layered ids of the 77 fall in, and the L2 plan is the size the note names", () => {
    expect([SELECTION.browserShards.of, SELECTION.browserShards.scope]).toEqual([SHARDS, "grid"]);
    const layered = WANT.filter((id) => /@\d+$/.test(id)).map(noVariant);
    expect(layered).toHaveLength(15);
    let placed = 0;
    for (const L of ["L1", "L2"] as const) {
      const plan = order(L);
      const mine = layered.filter((k) => plan.includes(k));
      const stripes = [...new Set(mine.map((k) => plan.indexOf(k) % SHARDS + 1))].sort((a, b) => a - b);
      // The stripe function is the harness's own: every id of the layer is in the stripe it was assigned.
      for (const k of stripes) expect(stripe(plan, { index: k, of: SHARDS }).filter((x) => mine.includes(x)).length, `${L} stripe ${k}`).toBeGreaterThan(0);
      expect(SELECTION.browserShards[L], `${L}: the stripes that hold the 77's cells`).toEqual(stripes);
      placed += mine.length;
    }
    expect(placed, "every layered id is in exactly one grid plan").toBe(15);
    const l2 = order("L2").length;
    expect(String((SELECTION as unknown as { browserShards: { note: string } }).browserShards.note), "the note names the plan's size").toContain(`L2 ${l2}`);
  });
});

// --- the re-keys, as the ruling states them --------------------------------------------------------------------------

describe("expect-77-rekeys.json - the six cells D-P2 re-keys", () => {
  it("is exactly the ruling's six: each in the 77, was SC-O1, with its new gap, owner and pinned reason", () => {
    const byId = new Map(REKEYS_FILE.rekeys.map((r) => [r.caseId, r]));
    expect([...byId.keys()].sort()).toEqual([...SIX].sort());
    expect(byId.size).toBe(REKEYS_FILE.rekeys.length);
    let checked = 0;
    for (const id of SIX) {
      const r = byId.get(id)!;
      expect(WANT, id).toContain(id);
      expect(r.was, id).toBe("SC-O1");
      if (R4_CELLS.includes(id)) {
        expect([r.now, r.wave, r.rule, r.reason], id).toEqual(["CD-T13", "W2b", "BG-WO-2", R4_REASON]);
      } else {
        expect([r.now, r.wave], id).toEqual(["FX-G14", "W4"]);
        expect(r.reason, id).toContain("STAGE_COMPLETED_SEEDING_FAILED");
      }
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("the file parses against the expectation, and nothing but the six is re-keyed: 71 stay W2a's to turn green", () => {
    const rekeys = parseRekeys(REKEYS_FILE, WANT, "expect-77-rekeys.json");
    expect(rekeys).toHaveLength(6);
    expect(WANT.length - rekeys.length).toBe(71);
  });
});

// --- the judge ------------------------------------------------------------------------------------------------------

describe("judgeExpectation - 71 works + 6 red with the pinned reason", () => {
  it("passes for the ruling's outcome: 71 green, the six red for their pinned reasons (right reason passes)", () => {
    const v = judge(expectedRun());
    expect(v).toMatchObject({ expected: 77, read: 77, found: 77, works: 71, exit: 0, unexpectedRed: [], wrongReason: [], greened: [] });
    expect(v.pinnedRed.map((p) => p.caseId).sort()).toEqual([...SIX].sort());
    expect(v.pinnedRed.map((p) => `${p.now}/${p.wave}`).sort()).toEqual([...R4_CELLS.map(() => "CD-T13/W2b"), "FX-G14/W4"].sort());
  });

  it("empty case first: all 77 green (nothing re-keyed turned red) passes too, the six reported as greened so a stale pin is seen", () => {
    const v = judge(WANT.map((id) => kase(id)));
    expect(v).toMatchObject({ found: 77, works: 71, exit: 0, pinnedRed: [], unexpectedRed: [], wrongReason: [] });
    expect(v.greened.sort()).toEqual([...SIX].sort());
  });

  it("a re-keyed cell red for a DIFFERENT reason fails, naming what was pinned and what it said (wrong reason fails)", () => {
    let checked = 0;
    for (const id of SIX) {
      const v = judge(expectedRun((c) => (c.caseId === id ? kase(id, "red", "I1-rr-pair-once-per-leg: a pair met twice", [check("fail", "a pair met twice")]) : c)));
      expect(v.exit, id).toBe(1);
      expect(v.wrongReason.map((w) => w.caseId), id).toEqual([id]);
      expect(v.wrongReason[0]!.wanted, id).toBe(REKEYS_FILE.rekeys.find((r) => r.caseId === id)!.reason);
      expect(v.wrongReason[0]!.got, id).toContain("a pair met twice");
      expect([v.unexpectedRed.length, v.pinnedRed.length, v.works], id).toEqual([0, 5, 71]);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a pin written without the product's quotes (the ruling's own words, phase pre) still matches the product's text (phase \"pre\"), and nothing else is normalised", () => {
    const bareRekeys = REKEYS_FILE.rekeys.map((r) => (r.reason === R4_REASON ? { ...r, reason: "forfeit not allowed in phase pre" } : r));
    expect(judge(expectedRun(), bareRekeys)).toMatchObject({ exit: 0, works: 71, pinnedRed: expect.any(Array) });
    const different = REKEYS_FILE.rekeys.map((r) => (r.reason === R4_REASON ? { ...r, reason: "forfeit not allowed in phase live" } : r));
    expect(judge(expectedRun(), different).wrongReason).toHaveLength(5);
  });

  it("the pinned reason is found in a failing CHECK too, not only the case's own reason line", () => {
    const id = F1_CELL;
    const v = judge(expectedRun((c) => (c.caseId === id ? kase(id, "red", "life-loop-bounded: play loop exited not_reached", [check("fail", "x", ["stage 1's /complete answered 409 STAGE_COMPLETED_SEEDING_FAILED"])]) : c)));
    expect(v).toMatchObject({ exit: 0, wrongReason: [] });
    expect(v.pinnedRed.map((p) => p.caseId)).toContain(id);
  });

  it("a red that is NOT one of the six fails, named, with its state and reason (unexpected red fails)", () => {
    const green = WANT.find((id) => !SIX.includes(id))!;
    const v = judge(expectedRun((c) => (c.caseId === green ? kase(green, "red", "I3-table-points-equal-declared: a row's points differ") : c)));
    expect(v.exit).toBe(1);
    expect(v.unexpectedRed).toEqual([{ caseId: green, state: "red", reason: "I3-table-points-equal-declared: a row's points differ" }]);
    expect(v.works).toBe(70);
    expect(v.pinnedRed).toHaveLength(6);
  });

  it("every state short of works is an unexpected red on a non-re-keyed cell - swept over the harness's states, none skipped", () => {
    const green = WANT.find((id) => !SIX.includes(id))!;
    let swept = 0;
    for (const state of ["refused", "red", "later", "needs_ruling", "no_path", "not_run"] as const) {
      const v = judge(expectedRun((c) => (c.caseId === green ? kase(green, state, `a ${state} case`) : c)));
      expect(v.exit, state).toBe(1);
      expect(v.unexpectedRed.map((u) => [u.caseId, u.state]), state).toEqual([[green, state]]);
      swept++;
    }
    expect(swept).toBe(6);
  });

  it("a re-keyed cell in a state that is not red (not run, no path) is not 'red for the pinned reason' either", () => {
    const v = judge(expectedRun((c) => (c.caseId === F1_CELL ? kase(F1_CELL, "not_run", "STAGE_COMPLETED_SEEDING_FAILED was never driven") : c)));
    expect(v.exit).toBe(1);
    expect(v.wrongReason.map((w) => w.caseId)).toEqual([F1_CELL]);
  });

  it("an id the runs do not hold is a REFUSAL (ExpectedAbsent), never a pass over fewer cells; zero cases read is NoCases", () => {
    const e = refusal(() => judge(expectedRun().slice(1)));
    expect(e.name).toBe("ExpectedAbsent");
    expect(e.message).toContain(WANT[0]!);
    expect(refusal(() => judge([])).name).toBe("NoCases");
    expect(refusal(() => judgeExpectation({ want: WANT, rekeys: REKEYS_FILE.rekeys, sources: [] })).name).toBe("NoCases");
    expect(refusal(() => judgeExpectation({ want: WANT, rekeys: REKEYS_FILE.rekeys, sources: [{ label: "now", cases: [] }] })).name).toBe("NoCases");
  });

  it("the first source that holds an id decides it (CI before local), and an id only a later source holds is read from that one", () => {
    const all = expectedRun();
    const first = all.slice(0, 40).map((c) => (c.caseId === all[0]!.caseId ? kase(c.caseId, "red", "the CI run's red") : c));
    // The later run holds ALL 77 (the red id too, green there): an id both hold is decided by the first, one only it holds by it.
    const rest = all.slice();
    const v = judgeExpectation({ want: WANT, rekeys: REKEYS_FILE.rekeys, sources: [{ label: "ci", cases: first }, { label: "local", cases: rest }] });
    expect(v.found).toBe(77);
    expect(v.unexpectedRed.map((u) => u.caseId)).toEqual([all[0]!.caseId]); // the CI red wins over local's green
    expect(v.read).toBe(first.length + rest.length);
    // The same two runs the other way round: local's green decides it, so the order is what decided it (positive pair).
    const flipped = judgeExpectation({ want: WANT, rekeys: REKEYS_FILE.rekeys, sources: [{ label: "local", cases: rest }, { label: "ci", cases: first }] });
    expect(flipped.unexpectedRed).toEqual([]);
    expect(flipped.exit).toBe(0);
  });

  it("an id twice in ONE source is refused: which row is the case?", () => {
    const all = expectedRun();
    expect(refusal(() => judge([...all, all[3]!])).name).toBe("CaseRepeated");
  });
});

describe("the re-keys are held to the expectation they re-key", () => {
  const good = REKEYS_FILE.rekeys[0]!;
  it("a re-key of an id the expectation does not hold, a repeated one, and one with no pinned reason are each refused by name", () => {
    expect(refusal(() => parseRekeys({ note: "n", rekeys: [{ ...good, caseId: "knockout|generic|score|LIFECYCLE" }] }, WANT, "f")).name).toBe("RekeyNotExpected");
    expect(refusal(() => parseRekeys({ note: "n", rekeys: [good, good] }, WANT, "f")).name).toBe("RekeyRepeated");
    expect(refusal(() => parseRekeys({ note: "n", rekeys: [{ ...good, reason: "  " }] }, WANT, "f")).name).toBe("RekeysUnreadable");
    expect(refusal(() => parseRekeys({ note: "n", rekeys: [{ ...good, extra: 1 }] }, WANT, "f")).name).toBe("RekeysUnreadable");
    expect(refusal(() => parseRekeys({ note: "n" }, WANT, "f")).name).toBe("RekeysUnreadable");
  });
  it("an expectation that is not a list of distinct ids, or is empty, is refused", () => {
    expect(refusal(() => parseExpect(["a", "a"], "f")).name).toBe("ExpectUnreadable");
    expect(refusal(() => parseExpect({}, "f")).name).toBe("ExpectUnreadable");
    expect(refusal(() => parseExpect([], "f")).name).toBe("NoCases");
    expect(parseExpect(["a", "b"], "f")).toEqual(["a", "b"]);
  });
});

// --- the CLI --------------------------------------------------------------------------------------------------------

describe("w2a-expect.ts - the judge as Task 16 runs it", () => {
  const dir = mkdtempSync(join(tmpdir(), "w2a-expect-"));
  let n = 0;
  const put = (name: string, body: unknown): string => { const p = join(dir, `${++n}-${name}`); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
  const runOf = (cases: CaseResult[], runId = "r1"): RunResults => ({
    schemaVersion: 3, runId, harnessCommit: "abc1234", startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:10:00.000Z",
    grid: { rows: [...ROW_KEYS], sports: [...SPORT_KEYS] }, layer: "L3", driver: "http", plan: "--set w1-driving", cases,
  });
  let out: string[] = [];
  let err: string[] = [];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  });
  afterEach(() => vi.restoreAllMocks());
  const argv = (now: string[], extra: string[] = []) => ["--expect", join(REPO, REPRO, "expect-77.json"), "--rekeys", join(REPO, REPRO, "expect-77-rekeys.json"), ...now.flatMap((f) => ["--now", f]), ...extra];

  it("exit 0 for the ruling's outcome, naming the counts; exit 1 for an unexpected red, naming it; exit 2 for a missing id", () => {
    expect(main(argv([put("run.json", runOf(expectedRun()))]))).toBe(0);
    expect(out.join("")).toMatch(/expected 77, found 77: 71 works, 6 red as pinned, 0 greened; 0 unexpected red, 0 wrong reason/);
    out = [];
    const green = WANT.find((id) => !SIX.includes(id))!;
    expect(main(argv([put("run.json", runOf(expectedRun((c) => (c.caseId === green ? kase(green, "red", "boom") : c))))]))).toBe(1);
    expect(out.join("")).toContain(`unexpected red ${green}: red - boom`);
    out = [];
    expect(main(argv([put("run.json", runOf(expectedRun().slice(2)))]))).toBe(2);
    expect(err.join("")).toMatch(/ExpectedAbsent/);
  });

  it("two runs: the first that holds an id decides it; --json-out writes the verdict as the judge returned it", () => {
    const all = expectedRun();
    const a = put("a.json", runOf(all.slice(0, 50), "ci"));
    const b = put("b.json", runOf(all.slice(40), "local"));
    const jsonOut = join(dir, "verdict.json");
    expect(main(argv([a, b], ["--json-out", jsonOut]))).toBe(0);
    const v = JSON.parse(readFileSync(jsonOut, "utf8")) as { expected: number; found: number; works: number; exit: number };
    expect(v).toMatchObject({ expected: 77, found: 77, works: 71, exit: 0 });
  });

  it("usage and unreadable input are refused (2), nothing judged", () => {
    expect(main([])).toBe(2);
    expect(main(["--expect", "/nonexistent/expect.json", "--rekeys", "/nonexistent/r.json", "--now", "/nonexistent/run.json"])).toBe(2);
    expect(err.join("")).toMatch(/ExpectUnreadable/);
    err = [];
    expect(main(argv([put("bad.json", "{not json")]))).toBe(2);
    expect(err.join("")).toMatch(/RunUnreadable/);
  });
});
