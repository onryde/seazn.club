// The bench's report: a typed (zod) `report.json` that round-trips, plus a
// `report.md` renderer built from composable sections so later bench layers
// (B02+) can append their own section rather than editing these (design
// doc §10). B01 only defines and plumbs the SHAPE — per-suite fields beyond
// what `_tiny` can actually populate (believability metrics, oracle detail,
// provenance %, claims/officials/news outcomes, adaptations) stay typed but
// optional, filled in by later sessions.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const GateStatus = z.enum(["green", "red"]);
export type GateStatus = z.infer<typeof GateStatus>;

export const PhaseTimings = z.object({
  seedMs: z.number().optional(),
  scheduleMs: z.number().optional(),
  simMs: z.number().optional(),
});
export type PhaseTimings = z.infer<typeof PhaseTimings>;

/** Telemetry only — engine choice and solver status are report-only facts,
 *  never a gate (design doc §1: "correctness gates red; performance is
 *  reported, never gated"). `status` is left as a plain string rather than
 *  pinned to either of the two status vocabularies live in this system
 *  (the raw CP-SAT SolveStatus placement-client.ts speaks, vs. the app's
 *  higher-level ScheduleSolverInfo.status) — B01 only owns the shape. */
export const SolverResult = z.object({
  engine: z.enum(["optimized", "greedy"]).optional(),
  requestedEngine: z.enum(["optimized", "greedy", "both"]).optional(),
  status: z.string().optional(),
  wallMs: z.number().optional(),
});
export type SolverResult = z.infer<typeof SolverResult>;

export const OracleResult = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type OracleResult = z.infer<typeof OracleResult>;

export const SuiteReport = z.object({
  suite: z.string(),
  gate: GateStatus,
  timings: PhaseTimings,
  /** Whether `--keep`'s data was left in place (true) or `--wipe` was
   *  requested (false) — a run's own intent, so a reader of a committed
   *  report can tell what it left behind without re-reading the CLI
   *  invocation. B01's `_tiny` records this but does not itself act on
   *  `--wipe` (real teardown is B03's scope, per its own doc comment). */
  keep: z.boolean().optional(),
  solver: SolverResult.optional(),
  conflictCount: z.number().optional(),
  believabilityMetrics: z.record(z.string(), z.number()).optional(),
  oracles: z.array(OracleResult).optional(),
  provenancePct: z.number().optional(),
  claims: z.object({ total: z.number(), accepted: z.number() }).optional(),
  officials: z.object({ assigned: z.number(), conflicts: z.number() }).optional(),
  news: z.object({ drafted: z.number(), published: z.number() }).optional(),
  adaptations: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
});
export type SuiteReport = z.infer<typeof SuiteReport>;

export const RefusalSchema = z.object({ reason: z.string(), detail: z.string() });
export type RefusalSchema = z.infer<typeof RefusalSchema>;

export const PreflightReport = z.object({
  ok: z.boolean(),
  refusals: z.array(RefusalSchema),
  placement: z.object({ status: z.enum(["live", "absent"]), detail: z.string() }),
});
export type PreflightReport = z.infer<typeof PreflightReport>;

export const BenchReport = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  engine: z.enum(["optimized", "greedy", "both"]),
  base: z.string(),
  preflight: PreflightReport,
  suites: z.array(SuiteReport),
  gate: GateStatus,
});
export type BenchReport = z.infer<typeof BenchReport>;

/**
 * Run id: the explicit CLI arg wins, else the current git SHA — deliberately
 * NEVER `Date.now()`. Determinism: two invocations against the SAME commit
 * land in the same report directory rather than a fresh one every second.
 * Same discipline the engine boundary gate applies to `src/` for a related
 * but distinct reason (replay determinism); here it is report-directory
 * identity.
 */
export function resolveRunId(cliArg: string | undefined, gitSha: string): string {
  return cliArg && cliArg.length > 0 ? cliArg : gitSha;
}

/** Any gate red — a pre-flight refusal or any suite's own gate — reds the
 *  whole run. Timings and solver telemetry never factor in here. */
