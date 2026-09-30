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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findSecrets } from "../lib/redact.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import { decideState, parseResults, stringsIn, type CaseResultV2 } from "../lib/results.ts";
import { L2_WIDTHS } from "../lib/widths.ts";
import { API_ONLY_BROWSER_SET, WIDTH_SWEEP_SET, apiOnlyBrowserPlanner, l1Planner, l2Planner, layerCaseId, widthSweepPlanner, type LayerCase } from "../lib/layers.ts";
import { PAD_PROOF_SET, padProofPlanner } from "../lib/pad-proof-set.ts";
import { PROBE_SET, probePlanner } from "../lib/probe-set.ts";
import { planCanaryCase, planSliceCases } from "../lib/slice.ts";
import { loopbackLiteralsIn } from "./loopback-literals.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRUTH_RUNS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs";
/** Every committed slice: its wave and its directory under truth-runs. */
const SLICES = [["W1a", "w1a-slice"], ["W1b", "w1b-slice"]] as const;

/** How one committed case is judged. `checked`: re-decided from its checks
 *  (a refused case with its mandate, rebuilt from its reason). `errored`: an
 *  error red — decideState makes it from the error alone, whatever checks it
 *  kept (run.ts M-2 keeps a browser case's checks), so it is re-decided with
 *  that error, rebuilt from its `error: ` reason. `planned`: 🚫/░, and
 *  `deferred`: ⏳ — decideState makes both WITHOUT reading checks, and N-3
 *  gives such a row none, so a row that carries one is reported. Whether a
 *  planned/deferred case SHOULD be one is its plan's question (judgeRun). */
type CaseKind = "checked" | "errored" | "planned" | "deferred";
function judgeCase(c: CaseResultV2): { kind: CaseKind; wrong: string | null } {
  const differs = (d: { state: string; reason: string }): string | null =>
    d.state === c.state && d.reason === c.reason ? null : `${c.caseId}: stored ${c.state} "${c.reason}", checks decide ${d.state} "${d.reason}"`;
  if (c.state === "no_path" || c.state === "not_run" || c.state === "later") {
    const kind: CaseKind = c.state === "later" ? "deferred" : "planned";
    return { kind, wrong: c.checks.length > 0 ? `${c.caseId}: ${c.state} carries ${c.checks.length} check(s) — a planned or deferred row carries none (N-3)` : null };
  }
  if (c.state === "red" && c.reason.startsWith("error: ")) {
    return { kind: "errored", wrong: differs(decideState({ checks: c.checks, deferred: null, error: c.reason.slice("error: ".length) })) };
  }
  return { kind: "checked", wrong: differs(decideState({ checks: c.checks, deferred: null, error: null, mandated: c.state === "refused" ? c.reason : null })) };
}
/** W1c Task 14, carry 3: every case re-decided or skipped by kind, counted.
 *  The caller pins the counts: zero checked is a failure, not a pass. */
function reDecide(cases: readonly CaseResultV2[]): { checked: number; skipped: number; wrong: string[] } {
  const judged = cases.map(judgeCase);
  return {
    checked: judged.filter((j) => j.kind === "checked").length,
    skipped: judged.filter((j) => j.kind !== "checked").length,
    wrong: judged.flatMap((j) => (j.wrong === null ? [] : [j.wrong])),
  };
}

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
/** Every file git tracks (index included, so a staged file counts) under a
 *  committed root, relative to the repo. W1c Task 14: this read the FILESYSTEM
 *  before, so a local sweep also read every untracked run left on the disk
 *  (~3800 shot PNGs from Tasks 7–11, which the Task 7 ruling keeps untracked)
 *  and timed out — committed evidence is what the repo holds. Stage new
 *  evidence before running this sweep over it. */
const trackedUnder = (root: string): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", root], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== "");
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

/** A plan's cases, keyed without the variant (the DB's builder default, which
 *  the planner reads live) and, for a plain run, without the run's one width. */
