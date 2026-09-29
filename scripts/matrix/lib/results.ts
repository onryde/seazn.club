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
//
// D9 (W1c Task 3): schema v3 records, per case, the layer that ran it, the
// driver and the browser width (null over HTTP), and per run its layer and
// driver. parseResults reads v2 (the committed W1a/W1b evidence) and v3;
// writeResults writes v3 only. The browser widths are the harness's declared
// set — 1280 (ruling 39) and pairs.ts's L2_WIDTHS — so this module loads
// pairs.ts (and through it the catalogue) for that one constant; it never
// reads the catalogue's rows or sports.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { L2_WIDTHS } from "./pairs.ts";
import { baseScrubber, findSecrets, mapStrings } from "./redact.ts";

export const LAYERS = ["L1", "L2", "L3"] as const;
export type Layer = (typeof LAYERS)[number];
export const DRIVER_KINDS = ["http", "browser"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

/** Every width a browser case may run at: 1280 first (ruling 39: L1 runs
 *  there), then L2's seven in their own order. Task 4's viewports read it. */
export const BROWSER_WIDTHS = Object.freeze([1280, ...L2_WIDTHS] as const);
export type BrowserWidth = (typeof BROWSER_WIDTHS)[number];

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

/** A v2 case: the committed W1a/W1b evidence. Every case a run writes now is a
 *  v3 `CaseResult`. */
export interface CaseResultV2 {
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
  /** m-5: the scenario's notes, redacted and capped (run.ts). */
  notes: string[];
}

/** A v3 case (D9): the v2 fields, plus the layer that ran it, its driver and
 *  its browser width — null over HTTP, one of BROWSER_WIDTHS in a browser. */
export interface CaseResult extends CaseResultV2 {
  layer: Layer;
  driver: DriverKind;
  width: number | null;
}

/** The catalogue grid AS IT WAS when the run was made (T11 review M4, final
 *  review m-7): MATRIX.md's rows and columns come from here, never from the
 *  live catalogue, so a later catalogue edit cannot change how committed
 *  evidence renders. */
export interface Grid {
  rows: string[];
  sports: string[];
}

export interface RunResultsV2 {
  /** 2: cases carry `notes` (final review m-5) and the run carries its `grid`. */
  schemaVersion: 2;
  runId: string;
  harnessCommit: string;
  startedAt: string;
  finishedAt: string;
  grid: Grid;
  cases: CaseResultV2[];
}

export interface RunResults {
  /** 3 (D9): the run carries its layer and driver; each case its layer, driver and width. */
  schemaVersion: 3;
  runId: string;
  harnessCommit: string;
  startedAt: string;
  finishedAt: string;
  grid: Grid;
  layer: Layer;
  driver: DriverKind;
  cases: CaseResult[];
}

/** What parseResults reads: committed v2 evidence, or a v3 run. */
export type AnyRunResults = RunResultsV2 | RunResults;

const CheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["invariant", "assertion"]),
  verdict: z.enum(["pass", "fail", "abstain"]),
  checked: z.number().int().nonnegative(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

const caseFieldsV2 = {
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
  notes: z.array(z.string()),
};

const CaseSchemaV2 = z.strictObject(caseFieldsV2);

const BROWSER_WIDTH_SET: ReadonlySet<number> = new Set(BROWSER_WIDTHS);

/** D9: http ⇒ width null; browser ⇒ width is one of BROWSER_WIDTHS. */
const CaseSchemaV3 = z.strictObject({
  ...caseFieldsV2,
  layer: z.enum(LAYERS),
  driver: z.enum(DRIVER_KINDS),
  width: z.number().int().nullable(),
}).superRefine((c, ctx) => {
  if (c.driver === "http" && c.width !== null) {
    ctx.addIssue({ code: "custom", path: ["width"], message: `case ${c.caseId}: an http case carries width null, got ${c.width}` });
  }
  if (c.driver === "browser" && (c.width === null || !BROWSER_WIDTH_SET.has(c.width))) {
    ctx.addIssue({ code: "custom", path: ["width"], message: `case ${c.caseId}: a browser case runs at one of ${BROWSER_WIDTHS.join(", ")}, got ${c.width}` });
  }
});

/** Non-empty, and no key twice: a repeated key would render a row or column twice. */
const gridKeys = (what: string) => z.array(z.string().min(1)).min(1).refine((k) => new Set(k).size === k.length, `grid ${what} repeat a key`);

const runFieldsV2 = {
  runId: z.string().min(1),
  harnessCommit: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  grid: z.strictObject({ rows: gridKeys("rows"), sports: gridKeys("sports") }),
};

/** The committed W1a/W1b evidence, unchanged. */
export const RunResultsSchemaV2 = z.strictObject({ schemaVersion: z.literal(2), ...runFieldsV2, cases: z.array(CaseSchemaV2) });

export const RunResultsSchemaV3 = z.strictObject({
  schemaVersion: z.literal(3),
  ...runFieldsV2,
  layer: z.enum(LAYERS),
  driver: z.enum(DRIVER_KINDS),
  cases: z.array(CaseSchemaV3),
});

/** Discriminated on schemaVersion, so a refused file is judged by its OWN
 *  version's schema: a v3 case's bad width is reported as that, never drowned
 *  by the v2 branch refusing keys it has never heard of. */
const AnyRunResultsSchema = z.discriminatedUnion("schemaVersion", [RunResultsSchemaV3, RunResultsSchemaV2]);

export function parseResults(json: unknown): AnyRunResults {
  return AnyRunResultsSchema.parse(json);
}

export interface DecideInput {
  checks: readonly CheckResult[];
  deferred: { wave: string; reason: string } | null;
  error: string | null;
  /** ⛔ (ruling 24): the scenario's own expected state is a refusal. It turns
   *  what would be `works` into `refused`, carrying this reason, and nothing
   *  else: every red, vacuous or not, and every deferral still wins. */
  mandated?: string | null;
  /** 🚫 (W1c Task 3): the cell has no path in this layer; `wave` owes one.
   *  Loses to an error and a deferral; beats every check and the mandate. */
  noPath?: { wave: string; reason: string } | null;
  /** ░ (W1c Task 3): planned, never run (no scenario script yet). Same rank
   *  as noPath, below it. Never set together with noPath. */
  notRun?: string | null;
}

export function decideState(input: DecideInput): { state: CaseState; reason: string } {
  // A planner bug, refused whatever else is set: an error or a deferral must
  // not launder it into a red or a ⏳.
  if (input.noPath != null && input.notRun != null) throw new Error("decideState: noPath and notRun both set");
  if (input.error !== null) return { state: "red", reason: `error: ${input.error}` };
  if (input.deferred !== null) return { state: "later", reason: `${input.deferred.wave}: ${input.deferred.reason}` };
  if (input.noPath != null) return { state: "no_path", reason: `${input.noPath.wave}: ${input.noPath.reason}` };
  if (input.notRun != null) return { state: "not_run", reason: input.notRun };
  if (input.checks.length === 0) return { state: "red", reason: "no checks ran (vacuous)" };
  const failed = input.checks.filter((c) => c.verdict === "fail");
  if (failed.length > 0) return { state: "red", reason: failed.map((c) => `${c.id}: ${c.reason}`).join("; ") };
  const applied = input.checks.filter((c) => c.verdict !== "abstain");
  if (applied.length === 0) return { state: "red", reason: "every check abstained (vacuous)" };
  const empty = applied.filter((c) => c.checked === 0);
  if (empty.length > 0) return { state: "red", reason: `checked zero items (vacuous): ${empty.map((c) => c.id).join(", ")}` };
  if (input.mandated != null) return { state: "refused", reason: input.mandated };
  return { state: "works", reason: `${applied.length} checks, ${applied.reduce((n, c) => n + c.checked, 0)} items` };
}

export class SecretInResults extends Error {
  constructor(count: number) {
    // The count only — never the matched text (R14a: the message is printed).
    super(`results: refusing to write — ${count} secret-shaped string(s) survived redaction (R14a)`);
    this.name = "SecretInResults";
  }
}

/** Every string value in the results, RAW. The secret scan reads these, never
 *  the JSON body: JSON.stringify turns a newline into `\` + `n`, which erases
 *  the \b in front of a JWT / `sk_` / `dl_` / `postgres://`, so a secret at the
 *  start of a line passed a body scan and was written (review I1). Keys need no
 *  scan: the strict schema fixes every one of them. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  // Arrays included: Object.values of an array is its elements.
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** Writes results.json, v3 only (D9): the secret scan over the RAW strings
 *  first, then the run's own base as LOCAL_BASE (final batch FB-1: never the other way round —
 *  a credential whose userinfo starts with the base loses its shape once
 *  scrubbed, and would be laundered). Answers the path and exactly what it
 *  wrote, so MATRIX.md renders the committed text, not a second scrub of it. */
export function writeResults(dir: string, results: RunResults, base: string): { path: string; written: RunResults } {
  const scrub = baseScrubber(base);
  const parsed: RunResults = RunResultsSchemaV3.parse(results);
  const hits = stringsIn(parsed).flatMap((s) => findSecrets(s));
  if (hits.length > 0) throw new SecretInResults(hits.length);
  const written = mapStrings(parsed, scrub);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "results.json");
  writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
  return { path, written };
}
