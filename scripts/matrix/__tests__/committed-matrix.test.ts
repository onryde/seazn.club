// R10: the committed slice evidence — W1a's, and W1b's (T15 fix round 3,
// M-8: the same shape, the same checks) — is internally consistent and clean.
//  - MATRIX.md is byte-for-byte the render of results.json. The render reads
//    results.json alone (its own `grid` included, never the live catalogue),
//    so this reds only when the evidence or the renderer changed.
//  - Every case's state and reason are what decideState makes of its own
//    checks, so a hand-flipped verdict cannot hide behind an unchanged render
//    (the render drops per-check verdicts and evidence).
//  - 24 distinct cases, no canary, a clean harness commit, no secret-shaped
//    string anywhere (the repo is public; writeResults guarded only the write).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findSecrets } from "../lib/redact.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import { decideState, parseResults, stringsIn, type CaseResultV2 } from "../lib/results.ts";
import { L2_WIDTHS } from "../lib/widths.ts";
import { LOCK_PATH, PLAN_BEFORE_CARRY_6, REPO, TRUTH_RUNS, committedRuns, freeze, judgeRun, noVariant, planFor, readLock, reDecide, sweepCommitted, thawed, trackedUnder } from "./committed-plans.ts";
import { loopbackLiteralsIn } from "./loopback-literals.ts";

/** Every committed slice: its wave and its directory under truth-runs. */
const SLICES = [["W1a", "w1a-slice"], ["W1b", "w1b-slice"]] as const;


describe.each(SLICES)("committed %s slice evidence", (_wave, slice) => {
  const DIR = resolve(REPO, TRUTH_RUNS, slice);
  const RERENDER = `pnpm matrix:render ${TRUTH_RUNS}/${slice}/results.json --out ${TRUTH_RUNS}/${slice}/MATRIX.md`;
  const raw: unknown = JSON.parse(readFileSync(resolve(DIR, "results.json"), "utf8"));
  const results = parseResults(raw);
  it("is the full slice, not an empty or partial run: 24 DISTINCT cases, no canary", () => {
    expect(results.cases.length).toBe(24);
    expect(new Set(results.cases.map((c) => c.caseId)).size).toBe(24);
    expect(results.cases.some((c) => c.canary)).toBe(false);
  });
  it("MATRIX.md is exactly the render of results.json", () => {
    // Final review m-7: the only repair for a red here is a re-render of the
    // committed results.json — never a new run, never an edit of MATRIX.md.
    expect(readFileSync(resolve(DIR, "MATRIX.md"), "utf8"), `MATRIX.md is not the render of results.json. Re-render it: ${RERENDER}`).toBe(renderMatrix(results));
  });
  it("every case's state and reason are what decideState makes of its own checks", () => {
    const { checked, wrong } = reDecide(results.cases);
    expect(wrong).toEqual([]);
    // A slice is 24 works: every one of them is re-decided, none skipped.
    expect(checked).toBe(24);
  });
  it("names a clean harness commit (final review m-6): evidence from an edited tree is not committed", () => {
    expect(results.harnessCommit).toMatch(/^[0-9a-f]{7,40}$/);
  });
  it("holds no secret-shaped string in any raw string value (R14a)", () => {
    const strings = stringsIn(raw);
    expect(strings.length).toBeGreaterThan(24);
    expect(strings.flatMap((s) => findSecrets(s))).toEqual([]);
  });
});

// T15 fix round 3, M-7, then final batch FB-1 and F-3: the repo is public.
// Every committed evidence file — slices, model reports, probes written by
// hand scripts no writer ever scanned — and every committed catalogue file
// holds no secret-shaped string and names no local server. The loopback
// oracle is a literal list (loopback-literals.ts), independent of the
// scrubber the writers use: judged by its own regex, the sweep shared its
// blind spots ([::1], 0.0.0.0, 127.0.1.1).
const CATALOGUE = "scripts/matrix/catalogue";
/** A committed screenshot: bytes, not text, so the text sweeps below cannot read it. */
const isPicture = (f: string): boolean => f.endsWith(".png");
/** The directories under truth-runs at W1c Task 14's close; each must still contribute a file. */
const EVIDENCE_DIRS = [
  "w1a-slice", "w1b-abandon", "w1b-cricket-001", "w1b-model", "w1b-model-final", "w1b-model-fr1", "w1b-model-fr2", "w1b-probe", "w1b-slice", "w1b-tie-ko", "w1b-withdraw-boardgame",
  "w1c-walkthrough-a", "w1c-http-slice", "w1c-l1", "w1c-l2", "w1c-api-only", "w1c-sweep-ko", "w1c-padproof",
];
/** The files at W1c Task 14's close: a sweep that reads fewer lost some (review R-m7 — `checked === files.length` alone is a tautology). */
const EVIDENCE_FLOOR = 100;
const CATALOGUE_FLOOR = 7;
/** The pictures Task 8 committed (c609f9cd4), plus Task 14's three finding
 *  crops (N-1 at 1280 and 768, N-4 at 375): a picture sweep that sees fewer lost some. */