interface ExpectedPlan {
  readonly plan: string;
  readonly layered: boolean;
  readonly driven: ReadonlySet<string>;
  readonly planned: ReadonlyMap<string, { readonly state: "no_path" | "not_run"; readonly reason: string }>;
}
const noVariant = (caseId: string): string => caseId.split("|").filter((_, i) => i !== 2).join("|");
const noWidth = (caseId: string): string => caseId.replace(/@\d+$/, "");
/** Variant-free keys: every planner is handed the sport as its own variant, and the key drops it. */
const anyVariant = (sport: string): string => sport;

function fromLayered(plan: string, cases: readonly LayerCase[]): ExpectedPlan {
  const driven = new Set<string>();
  const planned = new Map<string, { state: "no_path" | "not_run"; reason: string }>();
  for (const c of cases) {
    const key = noVariant(layerCaseId(c));
    if (c.spec !== null) { driven.add(key); continue; }
    // The stored reason is what decideState makes of the planner's own 🚫/░ (run.ts recordPlanned).
    const d = decideState({ checks: [], deferred: null, error: null, noPath: c.noPath, notRun: c.notRun });
    planned.set(key, { state: d.state as "no_path" | "not_run", reason: d.reason });
  }
  return { plan, layered: true, driven, planned };
}
const fromSpecs = (plan: string, ids: readonly string[]): ExpectedPlan =>
  ({ plan, layered: false, driven: new Set(ids.map(noVariant)), planned: new Map() });

/** The plan a recorded `plan` string names, built by the runner's own planners. */
function expectedPlan(plan: string): ExpectedPlan {
  const words = plan.split(" ");
  const flag = (name: string): string | undefined => { const i = words.indexOf(name); return i < 0 ? undefined : words[i + 1]; };
  const filters = { only: flag("--only"), scenario: flag("--scenario") };
  if (words[0] === "--set") {
    const set = words[1];
    if (set === PAD_PROOF_SET) return fromSpecs(plan, padProofPlanner({}).plan(anyVariant).map((c) => c.caseId));
    if (set === PROBE_SET) return fromSpecs(plan, probePlanner({}).plan(anyVariant).map((c) => c.caseId));
    if (set === API_ONLY_BROWSER_SET) return fromLayered(plan, apiOnlyBrowserPlanner({}).layered(anyVariant));
    if (set === WIDTH_SWEEP_SET) return fromLayered(plan, widthSweepPlanner({}).layered(anyVariant));
  }
  if (words[0] === "--canary" && words[1] !== undefined) return fromSpecs(plan, [planCanaryCase(anyVariant, words[1]).caseId]);
  if (words[0] === "--layer" && words[1] === "L1") return fromLayered(plan, l1Planner(filters).layered(anyVariant));
  if (words[0] === "--layer" && words[1] === "L2") return fromLayered(plan, l2Planner(filters).layered(anyVariant));
  if (words[0] === "slice") return fromSpecs(plan, planSliceCases(anyVariant, filters).map((c) => c.caseId));
  throw new Error(`committed-matrix: no planner for the recorded plan "${plan}"`);
}

/** One run judged against its plan, case by case: a case the plan PLANS is
 *  stored as exactly the plan's 🚫/░ (state and reason) with no check; a case
 *  the plan DRIVES is never stored as planned (class 6); no case is missing,
 *  repeated or outside the plan; a plain run is one width. The counts are the
 *  plan's by construction: `driven` + `planned` = the run's cases. */
