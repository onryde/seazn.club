// W1d Task 21 (owner ruling 70, R70-IMPL) and its retirement (W3 Swiss App B, Task 12).
//
// Ruling 70 (2026-10-05): the three swiss_knockout R4 cells whose Swiss round 5 paired nobody by the product's own lots
// tiebreak (a UUID-hashed draw, by design — it exposed P6/SW-H1) were recorded RED, cause P6, whatever the baseline run
// happened to show. The override lived in catalogue/baseline.json (`ruling70`) and `judge regression` applied it.
//
// W3 fixed SW-H1: the engine's pairRound (2.0.0 and later) pairs where 1.x dead-ended, and swissGen refuses a round it
// cannot pair (SWISS_NO_LEGAL_PAIRING) instead of reporting an empty round as success. Task 12 re-baselined L3 on the W3
// truth run (truth-runs/w3-final, CI 41818942253) and retired the block in the same change, as `W3-swiss.md` ("Output and
// handoff") requires. What is pinned here, and where each expected value comes from:
//   - the live baseline carries no block, and a block is refused by name wherever the baseline is read (pr-sample's
//     reader, the real judge, the real matrix:sample): the retirement cannot be undone by a re-baseline carrying it forward;
//   - the committed baseline holds none of the three cells red on "paired nobody" (the three typed from the RULING, the
//     reason from the SW-H1 triage rule's own key), and no case of it at all;
//   - with nothing held, a former ruling cell going red in a later run IS a regression (the cells work in the baseline);
//   - the W1d record the ruling was made on is history and stays: (b)/(c) below still read it.
// The W1d record keeps its own block (truth-runs/w1d-baseline/baseline.json): backlog.test.ts holds the backlog to it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main as judgeMain } from "../judge.ts";
import { forceBaselineStates } from "../lib/judge.ts";
import * as prSample from "../lib/pr-sample.ts";
import { BaselineUnreadable, baselineL3Path, baselineOverrides, parseRows, planPrSample } from "../lib/pr-sample.ts";
import { AUDIT_DIR, readAudit } from "../lib/audit-ledger.ts";
import { parseResults } from "../lib/results.ts";
import { CATALOGUE_DIR, loadCatalogue, triage } from "../lib/triage.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

/** Owner ruling 70's three ids (progress.md, 2026-10-05, chat "A"): typed from the ruling. */
const RULING_70 = [
  "swiss_knockout|football|11-a-side|R4",
  "swiss_knockout|carrom|club-29|R4",
  "swiss_knockout|generic|score|R4",
] as const;
/** The committed baseline's run directory (L1, L2, L3): the W3 truth run's CI artifact (W3 App B Task 12). */
const BASELINE_DIR = `${TRUTH_RUNS}/w3-final/ci`;
/** The W1d record the ruling was made on: three dispatches, kept as history (the ruling's justification). */
const W1D_DIR = `${TRUTH_RUNS}/w1d-baseline`;
/** The W1d record's own third dispatch (run 37346206686, tag matrix-truth/w1d-baseline): the run the ruling's evidence reads from. */
const W1D_THIRD_RUN = 37346206686;
/** What the live reader says of any `ruling70` key (Task 12 brief, pr-sample.ts BaselineFile). */
// No wave literal: the Q-A guard (scenario-catalogue.test.ts) refuses a bare wave token in a shipped literal outside routeTo.
const RETIRED = /owner ruling 70 retired by the SW-H1 fix; a re-baseline never carries it/;
/** The SW-H1 reason, as the committed triage rules key it (catalogue/triage-rules.json, the swiss-round-paired-nobody-* rules). */
const PAIRED_NOBODY = /paired nobody/;