const PICTURE_FLOOR = 10;

/** Files inside a run's shots/ directory (a path segment, not a substring). */
const shotsIn = (files: readonly string[]): string[] => files.filter((f) => f.split("/").includes("shots"));
/** The evidence run directory a committed file belongs to: truth-runs/<dir>/…. */
const runDirOf = (f: string): string => f.slice(TRUTH_RUNS.length + 1).split("/")[0]!;
/** Pictures no Markdown file in their own run directory names. Task 8's ruling:
 *  only a screen that carries a FINDING is committed, and a finding cites its
 *  picture — so an uncited picture is either stray or a finding left unwritten. */
function uncitedPictures(pictures: readonly string[], markdownOf: (dir: string) => readonly string[]): string[] {
  return pictures.filter((p) => !markdownOf(runDirOf(p)).some((md) => md.includes(p.split("/").at(-1)!)));
}

describe("committed evidence and catalogue, every file (FB-1, F-3)", () => {
  const tracked = trackedUnder(TRUTH_RUNS);
  const pictures = tracked.filter(isPicture);
  const evidence = tracked.filter((f) => !isPicture(f));
  const catalogue = trackedUnder(CATALOGUE);
  const all = [...evidence, ...catalogue];
  it("discovery: every evidence directory still contributes, and neither root shrank", () => {
    const dirs = new Set(evidence.map(runDirOf));
    expect(EVIDENCE_DIRS.filter((d) => !dirs.has(d)), "an evidence directory vanished").toEqual([]);
    expect(evidence.length).toBeGreaterThanOrEqual(EVIDENCE_FLOOR);
    expect(catalogue.length).toBeGreaterThanOrEqual(CATALOGUE_FLOOR);
    expect(pictures.length).toBeGreaterThanOrEqual(PICTURE_FLOOR);
  });
  it("the listing is git's: every tracked file is on the tree, and no run's shots/ directory is committed", () => {
    // Review m-2: git's index and `--others` are disjoint by construction, so
    // the old "untracked ∩ tracked = ∅" could not fail. What CAN go wrong is
    // a run's whole shots/ directory committed (the Task 7/8 ruling commits
    // finding crops only, under evidence/), or a tracked file gone from disk.
    const probe = [`${TRUTH_RUNS}/run-a/shots/case-1/08-pad.png`, `${TRUTH_RUNS}/run-a/evidence/N-1.png`, `${TRUTH_RUNS}/run-a/screenshots.md`];
    expect(shotsIn(probe), "the oracle has teeth").toEqual([probe[0]]);
    expect(shotsIn(tracked), "a committed shots/ file: commit finding crops only").toEqual([]);
    // Final review m-13: ~3800 run shots sit untracked in a worktree, so git ignores every run's shots/ — a stray
    // `git add` cannot stage them — and never a finding crop under evidence/.
    const ignored = (f: string): boolean => spawnSync("git", ["check-ignore", "-q", "--no-index", "--", f], { cwd: REPO }).status === 0;
    expect(probe.map(ignored), "shots/ ignored at any depth; evidence/ and Markdown tracked").toEqual([true, false, false]);
    expect(ignored(`${TRUTH_RUNS}/w1c-padproof/w1c-pp-320-r1/shots/case-3/08-pad-scored.png`)).toBe(true);
    expect(tracked.filter((f) => !existsSync(resolve(REPO, f))), "tracked but missing from the tree").toEqual([]);
    expect(tracked.length).toBeGreaterThanOrEqual(EVIDENCE_FLOOR + PICTURE_FLOOR);
  });
  it("every committed MATRIX.md is the render of its results.json (review m-5), walkthrough-a exempt by name", () => {
    // Walkthrough A (Task 8, c609f9cd4) was rendered before carry 5 gave the
    // MATRIX header its layer / driver / plan line; it is history, not re-rendered.
    const EXEMPT = "w1c-walkthrough-a";
    const matrices = tracked.filter((f) => f.endsWith("/MATRIX.md") && runDirOf(f) !== EXEMPT);
    const stale = matrices.filter((m) => readFileSync(resolve(REPO, m), "utf8") !== renderMatrix(parseResults(JSON.parse(readFileSync(resolve(REPO, m.replace(/MATRIX\.md$/, "results.json")), "utf8")))));
    expect(stale, "re-render with pnpm matrix:render <results.json> --out <MATRIX.md>").toEqual([]);
    // Every other committed results.json has its render beside it, and the sweep read them all.
    const results = tracked.filter((f) => f.endsWith("/results.json") && runDirOf(f) !== EXEMPT);
    expect(results.filter((f) => !matrices.includes(f.replace(/results\.json$/, "MATRIX.md")))).toEqual([]);
    expect(matrices.length).toBe(results.length);
    expect(results.length).toBeGreaterThanOrEqual(W1C_RUNS.length);
  });
  it("every committed picture is finding evidence: named by a Markdown file in its own run directory (Task 8 ruling)", () => {
    const markdownOf = (dir: string) => tracked.filter((f) => runDirOf(f) === dir && f.endsWith(".md")).map((f) => readFileSync(resolve(REPO, f), "utf8"));
    // The oracle has teeth: a picture its run's Markdown does not name is caught, a named one is not.
    const probe = [`${TRUTH_RUNS}/run-a/evidence/cited.png`, `${TRUTH_RUNS}/run-a/evidence/stray.png`, `${TRUTH_RUNS}/run-b/evidence/cited.png`];
    expect(uncitedPictures(probe, (d) => (d === "run-a" ? ["| F-1 | `evidence/cited.png` |"] : []))).toEqual([probe[1], probe[2]]);
    expect(uncitedPictures(pictures, markdownOf)).toEqual([]);
    console.info(`committed-matrix: ${pictures.length} committed picture(s), each cited by its run's Markdown`);
  });
  it("the oracle has teeth: it sees every local spelling a run could print, and not the placeholder", () => {
    const seen = ["http://localhost:3313", "ECONNREFUSED 127.0.0.1:5433", "127.0.1.1", "http://[::1]:3313", "connect ::1:3313", "0.0.0.0:3313", "http://mbp.local:3313", "mbp.local/x"];
    expect(seen.filter((t) => loopbackLiteralsIn(t).length === 0)).toEqual([]);
    expect(loopbackLiteralsIn("[local-base]/api/v1/x")).toEqual([]);
  });
  it("names no local server in any file — by a literal list, not the scrubber's regex", () => {
    let checked = 0;
    const hits: string[] = [];
    for (const f of all) {
      for (const h of loopbackLiteralsIn(readFileSync(resolve(REPO, f), "utf8"))) hits.push(`${f}: ${h}`);
      checked++;
    }
    expect(hits).toEqual([]);
    expect(checked, "files read").toBe(all.length);
    expect(checked).toBeGreaterThanOrEqual(EVIDENCE_FLOOR + CATALOGUE_FLOOR);
  });
  it("holds no secret-shaped string: every raw JSON string value, every Markdown line (R14a)", () => {
    let files = 0;
    let strings = 0;
    const hits: string[] = [];
    for (const f of all) {
      const text = readFileSync(resolve(REPO, f), "utf8");
      // Raw values, never the JSON body: escaping erases the \b a secret
      // pattern needs (redact.ts header, review I1).
      const items = f.endsWith(".json") ? stringsIn(JSON.parse(text)) : f.endsWith(".md") ? text.split("\n") : null;
      expect(items, `${f}: a committed file this sweep cannot read`).not.toBeNull();
      for (const s of items ?? []) for (const h of findSecrets(s)) hits.push(`${f}: ${h.slice(0, 12)}…`);
      strings += items?.length ?? 0;
      files++;
    }
    expect(hits).toEqual([]);
    expect(files).toBe(all.length);
    expect(files).toBeGreaterThanOrEqual(EVIDENCE_FLOOR + CATALOGUE_FLOOR);
    expect(strings, "strings scanned").toBeGreaterThan(files);
  });
});

