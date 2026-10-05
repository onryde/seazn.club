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
// T21 review round 1 adds what keeps the override honest after the day it is written:
//   M2  the loader refuses any id set but the ruling's exact three AT RUNTIME (the real judge exits 2), not only in this file;
//   M1  the block is bound to the run it qualifies (workflow run, tag, tag commit): a re-baselined L3 refuses it, a baseline that is
//       not that run is judged as it shows, and a retirement guard fails once the committed baseline no longer shows the defect;
//   M7  the verdict line counts the ruling's cases IN THE SAMPLE, and says nothing when the sample holds none;
//   M8  the over-reach control is all six held swiss_knockout R4 cells outside the ruling, not one of them.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main as judgeMain } from "../judge.ts";
import { AUDIT_DIR, readAudit } from "../lib/audit-ledger.ts";
import { forceBaselineStates } from "../lib/judge.ts";
import { BaselineUnreadable, baselineL3Path, baselineOverrides, parseRows, planPrSample } from "../lib/pr-sample.ts";
import { LAYERS, parseResults } from "../lib/results.ts";
import { CATALOGUE_DIR, loadCatalogue, triage, type TriageRun } from "../lib/triage.ts";
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
/** The baseline run the block qualifies, typed from the progress record (T17): the third dispatch on the pinned tag. */
const WORKFLOW_RUN = 37346206686;
const TAG = "matrix-truth/w1d-baseline";
const TAG_SHA = "47f210e3f2094405e4ed4c8b5c9ea6bd2a6085d9";
/** The six swiss_knockout R4 sports that are works in all three dispatches, typed from HARNESS-GREEN.md's prose: the over-reach controls. */
const CONTROL_SPORTS = ["cricket", "volleyball", "badminton", "tabletennis", "tennis", "icehockey"] as const;

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

  it("the block is bound to the committed L3's own provenance: workflow run, tag and tag commit are the pinned ones, and the L3 is that run (T21 review M1)", () => {
    const o = baselineOverrides()!;
    expect({ workflowRun: o.workflowRun, tag: o.tag, tagCommit: o.tagCommit }).toEqual({ workflowRun: WORKFLOW_RUN, tag: TAG, tagCommit: TAG_SHA });
    expect(baseline.runId).toBe(`ci-${WORKFLOW_RUN}-1-l3`);
    expect(TAG_SHA.startsWith(baseline.harnessCommit as string), "the run's harnessCommit abbreviates the tag's commit").toBe(true);
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
  /** A good block: every row of the table below differs from it in ONE field, so a refusal is that field's. */
  const block = { note: "x", state: "red", cause: "P6", gap: "SW-H1", wave: "W3", workflowRun: WORKFLOW_RUN, tag: TAG, tagCommit: TAG_SHA, ids: [...RULING_70] };
  /** A held swiss_knockout R4 case outside the ruling: a 4th id a PR could add. */
  const fourth = (): string => baseline.cases.find((x) => x.caseId.startsWith("swiss_knockout|") && x.caseId.endsWith("|R4") && x.state === "works" && !(RULING_70 as readonly string[]).includes(x.caseId))!.caseId;

  it("no ruling70 key: no override, and the L3 path still resolves (a baseline with no ruling is an ordinary baseline)", () => {
    const cat = noRuling({});
    expect(baselineOverrides({ catalogue: cat })).toBeNull();
    expect(baselineL3Path({ catalogue: cat })).toBe(resolve(REPO, BASELINE_DIR, "L3", "results.json"));
  });

  it("a ruling70 block that is not the shape is refused by name, whichever field is wrong — never read as 'no override'", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["state works (an override can only force red)", { ...block, state: "works" }],
      ["no ids", { ...block, ids: [] }],
      ["an id twice (the three, one of them again)", { ...block, ids: [...RULING_70, RULING_70[0]] }],
      ["an id twice instead of the third", { ...block, ids: [RULING_70[0], RULING_70[0], RULING_70[1]] }],
      ["an empty id", { ...block, ids: [...RULING_70.slice(0, 2), ""] }],
      ["a 4th id, a held case outside the ruling (M2: refused at runtime, not only in this file)", { ...block, ids: [...RULING_70, fourth()] }],
      ["two of the three", { ...block, ids: RULING_70.slice(0, 2) }],
      ["one of the three", { ...block, ids: [RULING_70[0]] }],
      ["the third swapped for another held case", { ...block, ids: [...RULING_70.slice(0, 2), fourth()] }],
      ["no workflowRun", { ...block, workflowRun: undefined }],
      ["a workflowRun that is not a number", { ...block, workflowRun: "37346206686" }],
      ["no tag", { ...block, tag: "" }],
      ["a tagCommit that is not a full commit", { ...block, tagCommit: "47f210e" }],
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
    expect([...baselineOverrides({ catalogue: noRuling({ ruling70: block }) })!.ids].sort()).toEqual([...RULING_70].sort());
  });

  /** A copy of the committed L3 with a field of its provenance changed, and the catalogue that names it beside `block`. */
  const l3copy = (patch: Record<string, unknown>): string => {
    const f = join(fresh("l3"), "results.json");
    writeFileSync(f, JSON.stringify({ ...baseline, ...patch }));
    return f;
  };
  const catFor = (l3: string, ruling70: unknown): string => {
    const cat = fresh("cat");
    writeFileSync(join(cat, "baseline.json"), JSON.stringify({ L3: l3, ruling70 }));
    return cat;
  };

  it("the block refuses a baseline L3 it was not written for: a later workflow run, another layer's run id, another commit, or no provenance at all — never silently applied (T21 review M1)", () => {
    const rows: [string, Record<string, unknown>, RegExp][] = [
      ["the L3 was re-baselined (a later workflow run)", { runId: "ci-37400000000-1-l3" }, /written for workflow run 37346206686 \(tag matrix-truth\/w1d-baseline\)/],
      ["a run id of another layer", { runId: `ci-${WORKFLOW_RUN}-1-l1` }, /written for workflow run/],
      ["the L3 was run from another commit", { harnessCommit: "abcdef0" }, /names tag matrix-truth\/w1d-baseline at 47f210e3f/],
      ["the L3 carries no harnessCommit", { harnessCommit: undefined }, /carries no runId and harnessCommit/],
      ["the L3 carries no runId", { runId: undefined }, /carries no runId and harnessCommit/],
    ];
    let checked = 0;
    for (const [why, patch, msg] of rows) {
      const cat = catFor(l3copy(patch), block);
      expect(() => baselineOverrides({ catalogue: cat }), why).toThrow(BaselineUnreadable);
      expect(() => baselineOverrides({ catalogue: cat }), why).toThrow(msg);
      checked++;
    }
    expect(checked).toBe(rows.length);
    // The positive pair: an L3 that IS that run (a copy with nothing patched) is accepted, so each refusal above is its field's.
    expect(baselineOverrides({ catalogue: catFor(l3copy({}), block) })).not.toBeNull();
    // And a baseline with NO block never reads its L3's provenance at all (nothing to qualify).
    expect(baselineOverrides({ catalogue: catFor(l3copy({ runId: "whatever" }), undefined) })).toBeNull();
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
  const judge = (files: { now: string; expect: string }, jsonOut?: string, over?: { catalogue?: string }, baselineFile: string = baselineL3Path()): number =>
    judgeMain(["regression", "--baseline", baselineFile, "--now", files.now, "--expect", files.expect, ...(jsonOut === undefined ? [] : ["--json-out", jsonOut])], over);
  const reset = (): void => { out = []; err = []; };
  const allRed = Object.fromEntries(RULING_70.map((id) => [id, "red" as const]));
  /** The six held swiss_knockout R4 cells outside the ruling, by the sports HARNESS-GREEN.md names, each checked held in the committed baseline. */
  const controls = (): string[] => {
    const ids = CONTROL_SPORTS.map((sport) => {
      const c = baseline.cases.find((x) => x.caseId.startsWith(`swiss_knockout|${sport}|`) && x.caseId.endsWith("|R4"));
      expect(c, `swiss_knockout|${sport}|…|R4 is a case of the committed baseline`).toBeDefined();
      expect(c!.state, `${sport}: held (works) in the committed baseline`).toBe("works");
      return c!.caseId;
    });
    // Complete: the six ARE every held swiss_knockout R4 case the ruling does not name, so no seventh escapes the loop.
    const held = baseline.cases.filter((x) => x.caseId.startsWith("swiss_knockout|") && x.caseId.endsWith("|R4") && x.state === "works" && !(RULING_70 as readonly string[]).includes(x.caseId)).map((x) => x.caseId);
    expect(held.slice().sort()).toEqual(ids.slice().sort());
    expect(ids).toHaveLength(6);
    return ids;
  };
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

  it("the override does not over-reach: ALL SIX held swiss_knockout R4 cells outside the ruling going red ARE regressions, exit 1, each named, the ruling's three not (T21 review M8)", () => {
    const ctls = controls();
    const ids = [...RULING_70, ...ctls];
    const o = join(fresh("o"), "v.json");
    const code = judge(later(ids, { ...allRed, ...Object.fromEntries(ctls.map((id) => [id, "red" as const])) }), o);
    expect(code, said()).toBe(1);
    expect(verdict(o).regressed.map((r) => [r.caseId, r.was, r.now]).sort()).toEqual(ctls.map((id) => [id, "works", "red"]).sort());
    expect(verdict(o).compared).toBe(ids.length);
    // One at a time too: the six are six separate guards, not one that happens to cover them.
    let alone = 0;
    for (const ctl of ctls) {
      reset();
      const o1 = join(fresh("o"), "v.json");
      expect(judge(later([...RULING_70, ctl], { ...allRed, [ctl]: "red" }), o1), `${ctl}: ${said()}`).toBe(1);
      expect(verdict(o1).regressed.map((r) => r.caseId), ctl).toEqual([ctl]);
      alone++;
    }
    expect(alone).toBe(6);
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

  const goodBlock = { note: "x", state: "red", cause: "P6", gap: "SW-H1", wave: "W3", workflowRun: WORKFLOW_RUN, tag: TAG, tagCommit: TAG_SHA, ids: [...RULING_70] };
  const catWith = (ruling70: unknown, l3: string = baselineL3Path()): string => {
    const cat = fresh("cat-x");
    writeFileSync(join(cat, "baseline.json"), JSON.stringify({ L3: l3, ruling70 }));
    return cat;
  };

  it("M2: an id set other than the ruling's exact three is refused AT RUNTIME — the real judge exits 2 BaselineUnreadable, where a 4th held case would otherwise run masked (exit 0, 4 held red)", () => {
    const ctl = control();
    const rows: [string, string[]][] = [
      ["a 4th id (a held case outside the ruling)", [...RULING_70, ctl]],
      ["two of the three", RULING_70.slice(0, 2)],
      ["the third swapped for a held case", [...RULING_70.slice(0, 2), ctl]],
      ["one id twice", [...RULING_70, RULING_70[0]]],
    ];
    let checked = 0;
    for (const [why, list] of rows) {
      reset();
      // The later run flips the 4th case red: the masked outcome would be exit 0 with 0 regressions.
      const code = judge(later([...RULING_70, ctl], { ...allRed, [ctl]: "red" }), undefined, { catalogue: catWith({ ...goodBlock, ids: list }) });
      expect(code, `${why}: ${said()}`).toBe(2);
      expect(said(), why).toMatch(/judge: BaselineUnreadable: .*ruling70.*names exactly its 3 cases and no others/s);
      checked++;
    }
    expect(checked).toBe(rows.length);
    // The positive pair: the exact three, same later run, is judged — the control's flip is the one regression (not masked).
    reset();
    expect(judge(later([...RULING_70, ctl], { ...allRed, [ctl]: "red" }), undefined, { catalogue: catWith(goodBlock) }), said()).toBe(1);
  });

  it("M1: a re-baselined L3 refuses the block through the real judge (exit 2): the override cannot outlive the baseline it qualifies", () => {
    const cat = catWith(goodBlock, (() => { const f = join(fresh("l3"), "results.json"); writeFileSync(f, JSON.stringify({ ...baseline, runId: "ci-37400000000-1-l3" })); return f; })());
    const code = judge(later([...RULING_70, control()], {}), undefined, { catalogue: cat });
    expect(code, said()).toBe(2);
    expect(said()).toMatch(/judge: BaselineUnreadable: .*written for workflow run 37346206686 .*the SW-H1 fix removes ruling70 and re-baselines L3/s);
  });

  it("M1: handed a baseline that is not the run the list was written for, judge forces nothing (a regression stays one), and says so only when the sample holds a ruling case", () => {
    const other = join(fresh("other"), "results.json");
    writeFileSync(other, JSON.stringify({ ...baseline, runId: "ci-37400000000-1-l3" }));
    const carrom = RULING_70[1];
    // Not forced: carrom WORKED in this baseline, so carrom red now is a regression, exit 1 — with the real baseline it is no change, exit 0.
    reset();
    expect(judge(later([carrom], { [carrom]: "red" }), undefined, undefined, other), said()).toBe(1);
    expect(said()).toMatch(/baseline overrides: not applied — the baseline is ci-37400000000-1-l3 and owner ruling 70's list was written for workflow run 37346206686 \(tag matrix-truth\/w1d-baseline\); 1 of its case\(s\) are in this sample/);
    expect(said(), "no held-red line when nothing was held").not.toMatch(/case\(s\) held red/);
    reset();
    expect(judge(later([carrom], { [carrom]: "red" })), said()).toBe(0);
    // Silent when the sample holds none of the ruling's cases: the line would be noise.
    reset();
    expect(judge(later([control()], {}), undefined, undefined, other), said()).toBe(0);
    expect(said()).not.toMatch(/baseline overrides/);
  });

  it("M7: the 'baseline overrides' line counts the ruling's cases IN THIS SAMPLE — none planned prints no line, two planned says two, all three says three", () => {
    const [football, carrom, generic] = RULING_70;
    // None of the three planned: the override is live on the baseline but did nothing for this sample, so the verdict does not claim it.
    reset();
    expect(judge(later([control()], {}), undefined), said()).toBe(0);
    expect(said(), "a sample that plans none of the ruling's cases").not.toMatch(/baseline overrides/);
    // Two planned.
    reset();
    expect(judge(later([carrom, generic, control()], { [carrom]: "red", [generic]: "red" })), said()).toBe(0);
    expect(said()).toMatch(/baseline overrides: 2 case\(s\) held red \(cause P6, SW-H1, W3\)/);
    expect(said()).not.toMatch(/3 case\(s\) held red/);
    // One planned.
    reset();
    expect(judge(later([football, control()], { [football]: "red" })), said()).toBe(0);
    expect(said()).toMatch(/baseline overrides: 1 case\(s\) held red/);
    // All three planned (the counts above are the sample's, not a constant).
    reset();
    expect(judge(later([...RULING_70, control()], allRed)), said()).toBe(0);
    expect(said()).toMatch(/baseline overrides: 3 case\(s\) held red/);
  });
});

// --- retirement: the override lives only while the committed baseline still shows the defect -----------------------------

describe("retirement: ruling 70 is stale once the committed baseline no longer shows SW-H1 on its cells (T21 review M1)", () => {
  /** The override is stale when NONE of its cells is red in the baseline it qualifies. (Not "any works": two of the three WORK in the
   *  committed run — carrom and generic, by the draw's luck, which is the whole reason for the ruling.) */
  const stale = (states: readonly string[]): boolean => !states.includes("red");

  it("the staleness rule has teeth: all-works is stale, the committed pattern (a red among works) is not, and a red alone is not", () => {
    expect(stale(["works", "works", "works"])).toBe(true);
    expect(stale(["red", "works", "works"])).toBe(false);
    expect(stale(["works", "red", "works"])).toBe(false);
    expect(stale(["red", "red", "red"])).toBe(false);
  });

  it("at least one ruling cell is red in the committed baseline, and the committed triage keys each such red to the block's own gap and wave — else the override has nothing left to hold", () => {
    const o = baselineOverrides()!;
    const states = RULING_70.map(stateOf);
    expect(
      stale(states),
      "ruling 70 is STALE: none of its three cells is red in the committed baseline, so the SW-H1 fix (W3) has landed or the baseline's draw was lucky. "
      + "If the fix landed, remove `ruling70` from tools/matrix/catalogue/baseline.json and RULING_70_IDS from lib/pr-sample.ts TOGETHER with it, and re-baseline L3. "
      + "If SW-H1 is still open, re-run L3 until a ruling cell is red: the override is the only thing holding the cells that flip.",
    ).toBe(false);
    // Each red cell is keyed by the committed triage rules to the block's gap and wave: the block says what the triage says.
    const runs: TriageRun[] = LAYERS.map((l) => {
      const r = parseResults(JSON.parse(readFileSync(resolve(REPO, BASELINE_DIR, l, "results.json"), "utf8")));
      if (r.schemaVersion !== 3) throw new Error(`${l}: the committed baseline is a v3 run`);
      return { layer: l, runId: r.runId, plan: r.plan, cases: r.cases };
    });
    const cat = loadCatalogue(CATALOGUE_DIR);
    const audit = readAudit(AUDIT_DIR);
    const result = triage(runs, cat.rules, cat.routing, [...audit.gaps, ...audit.umbrellas].map((g) => ({ id: g.id })), cat.newGaps);
    let keyed = 0;
    for (const id of RULING_70.filter((x) => stateOf(x) === "red")) {
      const row = result.rows.find((x) => x.caseId === id);
      expect(row, `${id}: a red of the committed baseline is triaged`).toBeDefined();
      expect({ gap: row!.gap, wave: row!.wave }, id).toEqual({ gap: o.gap, wave: o.wave });
      keyed++;
    }
    expect(keyed, "the red ruling cells that were keyed").toBeGreaterThanOrEqual(1);
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

  it("the sample plans all six held swiss_knockout R4 cells outside the ruling (T21 review M8: the controls are planned, not assumed)", () => {
    const p = planned();
    const ctls = CONTROL_SPORTS.map((sport) => p.find((id) => id.startsWith(`swiss_knockout|${sport}|`) && id.endsWith("|R4")));
    expect(ctls.filter((x) => x === undefined)).toEqual([]);
    expect(ctls.every((id) => stateOf(id!) === "works")).toBe(true);
    expect(ctls).toHaveLength(6);
  });

  it("held cases outside the ruling going red in a sample ARE regressions — all six of them: re-run once, reproduced, exit 1, each named", () => {
    const p = planned();
    const ctls = CONTROL_SPORTS.map((sport) => p.find((id) => id.startsWith(`swiss_knockout|${sport}|`) && id.endsWith("|R4"))!);
    const s = sample([...ctls, ...RULING_70]);
    expect(s.status, `${s.stderr}\n${s.stdout}`).toBe(1);
    for (const ctl of ctls) expect(s.stdout, ctl).toContain(ctl);
    expect(s.stdout).toMatch(/6 regressions reproduced by the re-run/);
    // The ruling's three, flipped in the same sample, are not among the regressions.
    for (const id of RULING_70) expect(s.stdout.split("regressions reproduced by the re-run")[1] ?? "", id).not.toContain(id);
  }, spawnBudget(2, 4 * SPAWN_MS));
});