interface Loose { caseId: string; state: string; reason?: string; [k: string]: unknown }
interface LooseRun { runId: string; harnessCommit: string; cases: Loose[]; [k: string]: unknown }
let baseline: LooseRun;
/** The W1d record's third dispatch (history): read in the (b)/(c) tests only. */
let w1dThird: LooseRun;
const stateOf = (id: string): string => {
  const c = baseline.cases.find((x) => x.caseId === id);
  if (c === undefined) throw new Error(`${id} is not a case of the committed L3 baseline`);
  return c.state;
};
beforeAll(() => {
  // By path, not through baselineL3Path: a block put back in the live file must red the retirement test BY NAME, not every test of the file
  // at its hook. The retirement test holds the reader to this same path.
  baseline = JSON.parse(readFileSync(resolve(REPO, BASELINE_DIR, "L3", "results.json"), "utf8")) as LooseRun;
  w1dThird = JSON.parse(readFileSync(resolve(REPO, W1D_DIR, "L3", "results.json"), "utf8")) as LooseRun;
});

const scratch = mkdtempSync(join(tmpdir(), "w3-t12-r70-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
let n = 0;
const fresh = (label: string): string => { const d = join(scratch, `${label}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const LIVE_JSON = resolve(CATALOGUE_DIR, "baseline.json");
/** A catalogue whose baseline.json is the live one with `ruling70` set to `block`. */
const catWith = (block: unknown): string => {
  const cat = fresh("cat");
  writeFileSync(join(cat, "baseline.json"), JSON.stringify({ ...(JSON.parse(readFileSync(LIVE_JSON, "utf8")) as object), ruling70: block }));
  return cat;
};
/** The last real block there was: the W1d record's, byte for byte what the live file carried before W2e (history, never edited). */
const recordBlock = (): unknown => (JSON.parse(readFileSync(resolve(REPO, W1D_DIR, "baseline.json"), "utf8")) as { ruling70: unknown }).ruling70;

// --- the retirement ---------------------------------------------------------------------------------------------------

describe("ruling 70 is retired (W3, SW-H1): the live baseline carries no block, and none can come back", () => {
  it("ruling 70 is retired: the live baseline carries no ruling70 block, and a block is refused by name", () => {
    const live = JSON.parse(readFileSync(LIVE_JSON, "utf8")) as Record<string, unknown>;
    expect(Object.keys(live), "baseline.json names the L3 and nothing else").toEqual(["L3"]);
    expect(baselineL3Path()).toBe(resolve(REPO, BASELINE_DIR, "L3", "results.json"));
    expect(baselineOverrides(), "no override").toBeNull();
    expect(Object.keys(prSample), "the constant went with the block").not.toContain("RULING_70_IDS");
    // Any block, of any shape: the real one, an empty one, and values that are no block at all. Each is refused by both readers, by name.
    const blocks: [string, unknown][] = [
      ["the W1d record's block (the last real one)", recordBlock()],
      ["the same block, carried forward with the W3 run's provenance", { ...(recordBlock() as object), workflowRun: 41818942253, tag: "feat/w3-swiss-app-b", tagCommit: "bc6b645608787458617f1d530888b62c8d5f5009" }],
      ["an empty block", {}],
      ["null", null],
      ["a list", []],
    ];
    let checked = 0;
    for (const [why, block] of blocks) {
      const cat = catWith(block);
      for (const read of [() => baselineL3Path({ catalogue: cat }), () => baselineOverrides({ catalogue: cat })]) {
        expect(read, why).toThrow(BaselineUnreadable);
        expect(read, why).toThrow(RETIRED);
        checked++;
      }
    }
    expect(checked).toBe(blocks.length * 2);
    // The positive pair: the same file without the key is read (the refusal is the key's, not the copy's).
    const plain = fresh("cat-plain");
    writeFileSync(join(plain, "baseline.json"), readFileSync(LIVE_JSON));
    expect(baselineL3Path({ catalogue: plain })).toBe(baselineL3Path());
    expect(baselineOverrides({ catalogue: plain })).toBeNull();
  });
});

// --- the committed baseline -------------------------------------------------------------------------------------------

describe("the committed baseline (W3 truth run, CI 41818942253) shows no SW-H1", () => {
  it("the committed baseline holds none of the three cells red on \"paired nobody\"", () => {
    expect(baseline.runId).toBe("ci-41818942253-1-l3");
    let checked = 0;
    for (const id of RULING_70) {
      const c = baseline.cases.find((x) => x.caseId === id);
      expect(c, `${id} is a case of the committed baseline (a typo would prove nothing)`).toBeDefined();
      expect(c!.state === "red" && PAIRED_NOBODY.test(c!.reason ?? ""), `${id}: ${c!.state} ${c!.reason ?? ""}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(RULING_70.length);
    // The cell the brief names beside them (red in the W2e baseline on SW-H1) and the rest of the layer: no case reads paired nobody.
    expect(stateOf("swiss_knockout|hockey|fih-outdoor|R4")).not.toBe("red");
    const said = baseline.cases.filter((c) => PAIRED_NOBODY.test(c.reason ?? ""));
    expect(said.map((c) => c.caseId)).toEqual([]);
    expect(baseline.cases.length, "the sweep read the whole layer").toBe(930);
  });

  it("the committed triage keys no L3 red to SW-H1, while the SW-H1 rules stay and still key an empty success should one come back", () => {
    const cat = loadCatalogue(CATALOGUE_DIR);
    const audit = readAudit(AUDIT_DIR);
    const ledger = [...audit.gaps, ...audit.umbrellas].map((g) => ({ id: g.id }));
    const run = (file: string) => {
      const r = parseResults(JSON.parse(readFileSync(file, "utf8")));
      if (r.schemaVersion !== 3) throw new Error(`${file}: a v3 run`);
      return r;
    };
    const r = run(baselineL3Path());
    const swH1 = cat.rules.rules.filter((x) => x.gap === "SW-H1");
    expect(swH1.map((x) => x.id).sort(), "the SW-H1 rules are kept").toEqual(["swiss-round-paired-nobody-swiss-knockout", "swiss-round-paired-nobody-swiss-playoff"]);
    const result = triage([{ layer: "L3", runId: r.runId, plan: r.plan, cases: r.cases }], cat.rules, cat.routing, ledger, cat.newGaps);
    expect(result.rows.length, "the layer's reds were triaged").toBeGreaterThan(0);
    expect(result.rows.filter((x) => x.gap === "SW-H1").map((x) => x.caseId)).toEqual([]);
    // The rules still classify the shape they were written for: the REAL SW-H1 red of the previous baseline (W2e CI, carrom R4),
    // put back in place of this run's case, keys to SW-H1 at W3.
    const was = run(resolve(REPO, TRUTH_RUNS, "w2e-final", "ci", "L3", "results.json")).cases.find((c) => c.caseId === RULING_70[1])!;
    expect(was.state === "red" && PAIRED_NOBODY.test(was.reason), `the W2e record is an SW-H1 red: ${was.reason}`).toBe(true);
    const back = r.cases.map((c) => (c.caseId === was.caseId ? was : c));
    const again = triage([{ layer: "L3", runId: r.runId, plan: r.plan, cases: back }], cat.rules, cat.routing, ledger, cat.newGaps);
    expect(again.rows.find((x) => x.caseId === was.caseId), "an SW-H1 red is still keyed").toMatchObject({ gap: "SW-H1", wave: "W3" });
  });
});