describe("the committed slices", () => {
  it("are distinct runs, each swept above", () => {
    const ids = SLICES.map(([, slice]) => parseResults(JSON.parse(readFileSync(resolve(REPO, TRUTH_RUNS, slice, "results.json"), "utf8"))).runId);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size, ids.join(", ")).toBe(ids.length);
  });
});

/** The run directories W1c Task 14 committed (its brief's Steps 1–8): each
 *  must still be committed. Their case counts and splits are their PLANS'
 *  (judged below), never typed here. */
const W1C_RUNS: readonly string[] = [
  "w1c-http-slice",
  ...[1, 2, 3].map((n) => `w1c-l1/w1c-l1-r${n}`),
  "w1c-l2",
  "w1c-api-only",
  ...L2_WIDTHS.map((w) => `w1c-sweep-ko/w1c-sweep-ko-${w}`),
  ...([["1280", [1, 2, 3, 4]], ["320", [1, 2, 3]]] as const).flatMap(([w, ns]) => ns.map((n) => `w1c-padproof/w1c-pp-${w}-r${n}`)),
];

describe("every committed results.json is what decideState makes of its checks (W1c Task 14, carry 3)", () => {
  it("the re-decision has teeth: planned and error rows are skipped by kind; a planned row with a check, a flipped verdict and a stale reason are caught", () => {
    const pass = (id: string) => ({ id, kind: "invariant" as const, verdict: "pass" as const, checked: 2, reason: "ok", evidence: [] });
    const base = { row: "league", sport: "generic", variant: "score", scenario: "X", canary: false, counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0, notes: [] };
    const probe: CaseResultV2[] = [
      { ...base, caseId: "planned", state: "no_path", reason: "W4: none", checks: [] },
      { ...base, caseId: "unscripted", state: "not_run", reason: "no scenario script yet", checks: [] },
      { ...base, caseId: "planned-with-check", state: "no_path", reason: "W4: none", checks: [pass("a")] },
      { ...base, caseId: "flipped", state: "works", reason: "1 checks, 2 items", checks: [{ ...pass("a"), verdict: "fail", reason: "bad" }] },
      // Same state, stale reason: a count the checks no longer add up to.
      { ...base, caseId: "stale-reason", state: "works", reason: "9 checks, 99 items", checks: [pass("a")] },
      { ...base, caseId: "honest", state: "works", reason: "1 checks, 2 items", checks: [pass("a")] },
      // Review m-4: an error red that KEPT its checks (run.ts M-2), and a mandated ⛔ — neither is a false red.
      { ...base, caseId: "error-with-checks", state: "red", reason: "error: TimeoutError: page closed", checks: [pass("a")] },
      { ...base, caseId: "refused-clean", state: "refused", reason: "denied by the plan", checks: [pass("a")] },
    ];
    const r = reDecide(probe);
    expect(r.wrong.map((w) => w.split(":")[0])).toEqual(["planned-with-check", "flipped", "stale-reason"]);
    expect([r.checked, r.skipped]).toEqual([4, 4]);
  });
  it("every run W1c Task 14 committed is still committed", () => {
    const files = new Set(trackedUnder(TRUTH_RUNS));
    expect(W1C_RUNS.filter((d) => !files.has(`${TRUTH_RUNS}/${d}/results.json`))).toEqual([]);
    expect(new Set(W1C_RUNS).size).toBe(W1C_RUNS.length);
  });
});

