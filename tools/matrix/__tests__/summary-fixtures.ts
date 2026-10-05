// Shared fixtures for the summary page's tests (summary.test.ts) and the merge step's tests (matrix-workflow.test.ts): ONE
// builder of a valid merged v3 run and of a judge verdict file, so the workflow test drives the real summary CLI over the
// same shapes the summary's own tests use (T9-HG). Every value is a plain literal; nothing here is derived from summary().
import { parseJudgeOut, type JudgeOut } from "../lib/judge.ts";
import { parseResults, type CaseResult, type Layer, type RunResults } from "../lib/results.ts";

type CaseSpec = Partial<Omit<CaseResult, "caseId">> & { caseId: string };
/** One case. L1 and L2 are browser runs at 1280, L3 is http (D9). */
export const kase = (layer: Layer, o: CaseSpec): CaseResult => ({
  row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, state: "works", reason: "", checks: [], counts: { calls: 0, fixtures: 0, events: 0 },
  durationMs: 1000, notes: [], layer, driver: layer === "L3" ? "http" : "browser", width: layer === "L3" ? null : 1280, ...o,
});
export const planned = (layer: Layer, caseId: string, scenario: string, state: "not_run" | "no_path" = "not_run"): CaseResult =>
  kase(layer, { caseId, scenario, state, planned: true, durationMs: 0, reason: state === "not_run" ? "no harness script for this atom" : "no path" });
/** A valid merged v3 run (parseResults vouches for the fixture). */
export const mergedRun = (layer: Layer, runId: string, cases: CaseResult[], extra: Record<string, unknown> = {}): RunResults =>
  parseResults({ schemaVersion: 3, runId, harnessCommit: "abc1234", startedAt: "2026-10-04T00:00:00Z", finishedAt: "2026-10-04T01:00:00Z", grid: { rows: ["league"], sports: ["generic"] }, layer, driver: layer === "L3" ? "http" : "browser", plan: `--layer ${layer}`, scope: `${layer} (grid)`, shards: 2, cases, ...extra }) as RunResults;
export const judgeOut = (o: Partial<JudgeOut>): JudgeOut => parseJudgeOut({ version: 1, mode: "across", exit: 0, layer: "L1", runs: ["ci-7-1-l1", "ci-8-1-l1", "ci-9-1-l1"], plannedNotRun: "allow", compared: 10, faults: [], differing: [], missing: [], regressed: [], absent: [], ...o });
export const ID = (l: Layer): string => `ci-9-1-${l.toLowerCase()}`;
export const threeOf = (l: Layer): string[] => [`ci-7-1-${l.toLowerCase()}`, `ci-8-1-${l.toLowerCase()}`, ID(l)];

export const baseCases = (l: Layer): CaseResult[] => [kase(l, { caseId: `c1-${l}` }), kase(l, { caseId: `c2-${l}`, durationMs: 2000 }), planned(l, `p1-${l}`, "A1")];