function judgeRun(cases: readonly CaseResultV2[], plan: ExpectedPlan): { driven: number; planned: number; wrong: string[] } {
  const keyOf = (id: string): string => (plan.layered ? noVariant(id) : noWidth(noVariant(id)));
  const wrong: string[] = [];
  const seen = new Set<string>();
  let driven = 0;
  let planned = 0;
  for (const c of cases) {
    const key = keyOf(c.caseId);
    const j = judgeCase(c);
    if (j.wrong !== null) wrong.push(j.wrong);
    if (seen.has(key)) wrong.push(`${c.caseId}: repeated in the run`);
    seen.add(key);
    const p = plan.planned.get(key);
    if (p !== undefined) {
      planned++;
      if (c.state !== p.state || c.reason !== p.reason) wrong.push(`${c.caseId}: the plan records ${p.state} "${p.reason}", stored ${c.state} "${c.reason}"`);
    } else if (plan.driven.has(key)) {
      driven++;
      if (j.kind === "planned") wrong.push(`${c.caseId}: the plan DRIVES this case, stored ${c.state} with ${c.checks.length} check(s) — a driven result recorded as planned (class 6)`);
    } else {
      wrong.push(`${c.caseId}: not in its plan (${plan.plan})`);
    }
  }
  for (const k of [...plan.driven, ...plan.planned.keys()]) if (!seen.has(k)) wrong.push(`${k}: planned by ${plan.plan}, missing from the run`);
  if (!plan.layered && new Set(cases.map((c) => c.caseId.match(/@\d+$/)?.[0] ?? "")).size > 1) wrong.push(`${plan.plan}: a plain run holds more than one width`);
  return { driven, planned, wrong };
}

/** The results.json files committed at W1c Task 14's close (fix round 1): a sweep that judges fewer lost some. */
const RESULTS_FLOOR = 33;
/** The committed runs written before results.json recorded its plan (carry 6,
 *  3c36ea1b3), each named with the plan its command line ran. Any other run
 *  with no recorded plan is refused, never skipped. */
const PLAN_BEFORE_CARRY_6: Readonly<Record<string, string>> = Object.freeze({
  "w1a-slice": "slice",
  "w1b-slice": "slice",
  "w1b-probe": `--set ${PROBE_SET}`,
  // Task 8's walkthrough: one cell × LIFECYCLE per run, at 1280, 320 (×3) and over HTTP.
  ...Object.fromEntries(["1280-f", "320a", "320b", "320c", "http-f"].flatMap((w) =>
    ["generic", "badminton"].map((sport) => [`w1c-walkthrough-a/w1c-wa-${w}-${sport}`, `slice --only league|${sport} --scenario LIFECYCLE`]))),
});

/** The plan a committed run is judged against: the one it recorded, or the
 *  one it is named with from before carry 6 — never both, never neither. */
function planFor(dir: string, recorded: string | undefined): string | { refused: string } {
  const named = PLAN_BEFORE_CARRY_6[dir];
  if (recorded !== undefined && named !== undefined) return { refused: `${dir}: records "${recorded}" AND is named "${named}" before carry 6` };
  return recorded ?? named ?? { refused: `${dir}: no recorded plan, and not named as a run from before carry 6` };
}

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
    const plan = expectedPlan("--layer L2");
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
  it("every committed results.json is exactly its plan: each driven case re-decided, each planned row the plan's own", () => {
    const files = trackedUnder(TRUTH_RUNS).filter((f) => f.endsWith("/results.json"));
    const wrong: string[] = [];
    let driven = 0;
    let planned = 0;
    for (const f of files) {
      const dir = f.slice(TRUTH_RUNS.length + 1, -"/results.json".length);
      const results = parseResults(JSON.parse(readFileSync(resolve(REPO, f), "utf8")));
      const plan = planFor(dir, "plan" in results && typeof results.plan === "string" ? results.plan : undefined);
      if (typeof plan !== "string") { wrong.push(plan.refused); continue; }
      const r = judgeRun(results.cases, expectedPlan(plan));
      wrong.push(...r.wrong.map((w) => `${dir}: ${w}`));
      driven += r.driven;
      planned += r.planned;
    }
    console.info(`committed-matrix: ${files.length} results.json judged against their plans — ${driven} driven case(s), ${planned} planned 🚫/░ row(s)`);
    expect(wrong).toEqual([]);
    // Anti-vacuity: no run lost, and both kinds were judged.
    expect(files.length).toBeGreaterThanOrEqual(RESULTS_FLOOR);
    expect(Object.keys(PLAN_BEFORE_CARRY_6).every((d) => files.includes(`${TRUTH_RUNS}/${d}/results.json`)), "a run named before carry 6 is no longer committed").toBe(true);
    expect(driven).toBeGreaterThan(0);
    expect(planned).toBeGreaterThan(0);
  });
});