// W1c Task 14 fix round 1, review I-1: a run is judged against ITS OWN PLAN,
// case by case. The plan comes from the planner the run's recorded `plan`
// names (carry 6), never from the results under test — so a DRIVEN case
// stored as ░/🚫 with its checks lost (class 6: absent = suppressed) is caught,
// where a state-only skip and a `skipped >=` floor both waved it through.

/** The results.json files committed at W1c Task 14's close (fix round 1): a sweep that judges fewer lost some. */
const RESULTS_FLOOR = 33;

describe("each committed run, judged against its own plan (W1c Task 14 fix round 1, review I-1)", () => {
  it("a run is judged against the plan it recorded or is named with — never both, never neither", () => {
    expect(planFor("w1c-l2", "--layer L2")).toBe("--layer L2");
    expect(planFor("w1a-slice", undefined)).toBe("slice");
    expect(planFor("w1a-slice", "slice")).toEqual({ refused: expect.stringContaining("AND is named") });
    expect(planFor("w1d-new-run", undefined)).toEqual({ refused: expect.stringContaining("no recorded plan") });
  });
  const l2 = `${TRUTH_RUNS}/w1c-l2/results.json`;
  it("a driven case stored as planned, a planned row with another reason, a lost, a stray and a repeated case are each caught", () => {
    const cases = parseResults(JSON.parse(readFileSync(resolve(REPO, l2), "utf8"))).cases;
    const plan = thawed(readLock().runs["w1c-l2"]!);
    // The honest committed run is clean, and it is the plan's split exactly.
    const honest = judgeRun(cases, plan);
    expect(honest.wrong).toEqual([]);
    expect([honest.driven, honest.planned]).toEqual([plan.driven.size, plan.planned.size]);
    // Class 6: R4a@375 was DRIVEN; stored as ░ with its checks lost it must red.
    const driven = cases.find((c) => noVariant(c.caseId) === "swiss|badminton|R4a@375");
    expect(driven, "the probe's driven case is in the committed run").toBeDefined();
    const flipped = cases.map((c) => (c === driven ? { ...c, state: "not_run" as const, reason: "no scenario script yet (atom R4a)", checks: [] } : c));
    expect(judgeRun(flipped, plan).wrong.join("\n")).toContain("swiss|badminton|bwf|R4a@375");
    // A planned row stored with another row's reason, a lost case, and a case no plan holds.
    const plannedCase = cases.find((c) => c.state === "no_path")!;
    const reworded = cases.map((c) => (c === plannedCase ? { ...c, reason: "W9: another wave" } : c));
    expect(judgeRun(reworded, plan).wrong.join("\n")).toContain(`${plannedCase.caseId}: the plan records no_path`);
    expect(judgeRun(cases.filter((c) => c !== driven), plan).wrong.join("\n")).toContain("swiss|badminton|R4a@375: planned by --layer L2, missing");
    expect(judgeRun([...cases, { ...driven!, caseId: "ladder|badminton|bwf|R4a@375" }], plan).wrong.join("\n")).toContain("ladder|badminton|bwf|R4a@375: not in its plan");
    expect(judgeRun([...cases, driven!], plan).wrong.join("\n")).toContain("swiss|badminton|bwf|R4a@375: repeated in the run");
  });
  it("every committed run has its frozen plan (plans.lock.json), and every frozen plan names a committed run (final review I-1)", () => {
    const lock = readLock();
    const runs = committedRuns();
    const frozen = Object.keys(lock.runs);
    // A run the lock does not hold is refused with the entry its commit must add, built from today's planners.
    const missing = runs.filter((r) => !(r.dir in lock.runs)).map((r) => `${r.dir}: no frozen plan in ${LOCK_PATH} — add ${typeof r.plan === "string" ? JSON.stringify({ [r.dir]: freeze(r.plan) }) : r.plan.refused}`);
    expect(missing).toEqual([]);
    expect(frozen.filter((d) => !runs.some((r) => r.dir === d)), "a frozen plan whose run is no longer committed").toEqual([]);
    expect(runs.filter((r) => lock.runs[r.dir]!.plan !== r.plan).map((r) => `${r.dir}: ran ${JSON.stringify(r.plan)}, frozen as "${lock.runs[r.dir]!.plan}"`)).toEqual([]);
    expect(frozen.length).toBe(runs.length);
    expect(runs.length).toBeGreaterThanOrEqual(RESULTS_FLOOR);
  });
  it("every committed results.json is exactly its FROZEN plan: each driven case re-decided, each planned row the plan's own", () => {
    const files = trackedUnder(TRUTH_RUNS).filter((f) => f.endsWith("/results.json"));
    const { runs, driven, planned, wrong } = sweepCommitted();
    console.info(`committed-matrix: ${runs} results.json judged against their frozen plans — ${driven} driven case(s), ${planned} planned 🚫/░ row(s)`);
    expect(wrong).toEqual([]);
    // Anti-vacuity: no run lost, and every case the lock freezes was judged — the counts are the lock's, not the results'.
    const lock = Object.values(readLock().runs);
    expect(runs).toBe(files.length);
    expect(files.length).toBeGreaterThanOrEqual(RESULTS_FLOOR);
    expect(Object.keys(PLAN_BEFORE_CARRY_6).every((d) => files.includes(`${TRUTH_RUNS}/${d}/results.json`)), "a run named before carry 6 is no longer committed").toBe(true);
    expect(driven).toBe(lock.reduce((n, e) => n + e.driven.length, 0));
    expect(planned).toBe(lock.reduce((n, e) => n + Object.keys(e.planned).length, 0));
    expect(driven).toBeGreaterThan(0);
    expect(planned).toBeGreaterThan(0);
  });
  it("a driven case stored ⏳/🚫 in recordPlanned's shape, or with fixtures/events counted, reds; a real runtime ⏳/🚫 on a driven case does not (final review I-2)", () => {
    const dir = "w1c-l1/w1c-l1-r1";
    const cases = parseResults(JSON.parse(readFileSync(resolve(REPO, TRUTH_RUNS, dir, "results.json"), "utf8"))).cases;
    const plan = thawed(readLock().runs[dir]!);
    expect(judgeRun(cases, plan).wrong).toEqual([]);
    const target = cases[0]!;
    expect(plan.driven.has(noVariant(target.caseId)), "the probe's case is one the plan drives").toBe(true);
    expect(target.durationMs, "the committed case really ran").toBeGreaterThan(0);
    const unrun = { checks: [], durationMs: 0, counts: { calls: 0, fixtures: 0, events: 0 }, notes: [] };
    // A runtime ⏳/🚫 comes only from runCase's catch: counts start at 0/0/0, fixtures and events are set only
    // after scenario.run returns, and the catch updates calls alone (run.ts runCase). So an honest one counts
    // calls and time, never fixtures or events (re-review I-2: this witness used to keep the target's 28/56).
    const ran = { checks: [], durationMs: target.durationMs, counts: { calls: Math.max(1, target.counts.calls), fixtures: 0, events: 0 } };
    const deferred = decideState({ checks: [], deferred: { wave: "W1d", reason: "no pad adapter" }, error: null });
    const noPath = decideState({ checks: [], deferred: null, error: null, noPath: { wave: "W1d", reason: "no organiser control" } });
    const notRun = decideState({ checks: [], deferred: null, error: null, notRun: "no scenario script yet (atom LIFECYCLE)" });
    const judged = (patch: Partial<CaseResultV2>) => judgeRun(cases.map((c) => (c === target ? { ...c, ...patch } : c)), plan).wrong;
    const CLASS_6 = "a driven result recorded as planned (class 6)";
    // Only recordPlanned writes a case with no time spent and nothing counted: on a driven case that shape is a lost result.
    expect(judged({ ...unrun, state: "later", reason: deferred.reason }).join("\n")).toContain(CLASS_6);
    expect(judged({ ...unrun, state: "no_path", reason: noPath.reason }).join("\n")).toContain(CLASS_6);
    // not_run is written by recordPlanned alone, whatever the counts say.
    expect(judged({ ...ran, state: "not_run", reason: notRun.reason }).join("\n")).toContain(CLASS_6);
    // A driven case that spent time and ended ⏳ or 🚫 at runtime (run.ts: ScenarioUnsupported, NoOrganiserPath) is honest.
    expect(judged({ ...ran, state: "later", reason: deferred.reason })).toEqual([]);
    expect(judged({ ...ran, state: "no_path", reason: noPath.reason })).toEqual([]);
    // Re-review I-2, the final review's own probe: the driven case flipped to ⏳/🚫 with its checks dropped, its
    // duration and its counts KEPT. The runner cannot write that shape, so it reds.
    expect(target.counts.fixtures + target.counts.events, "the probe's case counted fixtures or events").toBeGreaterThan(0);
    const kept = { checks: [], durationMs: target.durationMs, counts: target.counts };
    const COUNTED = "a runtime ⏳/🚫 counts neither";
    expect(judged({ ...kept, state: "later", reason: deferred.reason }).join("\n")).toContain(COUNTED);
    expect(judged({ ...kept, state: "no_path", reason: noPath.reason }).join("\n")).toContain(COUNTED);
    // Either count alone is the tell.
    expect(judged({ ...ran, counts: { ...ran.counts, fixtures: 1 }, state: "later", reason: deferred.reason }).join("\n")).toContain(COUNTED);
    expect(judged({ ...ran, counts: { ...ran.counts, events: 1 }, state: "no_path", reason: noPath.reason }).join("\n")).toContain(COUNTED);
    // A browser case can reach its 🚫 before the driver counts a call (NoOrganiserPath at the first control): the time it spent is the tell.
    expect(judged({ ...unrun, durationMs: target.durationMs, state: "no_path", reason: noPath.reason })).toEqual([]);
    expect([deferred.state, noPath.state, notRun.state]).toEqual(["later", "no_path", "not_run"]);
  });
});