// --- (b), (c): the override is not decoration over a case that never flipped -------------------------------------------

describe("(b) and (c): each of the three was red in at least one of the three T17 dispatches, and works in at least one (the W1d record the ruling was made on)", () => {
  /** The `judge across` output for L3, verbatim in HARNESS-GREEN.md: "  differing <id>: <state>, <state>, <state>". Read inside
   *  the test, never at describe level: a missing file must fail these tests BY NAME, not fail the whole file to collect. */
  const differing = (): Map<string, string[]> => {
    const green = readFileSync(resolve(REPO, W1D_DIR, "HARNESS-GREEN.md"), "utf8");
    const out = new Map<string, string[]>();
    for (const m of green.matchAll(/^ {2}differing (\S+): (\S+(?:, \S+)*)$/gm)) out.set(m[1]!, m[2]!.split(", "));
    return out;
  };

  it("the verbatim across output names exactly ruling 70's three ids as the L3 cases whose state differs, each over three runs", () => {
    const d = differing();
    expect([...d.keys()].sort(), "the cases whose state differs across the three runs").toEqual([...RULING_70].sort());
    let checked = 0;
    for (const id of RULING_70) {
      const s = d.get(id)!;
      expect(s, id).toHaveLength(3);
      expect(s, `${id}: red in at least one dispatch (b)`).toContain("red");
      expect(s, `${id}: works in at least one dispatch (c)`).toContain("works");
      checked++;
    }
    expect(checked).toBe(RULING_70.length);
  });

  it("the committed cut of the three dispatches (dispatch-cuts.json) agrees with the across output, case by case, and its third dispatch IS the W1d record's L3", () => {
    const cuts = JSON.parse(readFileSync(resolve(REPO, W1D_DIR, "dispatch-cuts.json"), "utf8")) as { dispatches: { n: number; cases: Loose[] }[] };
    expect(cuts.dispatches.map((x) => x.n)).toEqual([1, 2, 3]);
    const d = differing();
    let checked = 0;
    for (const id of RULING_70) {
      const states = cuts.dispatches.map((x) => x.cases.find((c) => c.caseId === id)?.state);
      expect(states, id).toEqual(d.get(id));
      checked++;
    }
    expect(checked).toBe(RULING_70.length);
    // Dispatch 3's cut is the W1d record's own cases, field for field: the cut is no second source of truth.
    const third = cuts.dispatches[2]!.cases;
    expect(third.length).toBeGreaterThanOrEqual(RULING_70.length);
    for (const c of third) expect(c, c.caseId).toEqual(w1dThird.cases.find((x) => x.caseId === c.caseId));
  });

  it("the third run in each row is the W1d record's own L3 state — that L3 IS dispatch 3 (it was the baseline until Task 35)", () => {
    const d = differing();
    const third = (id: string): string => w1dThird.cases.find((x) => x.caseId === id)!.state;
    for (const id of RULING_70) expect(d.get(id)![2], id).toBe(third(id));
    expect(w1dThird.runId).toBe(`ci-${W1D_THIRD_RUN}-1-l3`);
    // Both extremes occur in that run itself: it holds a red among the three and a works among them.
    expect(new Set(RULING_70.map(third))).toEqual(new Set(["red", "works"]));
  });

  it("the triage fixture (cut from the three runs) agrees: it lists each id red in exactly the dispatches the across output says", () => {
    const fixture = JSON.parse(readFileSync(resolve(REPO, "tools/matrix/__tests__/fixtures/triage-shapes.json"), "utf8")) as { flips: { why: string; run: number; caseId: string }[] };
    const d = differing();
    let checked = 0;
    for (const id of RULING_70) {
      const redRuns = fixture.flips.filter((f) => f.why === "ruling 70" && f.caseId === id).map((f) => f.run).sort();
      const fromAcross = d.get(id)!.flatMap((s, i) => (s === "red" ? [i + 1] : []));
      expect(redRuns, id).toEqual(fromAcross);
      checked++;
    }
    expect(checked).toBe(RULING_70.length);
  });
});

