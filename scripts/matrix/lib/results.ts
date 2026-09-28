// One JSON result per case (R10: MATRIX.md is rendered from this and nothing
// else). decideState is the ONLY place a case becomes green, and it refuses
// every vacuous shape (R13, R25).
//
// This module is the one authority for `CheckResult` and `Verdict`: observed.ts
// re-exports them as types and invariants.ts imports them as types.
//
// PF4: a red whose reason starts `error:` is a product/driver error (a
// finding), never vacuity. Only decideState's error branch writes that prefix;
// the vacuous reasons say "vacuous" and never start with it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findSecrets } from "./redact.ts";

export const CASE_STATES = ["works", "refused", "red", "later", "needs_ruling", "no_path", "not_run"] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const GLYPH: Readonly<Record<CaseState, string>> = Object.freeze({
  works: "✅", refused: "⛔", red: "❌", later: "⏳", needs_ruling: "⬜", no_path: "🚫", not_run: "░",
});

export type Verdict = "pass" | "fail" | "abstain";

export interface CheckResult {
  id: string;
  kind: "invariant" | "assertion";
  verdict: Verdict;
  checked: number;
  reason: string;
  evidence: string[];
}

export interface CaseResult {
  caseId: string;
  row: string;
  sport: string;
  variant: string;
  scenario: string;
  canary: boolean;
  state: CaseState;
  reason: string;
  checks: CheckResult[];
  counts: { calls: number; fixtures: number; events: number };
  durationMs: number;
}

export interface RunResults {
  schemaVersion: 1;
  runId: string;
  harnessCommit: string;
  startedAt: string;
  finishedAt: string;
  cases: CaseResult[];
}

const CheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["invariant", "assertion"]),
  verdict: z.enum(["pass", "fail", "abstain"]),
  checked: z.number().int().nonnegative(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

const CaseSchema = z.strictObject({
  caseId: z.string().min(1),
  row: z.string().min(1),
  sport: z.string().min(1),
  variant: z.string().min(1),
  scenario: z.string().min(1),
  canary: z.boolean(),
  state: z.enum(CASE_STATES),
  reason: z.string(),
  checks: z.array(CheckSchema),
  counts: z.strictObject({ calls: z.number().int().nonnegative(), fixtures: z.number().int().nonnegative(), events: z.number().int().nonnegative() }),
  durationMs: z.number().nonnegative(),
});

export const RunResultsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  harnessCommit: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  cases: z.array(CaseSchema),
});

export function parseResults(json: unknown): RunResults {
  return RunResultsSchema.parse(json) as RunResults;
}

export interface DecideInput {
  checks: readonly CheckResult[];
  deferred: { wave: string; reason: string } | null;
  error: string | null;
}

export function decideState(input: DecideInput): { state: CaseState; reason: string } {
  if (input.error !== null) return { state: "red", reason: `error: ${input.error}` };
  if (input.deferred !== null) return { state: "later", reason: `${input.deferred.wave}: ${input.deferred.reason}` };
  if (input.checks.length === 0) return { state: "red", reason: "no checks ran (vacuous)" };
  const failed = input.checks.filter((c) => c.verdict === "fail");
  if (failed.length > 0) return { state: "red", reason: failed.map((c) => `${c.id}: ${c.reason}`).join("; ") };
  const applied = input.checks.filter((c) => c.verdict !== "abstain");
  if (applied.length === 0) return { state: "red", reason: "every check abstained (vacuous)" };
  const empty = applied.filter((c) => c.checked === 0);
  if (empty.length > 0) return { state: "red", reason: `checked zero items (vacuous): ${empty.map((c) => c.id).join(", ")}` };
  return { state: "works", reason: `${applied.length} checks, ${applied.reduce((n, c) => n + c.checked, 0)} items` };
}

export class SecretInResults extends Error {
  constructor(count: number) {
    // The count only — never the matched text (R14a: the message is printed).
    super(`results: refusing to write — ${count} secret-shaped string(s) survived redaction (R14a)`);
    this.name = "SecretInResults";
  }
}

export function writeResults(dir: string, results: RunResults): string {
  const body = `${JSON.stringify(RunResultsSchema.parse(results), null, 2)}\n`;
  const hits = findSecrets(body);
  if (hits.length > 0) throw new SecretInResults(hits.length);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "results.json");
  writeFileSync(path, body);
  return path;
}
