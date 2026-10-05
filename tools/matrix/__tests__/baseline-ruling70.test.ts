// W1d Task 21 (owner ruling 70, R70-IMPL): the committed baseline carries an explicit override list.
//
// Ruling 70 (2026-10-05): the three swiss_knockout R4 cells whose Swiss round 5 pairs nobody by the product's own
// lots tiebreak (a UUID-hashed draw, by design — it exposes P6/SW-H1) are recorded RED, cause P6, whatever the baseline run
// happened to show. Triage keys only reds, so a case the third dispatch saw WORK cannot be keyed by a rule. The override
// therefore lives in catalogue/baseline.json (`ruling70`), beside the L3 path it qualifies, and `judge regression` — the one
// reader of a baseline — applies it. `matrix:sample` judges through that CLI, and so does any weekly caller.
//
// What is pinned here, and where each expected value comes from:
//   (a) the list is exactly ruling 70's three ids — typed here from the RULING, never read from baseline.json;
//   (b) each was red in at least one of the three T17 dispatches, and (c) works in at least one — read from the committed
//       `judge across` output (HARNESS-GREEN.md), cross-checked against the committed third run and the triage fixture, so
//       the override is never decoration over a case that never flipped;
//   (d) a later run's `works` on them reads as an improvement and its `red` as no change — driven through the REAL judge
//       CLI (and the real `matrix:sample`, whose run alone is stood in), never through a fixture on both ends.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main as judgeMain } from "../judge.ts";
import { forceBaselineStates } from "../lib/judge.ts";
import { BaselineUnreadable, baselineL3Path, baselineOverrides, parseRows, planPrSample } from "../lib/pr-sample.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

/** Owner ruling 70's three ids (progress.md, 2026-10-05, chat "A"): typed from the ruling. */
const RULING_70 = [
  "swiss_knockout|football|11-a-side|R4",
  "swiss_knockout|carrom|club-29|R4",
  "swiss_knockout|generic|score|R4",
] as const;
const BASELINE_DIR = `${TRUTH_RUNS}/w1d-baseline`;

interface Loose { caseId: string; state: string; [k: string]: unknown }
interface LooseRun { cases: Loose[]; [k: string]: unknown }
let baseline: LooseRun;
const stateOf = (id: string): string => {
  const c = baseline.cases.find((x) => x.caseId === id);
  if (c === undefined) throw new Error(`${id} is not a case of the committed L3 baseline`);
  return c.state;
};
beforeAll(() => {
  baseline = JSON.parse(readFileSync(baselineL3Path(), "utf8")) as LooseRun;
});

const scratch = mkdtempSync(join(tmpdir(), "w1d-t21-r70-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
let n = 0;
const fresh = (label: string): string => { const d = join(scratch, `${label}-${++n}`); mkdirSync(d, { recursive: true }); return d; };

// --- (a) the list, and the baseline file that holds it ----------------------------------------------------------------

describe("catalogue/baseline.json: the ruling-70 list", () => {
  it("(a) names the committed third-dispatch L3 and exactly ruling 70's three ids, forced red with cause P6 (SW-H1, W3)", () => {
    expect(baselineL3Path()).toBe(resolve(REPO, BASELINE_DIR, "L3", "results.json"));
    const o = baselineOverrides();
    expect(o, "baseline.json carries a ruling70 block").not.toBeNull();
    expect([...o!.ids].sort()).toEqual([...RULING_70].sort());
    expect(new Set(o!.ids).size, "no id twice").toBe(RULING_70.length);
    expect({ state: o!.state, cause: o!.cause, gap: o!.gap, wave: o!.wave }).toEqual({ state: "red", cause: "P6", gap: "SW-H1", wave: "W3" });
  });

  it("every id is a case of the committed baseline (a typo would override nothing, silently)", () => {
    let found = 0;
    for (const id of baselineOverrides()!.ids) { expect(baseline.cases.some((c) => c.caseId === id), id).toBe(true); found++; }
    expect(found).toBe(RULING_70.length);
  });

  const noRuling = (extra: Record<string, unknown>): string => {
    const cat = fresh("cat");
    writeFileSync(join(cat, "baseline.json"), JSON.stringify({ L3: `${BASELINE_DIR}/L3/results.json`, ...extra }));
    return cat;
  };
  const block = { note: "x", state: "red", cause: "P6", gap: "SW-H1", wave: "W3", ids: [RULING_70[0]] };

  it("no ruling70 key: no override, and the L3 path still resolves (a baseline with no ruling is an ordinary baseline)", () => {
    const cat = noRuling({});
    expect(baselineOverrides({ catalogue: cat })).toBeNull();
    expect(baselineL3Path({ catalogue: cat })).toBe(resolve(REPO, BASELINE_DIR, "L3", "results.json"));
  });

  it("a ruling70 block that is not the shape is refused by name, whichever field is wrong — never read as 'no override'", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["state works (an override can only force red)", { ...block, state: "works" }],
      ["no ids", { ...block, ids: [] }],
      ["an id twice", { ...block, ids: [RULING_70[0], RULING_70[0]] }],
      ["an empty id", { ...block, ids: [""] }],
      ["no cause", { ...block, cause: "" }],
      ["no gap", { ...block, gap: "" }],
      ["no wave", { ...block, wave: "" }],
      ["an unknown key", { ...block, extra: 1 }],
      ["not an object", [] as unknown as Record<string, unknown>],
    ];
    let checked = 0;
    for (const [why, b] of bad) {
      const cat = noRuling({ ruling70: b });
      expect(() => baselineOverrides({ catalogue: cat }), why).toThrow(BaselineUnreadable);
      expect(() => baselineOverrides({ catalogue: cat }), why).toThrow(/ruling70/);
      checked++;
    }
    expect(checked).toBe(bad.length);
    // The good block parses: the table's refusals are the block's fields, not the harness around it.
    expect(baselineOverrides({ catalogue: noRuling({ ruling70: block }) })!.ids).toEqual([RULING_70[0]]);
  });
});