export function gateOf(report: Pick<BenchReport, "preflight" | "suites">): GateStatus {
  if (!report.preflight.ok) return "red";
  return report.suites.some((s) => s.gate === "red") ? "red" : "green";
}

export interface WrittenReport {
  dir: string;
  jsonPath: string;
  mdPath: string;
}

export async function writeReport(reportDir: string, report: BenchReport): Promise<WrittenReport> {
  // Validate before writing — a report that does not parse its own schema
  // must never reach disk silently malformed.
  const parsed = BenchReport.parse(report);
  const dir = path.join(reportDir, parsed.runId);
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, "report.json");
  const mdPath = path.join(dir, "report.md");
  await writeFile(jsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  await writeFile(mdPath, renderMarkdown(parsed), "utf8");
  return { dir, jsonPath, mdPath };
}

/* -------------------------------------------------------------------------
 * report.md rendering — one function per section, joined by renderMarkdown.
 * Later bench layers (B02+) are expected to append their own section
 * function to the list inside renderMarkdown rather than editing the
 * existing ones (design doc §10).
 * ---------------------------------------------------------------------- */

function renderHeader(report: BenchReport): string {
  const lines = [
    `# Scheduler bench — run \`${report.runId}\``,
    "",
    `- Gate: **${report.gate.toUpperCase()}**`,
    `- Engine: ${report.engine}`,
    `- Base: ${report.base}`,
    `- Started: ${report.startedAt}`,
  ];
  if (report.finishedAt) lines.push(`- Finished: ${report.finishedAt}`);
  return lines.join("\n");
}

function renderPreflightSection(report: BenchReport): string {
  const { preflight } = report;
  const lines = [
    "## Pre-flight",
    "",
    `- Result: ${preflight.ok ? "PASSED" : "REFUSED"}`,
    `- Placement: ${preflight.placement.status} — ${preflight.placement.detail}`,
  ];
  if (preflight.refusals.length > 0) {
    lines.push("", "Refusals:");
    for (const r of preflight.refusals) lines.push(`- \`${r.reason}\`: ${r.detail}`);
  }
  return lines.join("\n");
}

function renderSuitesSection(report: BenchReport): string {
  if (report.suites.length === 0) return "## Suites\n\n(none ran)";
  const lines = ["## Suites", ""];
  for (const suite of report.suites) {
    lines.push(`### ${suite.suite} — ${suite.gate.toUpperCase()}`, "");
    const t = suite.timings;
    const timingParts = [
      t.seedMs !== undefined ? `seed ${t.seedMs}ms` : undefined,
      t.scheduleMs !== undefined ? `schedule ${t.scheduleMs}ms` : undefined,
      t.simMs !== undefined ? `sim ${t.simMs}ms` : undefined,
    ].filter((part): part is string => part !== undefined);
    if (timingParts.length > 0) lines.push(`- Timings: ${timingParts.join(", ")}`);
    if (suite.keep !== undefined) lines.push(`- Data left in place: ${suite.keep ? "yes (--keep)" : "no (--wipe requested)"}`);
    if (suite.solver) {
      lines.push(
        `- Solver: requested=${suite.solver.requestedEngine ?? "n/a"}, actual=${suite.solver.engine ?? "n/a"}, status=${suite.solver.status ?? "n/a"}`,
      );
    }
    if (suite.conflictCount !== undefined) lines.push(`- Blocking conflicts: ${suite.conflictCount}`);
    if (suite.oracles && suite.oracles.length > 0) {
      lines.push("- Oracles:");
      for (const o of suite.oracles) lines.push(`  - ${o.passed ? "PASS" : "FAIL"} ${o.name}${o.detail ? ` — ${o.detail}` : ""}`);
    }
    if (suite.errors && suite.errors.length > 0) {
      lines.push("- Errors:");
      for (const e of suite.errors) lines.push(`  - ${e}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderMarkdown(report: BenchReport): string {
  const sections = [renderHeader(report), renderPreflightSection(report), renderSuitesSection(report)];
  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}
