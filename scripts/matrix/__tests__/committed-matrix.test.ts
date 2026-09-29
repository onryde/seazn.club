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
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findLocalBases, findSecrets } from "../lib/redact.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import { decideState, parseResults, stringsIn } from "../lib/results.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRUTH_RUNS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs";
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
    const mismatched = results.cases.flatMap((c) => {
      // An error red or a ⏳ deferral carries no checks of its own to decide from.
      if ((c.state === "red" && c.reason.startsWith("error: ") && c.checks.length === 0) || c.state === "later") return [];
      const d = decideState({ checks: c.checks, deferred: null, error: null });
      return d.state === c.state && d.reason === c.reason ? [] : [`${c.caseId}: stored ${c.state} "${c.reason}", checks decide ${d.state} "${d.reason}"`];
    });
    expect(mismatched).toEqual([]);
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

// T15 fix round 3, M-7: the repo is public, and a run's evidence named the
// local server it drove. Every committed evidence file — slices, model
// reports, probes — holds no loopback origin; the writers emit LOCAL_BASE.
describe("committed truth-run evidence, every file", () => {
  const ROOT = resolve(REPO, TRUTH_RUNS);
  const files = readdirSync(ROOT, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  it("names no loopback origin (localhost, 127.0.0.1) in any file", () => {
    let checked = 0;
    const hits: string[] = [];
    for (const f of files) {
      for (const h of findLocalBases(readFileSync(f, "utf8"))) hits.push(`${f.slice(ROOT.length + 1)}: ${h}`);
      checked++;
    }
    expect(hits).toEqual([]);
    expect(checked, "no evidence file read — the sweep would be vacuous").toBeGreaterThan(0);
    expect(checked).toBe(files.length);
  });
});

describe("the committed slices", () => {
  it("are distinct runs, each swept above", () => {
    const ids = SLICES.map(([, slice]) => parseResults(JSON.parse(readFileSync(resolve(REPO, TRUTH_RUNS, slice, "results.json"), "utf8"))).runId);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size, ids.join(", ")).toBe(ids.length);
  });
});