// --- (b), (c): the override is not decoration over a case that never flipped -------------------------------------------

describe("(b) and (c): each of the three was red in at least one of the three T17 dispatches, and works in at least one", () => {
  /** The `judge across` output for L3, verbatim in HARNESS-GREEN.md: "  differing <id>: <state>, <state>, <state>". Read inside
   *  the test, never at describe level: a missing file must fail these tests BY NAME, not fail the whole file to collect. */
  const differing = (): Map<string, string[]> => {
    const green = readFileSync(resolve(REPO, BASELINE_DIR, "HARNESS-GREEN.md"), "utf8");
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

  it("the committed cut of the three dispatches (dispatch-cuts.json) agrees with the across output, case by case, and its third dispatch IS the committed L3", () => {
    const cuts = JSON.parse(readFileSync(resolve(REPO, BASELINE_DIR, "dispatch-cuts.json"), "utf8")) as { dispatches: { n: number; cases: Loose[] }[] };
    expect(cuts.dispatches.map((x) => x.n)).toEqual([1, 2, 3]);
    const d = differing();
    let checked = 0;
    for (const id of RULING_70) {
      const states = cuts.dispatches.map((x) => x.cases.find((c) => c.caseId === id)?.state);
      expect(states, id).toEqual(d.get(id));
      checked++;
    }
    expect(checked).toBe(RULING_70.length);
    // Dispatch 3's cut is the committed run's own cases, field for field: the cut is no second source of truth.
    const third = cuts.dispatches[2]!.cases;
    expect(third.length).toBeGreaterThanOrEqual(RULING_70.length);
    for (const c of third) expect(c, c.caseId).toEqual(baseline.cases.find((x) => x.caseId === c.caseId));
  });

  it("the third run in each row is the committed baseline's own state — the baseline IS dispatch 3", () => {
    const d = differing();
    for (const id of RULING_70) expect(d.get(id)![2], id).toBe(stateOf(id));
    // Both extremes occur in the committed run itself: it holds a red among the three and a works among them.
    expect(new Set(RULING_70.map(stateOf))).toEqual(new Set(["red", "works"]));
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

// --- (d) through the real judge --------------------------------------------------------------------------------------

describe("(d) judge regression against the REAL committed baseline", () => {
  let out: string[] = [];
  let err: string[] = [];
  beforeEach(() => {
    out = []; err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const said = (): string => `${out.join("")}${err.join("")}`;

  /** A held case on the same row and scenario as the ruling's three, which the ruling does NOT cover: the control. */
  const control = (): string => {
    const id = baseline.cases.find((x) => x.caseId.startsWith("swiss_knockout|") && x.caseId.endsWith("|R4") && x.state === "works" && !(RULING_70 as readonly string[]).includes(x.caseId))?.caseId;
    if (id === undefined) throw new Error("no held swiss_knockout R4 case outside the ruling: the control is gone");
    return id;
  };

  /** A later run of `ids`: the committed baseline's own cases, each in the state `as` gives it (red when `as` lacks it). */
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
    judgeMain(["regression", "--baseline", baselineL3Path(), "--now", files.now, "--expect", files.expect, ...(jsonOut === undefined ? [] : ["--json-out", jsonOut])], over);
  const verdict = (p: string): { regressed: { caseId: string; was: string; now: string }[]; compared: number; exit: number } => JSON.parse(readFileSync(p, "utf8")) as never;

  it("red stays red: every ruling-70 id red in the later run is NO CHANGE — exit 0, 0 regressions, all four compared (two of them WORKED in the committed run)", () => {
    expect(RULING_70.map(stateOf).filter((s) => s === "works"), "the carrom and generic cells worked in the committed run").toHaveLength(2);
    const ids = [...RULING_70, control()];
    const o = join(fresh("o"), "v.json");
    const code = judge(later(ids, Object.fromEntries(RULING_70.map((id) => [id, "red" as const]))), o);
    expect(code, said()).toBe(0);
    expect(said()).toMatch(/compared 4 cases; 0 regressions/);
    expect(verdict(o)).toMatchObject({ exit: 0, compared: 4, regressed: [] });
    // The judge says the override was live: 3 cases read from the baseline as red, not as the run showed them.
    expect(said()).toMatch(/baseline overrides: 3 case\(s\) held red \(cause P6, SW-H1, W3\)/);
  });

  it("works on any of them is an improvement, not a regression: exit 0, and red → works is not listed", () => {
    const ids = [...RULING_70, control()];
    const o = join(fresh("o"), "v.json");
    const code = judge(later(ids, Object.fromEntries(RULING_70.map((id) => [id, "works" as const]))), o);
    expect(code, said()).toBe(0);
    expect(verdict(o).regressed).toEqual([]);
    expect(said()).toMatch(/0 regressions/);
  });

  it("the override does not over-reach: the control (same row, same scenario, held, NOT in the ruling) going red IS a regression, exit 1, named alone", () => {
    const ctl = control();
    const ids = [...RULING_70, ctl];
    const o = join(fresh("o"), "v.json");
    const code = judge(later(ids, { ...Object.fromEntries(RULING_70.map((id) => [id, "red" as const])), [ctl]: "red" }), o);
    expect(code, said()).toBe(1);
    expect(verdict(o).regressed.map((r) => [r.caseId, r.was, r.now])).toEqual([[ctl, "works", "red"]]);
  });

  it("TEETH: with the ruling70 block absent, the same later run IS a regression on the two cells that worked — the override is what clears them", () => {
    const cat = fresh("cat-none");
    writeFileSync(join(cat, "baseline.json"), JSON.stringify({ L3: `${BASELINE_DIR}/L3/results.json` }));
    const ids = [...RULING_70, control()];
    const o = join(fresh("o"), "v.json");
    const code = judge(later(ids, Object.fromEntries(RULING_70.map((id) => [id, "red" as const]))), o, { catalogue: cat });
    expect(code, said()).toBe(1);
    expect(verdict(o).regressed.map((r) => r.caseId).sort()).toEqual(RULING_70.filter((id) => stateOf(id) === "works").sort());
    expect(said(), "no override line when none applies").not.toMatch(/baseline overrides/);
  });

  it("an unreadable ruling70 block is a refusal by name (exit 2), never a regression judged without it", () => {
    const cat = fresh("cat-bad");
    writeFileSync(join(cat, "baseline.json"), JSON.stringify({ L3: `${BASELINE_DIR}/L3/results.json`, ruling70: { state: "works", ids: [] } }));
    const ids = [...RULING_70, control()];
    const code = judge(later(ids, {}), undefined, { catalogue: cat });
    expect(code).toBe(2);
    expect(said()).toMatch(/judge: BaselineUnreadable: .*ruling70/);
  });
});

// --- (d) through the real matrix:sample ------------------------------------------------------------------------------

describe("(d) matrix:sample, the real CLI with the real judge and the real baseline (the run alone is stood in)", () => {
  const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const ARGS = "--set pr-sample --rows swiss_knockout --workers 4";
  const bin = fresh("bin");
  // What a run of the sample would write: the baseline's own cases, restricted to the ids the sample planned (the expect file
  // run-sample wrote), under the run id it was given — except the ids a test flips, which go red.
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

  it("the sample rows plan all three ruling-70 ids and a control the ruling does not cover (anti-vacuity: a sample that plans none proves nothing)", () => {
    const p = planned();
    expect(RULING_70.filter((id) => p.includes(id))).toHaveLength(3);
    const held = p.filter((id) => stateOf(id) === "works" && !(RULING_70 as readonly string[]).includes(id));
    expect(held.length).toBeGreaterThan(0);
  });

  it("the two cells that WORKED in the committed run going red in a sample is no regression: exit 0 after ONE pass, and the judge says the override was live", () => {
    const flip = RULING_70.filter((id) => stateOf(id) === "works");
    expect(flip).toHaveLength(2);
    const s = sample(flip);
    expect(s.status, `${s.stderr}\n${s.stdout}`).toBe(0);
    expect(s.stdout).toMatch(/compared \d+ cases; 0 regressions/);
    expect(s.stdout).toMatch(/baseline overrides: 3 case\(s\) held red/);
    expect(`${s.stdout}${s.stderr}`, "no re-run pass").not.toMatch(/pass 2/);
    expect(`${s.stdout}${s.stderr}`, "one pass").toMatch(/pass 1: run exit 0/);
  }, spawnBudget(1, 4 * SPAWN_MS));

  it("a held case outside the ruling going red in a sample IS a regression: re-run once, reproduced, exit 1", () => {
    const ctl = planned().find((id) => stateOf(id) === "works" && !(RULING_70 as readonly string[]).includes(id))!;
    const s = sample([ctl]);
    expect(s.status, `${s.stderr}\n${s.stdout}`).toBe(1);
    expect(s.stdout).toContain(ctl);
    expect(s.stdout).toMatch(/1 regressions reproduced by the re-run/);
  }, spawnBudget(2, 4 * SPAWN_MS));
});
