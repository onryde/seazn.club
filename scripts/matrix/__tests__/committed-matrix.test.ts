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
import { API_ONLY_ROWS, SPORT_KEYS } from "../lib/catalogue.ts";
import { decideState, parseResults, stringsIn, type CaseResultV2 } from "../lib/results.ts";
import { L2_WIDTHS } from "../lib/widths.ts";
import { loopbackLiteralsIn } from "./loopback-literals.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRUTH_RUNS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs";
/** Every committed slice: its wave and its directory under truth-runs. */
const SLICES = [["W1a", "w1a-slice"], ["W1b", "w1b-slice"]] as const;

/** The states decideState makes WITHOUT reading checks: a planned 🚫/░ (run.ts
 *  recordPlanned) and a ⏳ deferral. W1c Task 12's N-3 gives such a row no
 *  check of its own, so there is nothing to re-decide it from. */
const UNDECIDED_FROM_CHECKS: ReadonlySet<string> = new Set(["no_path", "not_run", "later"]);
/** W1c Task 14, carry 3: re-decide every case from its own checks. A 🚫/░/⏳
 *  row with no check, or an error red with no check, is SKIPPED and counted;
 *  a 🚫/░/⏳ row that DOES carry a check is reported, never skipped — N-3 says
 *  it may not, and skipping it would hide a verdict nothing re-decides. The
 *  caller pins how many were checked: zero checked is a failure, not a pass. */
function reDecide(cases: readonly CaseResultV2[]): { checked: number; skipped: number; wrong: string[] } {
  let checked = 0;
  let skipped = 0;
  const wrong: string[] = [];
  for (const c of cases) {
    if (UNDECIDED_FROM_CHECKS.has(c.state)) {
      if (c.checks.length > 0) wrong.push(`${c.caseId}: ${c.state} carries ${c.checks.length} check(s) — a planned or deferred row carries none (N-3)`);
      else skipped++;
      continue;
    }
    if (c.state === "red" && c.reason.startsWith("error: ") && c.checks.length === 0) {
      skipped++;
      continue;
    }
    checked++;
    const d = decideState({ checks: c.checks, deferred: null, error: null });
    if (d.state !== c.state || d.reason !== c.reason) wrong.push(`${c.caseId}: stored ${c.state} "${c.reason}", checks decide ${d.state} "${d.reason}"`);
  }
  return { checked, skipped, wrong };
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
  it("the listing is git's: an untracked file under truth-runs is never committed evidence, a tracked one always is", () => {
    const listed = new Set(tracked);
    const untracked = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", TRUTH_RUNS], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== "");
    expect(untracked.filter((f) => listed.has(f))).toEqual([]);
    expect(tracked.filter((f) => !existsSync(resolve(REPO, f))), "tracked but missing from the tree").toEqual([]);
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

/** W1c Task 14's committed runs, each with the case count its plan declares. */
const W1C_RUNS: readonly (readonly [string, number])[] = [
  // The slice over HTTP: 6 cells × LIFECYCLE, M1, R4, F1.
  ["w1c-http-slice", 24],
  // L1: the 6 slice cells at 1280 (ruling 39), three runs (class 8).
  ...[1, 2, 3].map((n) => [`w1c-l1/w1c-l1-r${n}`, 6] as const),
  // Plan D5: the committed L2 rotation on the slice cells — 3 executed, 7 🚫, 58 ░.
  ["w1c-l2", 3 + 7 + 58],
  // The API-only set: one case per API-only row.
  ["w1c-api-only", API_ONLY_ROWS.length],
  // The knockout width sweep: one case at each L2 width.
  ...L2_WIDTHS.map((w) => [`w1c-sweep-ko/w1c-sweep-ko-${w}`, 1] as const),
  // Pad proof (plan D1, D3): one case per sport, at 1280 and at 320, three runs each —
  // plus 1280 r4, the fresh-id rerun after r3's cricket red under a machine-load spike.
  ...([["1280", [1, 2, 3, 4]], ["320", [1, 2, 3]]] as const).flatMap(([w, ns]) => ns.map((n) => [`w1c-padproof/w1c-pp-${w}-r${n}`, SPORT_KEYS.length] as const)),
];

describe("every committed results.json is what decideState makes of its checks (W1c Task 14, carry 3)", () => {
  const files = trackedUnder(TRUTH_RUNS).filter((f) => f.endsWith("/results.json"));
  it("the re-decision has teeth: a planned row is skipped; a planned row with a check, a flipped verdict and a stale reason are caught", () => {
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
    ];
    const r = reDecide(probe);
    expect(r.skipped).toBe(2);
    expect(r.checked).toBe(3);
    expect(r.wrong.map((w) => w.split(":")[0])).toEqual(["planned-with-check", "flipped", "stale-reason"]);
  });
  it("every W1c run the plan declares is committed, with the case count its plan declares", () => {
    const missing: string[] = [];
    for (const [dir, n] of W1C_RUNS) {
      const f = `${TRUTH_RUNS}/${dir}/results.json`;
      if (!files.includes(f)) { missing.push(f); continue; }
      const cases = parseResults(JSON.parse(readFileSync(resolve(REPO, f), "utf8"))).cases;
      expect(cases.length, dir).toBe(n);
      expect(new Set(cases.map((c) => c.caseId)).size, `${dir}: distinct case ids`).toBe(n);
    }
    expect(missing).toEqual([]);
    expect(W1C_RUNS.length).toBe(1 + 3 + 1 + 1 + L2_WIDTHS.length + 7);
  });
  it("every case of every committed run is re-decided from its checks, and the sweep judged something", () => {
    let checked = 0;
    let skipped = 0;
    const wrong: string[] = [];
    for (const f of files) {
      const r = reDecide(parseResults(JSON.parse(readFileSync(resolve(REPO, f), "utf8"))).cases);
      checked += r.checked;
      skipped += r.skipped;
      wrong.push(...r.wrong.map((w) => `${f}: ${w}`));
    }
    console.info(`committed-matrix: ${files.length} results.json, ${checked} case(s) re-decided, ${skipped} planned/deferred/error case(s) skipped`);
    expect(wrong).toEqual([]);
    // Anti-vacuity: the W1a/W1b files plus every W1c run above, and at least
    // the planned rows W1c declares (D5's 7 + 58 on L2, the API-only set).
    expect(files.length).toBeGreaterThanOrEqual(3 + W1C_RUNS.length);
    expect(skipped).toBeGreaterThanOrEqual(7 + 58 + API_ONLY_ROWS.length);
    // …and at least every case the plans say was EXECUTED: the two 24-case
    // slices, the HTTP slice, L1 ×3, L2's 3, the sweep, pad proof ×7.
    expect(checked).toBeGreaterThanOrEqual(2 * 24 + 24 + 3 * 6 + 3 + L2_WIDTHS.length + 7 * SPORT_KEYS.length);
  });
});