// --- forceBaselineStates ----------------------------------------------------------------------------------------------

describe("forceBaselineStates", () => {
  const c = (caseId: string, state: "works" | "red" | "refused" | "later") => ({ caseId, state, reason: "r" }) as const;
  it("replaces the state of the listed ids only, and says which it replaced", () => {
    const run = { cases: [c("a", "works"), c("b", "works"), c("c", "red")] };
    const r = forceBaselineStates(run, new Map([["a", "red" as const], ["c", "red" as const]]));
    expect(r.run.cases.map((x) => [x.caseId, x.state])).toEqual([["a", "red"], ["b", "works"], ["c", "red"]]);
    expect(r.applied).toEqual(["a", "c"]);
    expect(run.cases[0]!.state, "the input is not edited").toBe("works");
  });
  it("the empty override changes nothing, and an id the baseline lacks is not applied", () => {
    const run = { cases: [c("a", "works")] };
    expect(forceBaselineStates(run, new Map())).toEqual({ run, applied: [] });
    expect(forceBaselineStates(run, new Map([["zz", "red" as const]])).applied).toEqual([]);
  });
});

// --- judge regression against the re-baselined L3: nothing holds a former ruling cell red ----------------------------------

describe("judge regression against the REAL committed baseline: nothing is held red any more", () => {
  let out: string[] = [];
  let err: string[] = [];
  beforeEach(() => {
    out = []; err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const said = (): string => `${out.join("")}${err.join("")}`;

  /** A later run of `ids`: the committed baseline's own cases, each in the state `as` gives it (as the baseline when `as` lacks it). */
  const later = (ids: readonly string[], as: Record<string, "works" | "red">): { now: string; expect: string } => {
    const cases = baseline.cases.filter((x) => ids.includes(x.caseId)).map((x) => {
      const s = as[x.caseId] ?? x.state;
      return s === x.state ? x : { ...x, state: s, reason: s === "red" ? "later run: round 5 paired nobody (SW-H1)" : "", checks: s === "works" ? x.checks : [] };
    });
    expect(cases.length, "every id is in the baseline").toBe(ids.length);
    const dir = fresh("later");
    writeFileSync(join(dir, "now.json"), JSON.stringify({ ...baseline, runId: "later-run", cases }));
    writeFileSync(join(dir, "expect.json"), JSON.stringify(ids));
    return { now: join(dir, "now.json"), expect: join(dir, "expect.json") };
  };
  const judge = (files: { now: string; expect: string }, jsonOut?: string, over?: { catalogue?: string }): number =>
    judgeMain(["regression", "--baseline", baselineL3Path(), "--now", files.now, "--expect", files.expect, "--sample", ...(jsonOut === undefined ? [] : ["--json-out", jsonOut])], over);
  const verdict = (p: string): { regressed: { caseId: string; was: string; now: string }[]; compared: number; exit: number } => JSON.parse(readFileSync(p, "utf8")) as never;

  it("a former ruling-70 cell red in a later run IS a regression now: exit 1, each of the three named, and no 'baseline overrides' line", () => {
    expect(RULING_70.map(stateOf), "all three work in the committed baseline").toEqual(["works", "works", "works"]);
    const o = join(fresh("o"), "v.json");
    const code = judge(later([...RULING_70], Object.fromEntries(RULING_70.map((id) => [id, "red" as const]))), o);
    expect(code, said()).toBe(1);
    expect(verdict(o).regressed.map((r) => [r.caseId, r.was, r.now]).sort()).toEqual(RULING_70.map((id) => [id, "works", "red"]).sort());
    expect(said()).not.toMatch(/baseline overrides/);
    // One at a time too: each cell is its own regression, not one that happens to cover the others.
    let alone = 0;
    for (const id of RULING_70) {
      out = []; err = [];
      const o1 = join(fresh("o"), "v.json");
      expect(judge(later([...RULING_70], { [id]: "red" }), o1), `${id}: ${said()}`).toBe(1);
      expect(verdict(o1).regressed.map((r) => r.caseId)).toEqual([id]);
      alone++;
    }
    expect(alone).toBe(RULING_70.length);
  });

  it("the empty case: the three as the baseline holds them are no change — exit 0, 0 regressions, all three compared", () => {
    const o = join(fresh("o"), "v.json");
    expect(judge(later([...RULING_70], {}), o), said()).toBe(0);
    expect(verdict(o)).toMatchObject({ exit: 0, compared: RULING_70.length, regressed: [] });
  });

  it("a baseline.json that carries a block again is a refusal by name through the real judge (exit 2), never a verdict made with or without it", () => {
    const code = judge(later([...RULING_70], {}), undefined, { catalogue: catWith(recordBlock()) });
    expect(code, said()).toBe(2);
    expect(said()).toMatch(/judge: BaselineUnreadable: /);
    expect(said()).toMatch(RETIRED);
  });
});

// --- the real matrix:sample --------------------------------------------------------------------------------------------

describe("matrix:sample, the real CLI with the real judge and the real baseline (the run alone is stood in)", () => {
  const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const ARGS = "--set pr-sample --rows swiss_knockout --workers 4";
  const bin = fresh("bin");
  // What a run of the sample would write: the baseline's own cases, restricted to the ids the sample planned (the expect file
  // run-sample wrote), under the run id it was given — except the ids a test flips, which go red (in the re-run too).
  writeFileSync(join(bin, "run-flip.mjs"), `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const at = (f) => process.argv[process.argv.indexOf(f) + 1];
const id = at("--run-id"); const dir = at("--report-dir");
const rerun = id.endsWith("-r");
const want = new Set(JSON.parse(readFileSync(dir + "/" + (rerun ? id.slice(0, -2) : id) + ".expect.json", "utf8")));
const base = JSON.parse(readFileSync(process.env.BASELINE_FILE, "utf8"));
const flip = new Set((process.env.FLIP ?? "").split(",").filter(Boolean));
const cases = base.cases.filter((c) => want.has(c.caseId)).map((c) => (flip.has(c.caseId) ? { ...c, state: "red", reason: "flipped by the test" } : c));
mkdirSync(dir + "/" + id, { recursive: true });
writeFileSync(dir + "/" + id + "/results.json", JSON.stringify({ ...base, runId: id, cases }));
`);
  const planned = (): string[] => planPrSample(parseRows("swiss_knockout"), offlineBuilderDefault).map((c) => c.caseId);

  function sample(flip: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const words = (scripts["matrix:sample"] ?? "").split(" ");
    expect(words[0]).toBe("node");
    const reportDir = join(fresh("rep"), "out");
    const r = spawnSync(process.execPath, [...words.slice(1), "--run-id", "ci-5-1-l3-sample", "--report-dir", reportDir], {
      cwd: REPO, encoding: "utf8", timeout: 4 * SPAWN_MS,
      env: { PATH: process.env.PATH ?? "", MATRIX_ARGS: ARGS, MATRIX_RUN_BIN: join(bin, "run-flip.mjs"), BASELINE_FILE: baselineL3Path(), FLIP: flip.join(",") },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("the sample rows plan all three former ruling-70 ids (anti-vacuity: a sample that plans none proves nothing)", () => {
    expect(RULING_70.filter((id) => planned().includes(id))).toHaveLength(RULING_70.length);
  });

  it("the three going red in a sample are regressions the re-run reproduces: exit 1, each named, and the judge holds none of them", () => {
    const s = sample([...RULING_70]);
    expect(s.status, `${s.stderr}\n${s.stdout}`).toBe(1);
    expect(s.stdout).toMatch(new RegExp(`${RULING_70.length} regressions reproduced by the re-run`));
    const reproduced = s.stdout.split("regressions reproduced by the re-run")[1] ?? "";
    for (const id of RULING_70) expect(reproduced, id).toContain(id);
    expect(`${s.stdout}${s.stderr}`).not.toMatch(/baseline overrides/);
  }, spawnBudget(2, 4 * SPAWN_MS));
});
