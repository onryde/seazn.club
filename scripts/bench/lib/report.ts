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
import { SUITE_13_KEY, type CliEntryFlag } from "./register.ts";

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

/**
 * design §5.3 / §7: an unexpected 4xx/5xx or failed UI step attaches its
 * response body, and (browser-driver only) a screenshot + Playwright trace.
 * The http driver never produces `screenshotPath`/`tracePath` — both stay
 * absent for an http-driver failure, present only when a browser drove it.
 */
export const FailureArtefact = z.object({
  detail: z.string(),
  responseBody: z.string().optional(),
  screenshotPath: z.string().optional(),
  tracePath: z.string().optional(),
});
export type FailureArtefact = z.infer<typeof FailureArtefact>;

/**
 * design §7: "Per registration division: entries / entrants / waitlisted /
 * rejected (eligibility vs manual) / paid cents / funnel wall-time / pad
 * wall-time." This file only shapes and renders the row — a caller
 * (bench.ts, out of B03r task 8's scope) populates it from `register.ts`'s
 * real `FunnelResult` (`entrants`, `waitlisted`, `paidCents`,
 * `organiserForceEligibilityProven`) plus its own tally of
 * `classifyFunnelOutcome`'s `"rejected_eligibility"` vs `"rejected_manual"`
 * outcomes — `FunnelResult` itself carries no such split, only findings.
 */
export const RegistrationDivisionReport = z.object({
  divisionRef: z.string(),
  /** The pack's own declared entry count for this division — NOT derivable
   *  by summing the other columns (a withdrawn/expired entry, outside
   *  B03r's four-value `expect` vocabulary, is neither). */
  entries: z.number().int().nonnegative(),
  entrants: z.number().int().nonnegative(),
  waitlisted: z.number().int().nonnegative(),
  /** Eligibility and manual rejections are DIFFERENT outcomes (B03r task 8
   *  brief) — never collapsed into one "rejected" count. */
  rejectedEligibility: z.number().int().nonnegative(),
  rejectedManual: z.number().int().nonnegative(),
  /** Sourced from each entry's OWN `registrations.amount_cents` /
   *  `payment_intent_id` (`register.ts`'s `FunnelResult.paidCents`, FP6-
   *  corrected) — NEVER a `registration_groups` submit-time snapshot. */
  paidCents: z.number().int().nonnegative(),
  /**
   * Mirrors `register.ts`'s `FunnelResult.organiserForceEligibilityProven`
   * verbatim (C2: `gateRosterEligibility` is reachable only from entrant
   * creation / fixture generation — B04 territory, not this session's
   * organiser actions). Permanently `false` today. A report rendering this
   * field MUST say so visibly — see `ORGANISER_FORCE_UNPROVEN_NOTE` below —
   * never omit it and never let it read as a pass.
   */
  organiserForceEligibilityProven: z.boolean(),
  /** Report-only measurements — NEVER gated (load-sensitive-timing rule,
   *  `_RULES.md` §1 / design §5.3). No threshold, no colour, no verdict. */
  funnelWallMs: z.number().optional(),
  padWallMs: z.number().optional(),
  failures: z.array(FailureArtefact).optional(),
});
export type RegistrationDivisionReport = z.infer<typeof RegistrationDivisionReport>;

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
  /**
   * Non-fatal findings the run is REQUIRED to surface, and never a gate.
   *
   * A SEPARATE FIELD from `errors`, structurally, because the two are decided
   * by a severity field rather than by a caller remembering to filter: stage 0
   * says what it did NOT derive offline (`leaderboards.not_derived`,
   * `champions.not_derived`, `suspensions.not_derived`) rather than staying
   * silent, so `_tiny` permanently carries two of these on a GREEN run. Fold
   * them into `errors` and the bench reds forever for saying something true,
   * and the obvious repair is to delete the honest warning.
   *
   * `gateOf` reads only each suite's own `gate`, so nothing here can turn a
   * run red by accident.
   */
  warnings: z.array(z.string()).optional(),
  /** B03r task 8 (design §7). One row per registration division this suite
   *  ran — `_tiny`'s own `registration-ui` free division, or (for suites
   *  1-12) every division a `--entry registration` run forced through the
   *  funnel. Absent for a suite that never touched registration at all. */
  registration: z.array(RegistrationDivisionReport).optional(),
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
  /** The run's own `--entry` flag (design §3 / §7), mirroring `register.ts`'s
   *  `CliEntryFlag` — `satisfies` below breaks the build if that union ever
   *  changes under this literal list. Undefined means every division kept
   *  its pack-declared entry mode. Drives whether "Registration at volume"
   *  renders (design §7: "under `--entry registration` for suites 1-12"). */
  entryMode: z.enum(["admin", "registration"] satisfies readonly CliEntryFlag[]).optional(),
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

// ---------------------------------------------------------------------------
// Registration rendering (B03r task 8, design §7)
// ---------------------------------------------------------------------------

/**
 * C2 (`B03r-repins-2026-09-03.md`): `gateRosterEligibility`
 * ("ELIGIBILITY_VIOLATION") is reachable only from entrant creation and
 * fixture generation — B04 territory, never from this session's organiser
 * actions (approve/reject/promote/assign). A division reporting
 * `organiserForceEligibilityProven: false` must say so IN the funnel
 * section, visibly — never omitted, never buried, never read as a pass.
 */
const ORGANISER_FORCE_UNPROVEN_NOTE =
  'organiser-force eligibility gate: UNPROVEN this run — `gateRosterEligibility` ("ELIGIBILITY_VIOLATION") is reachable only from entrant creation / fixture generation (B04 territory), never from this run’s organiser actions. Only the public-submit half of design §5.2’s eligibility gate is proven here.';

function renderRegistrationTable(divisions: readonly RegistrationDivisionReport[]): string[] {
  const lines = [
    "| Division | Entries | Entrants | Waitlisted | Rejected (eligibility) | Rejected (manual) | Paid cents | Funnel wall-time | Pad wall-time |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const d of divisions) {
    const funnel = d.funnelWallMs !== undefined ? `${d.funnelWallMs}ms` : "n/a";
    const pad = d.padWallMs !== undefined ? `${d.padWallMs}ms` : "n/a";
    lines.push(
      `| ${d.divisionRef} | ${d.entries} | ${d.entrants} | ${d.waitlisted} | ${d.rejectedEligibility} | ${d.rejectedManual} | ${d.paidCents} | ${funnel} | ${pad} |`,
    );
  }
  return lines;
}

/** Per-division notes: the organiser-force honesty note (when unproven) and
 *  any failure artefacts (design §5.3: response body, screenshot + trace
 *  paths when a browser driver produced them). */
function renderRegistrationDivisionNotes(divisions: readonly RegistrationDivisionReport[]): string[] {
  const lines: string[] = [];
  for (const d of divisions) {
    if (!d.organiserForceEligibilityProven) {
      lines.push(`- \`${d.divisionRef}\`: ${ORGANISER_FORCE_UNPROVEN_NOTE}`);
    }
    const failures = d.failures ?? [];
    if (failures.length > 0) {
      lines.push(`- \`${d.divisionRef}\` failures:`);
      for (const f of failures) {
        const artefacts = [
          f.responseBody !== undefined ? `response body: ${f.responseBody}` : undefined,
          f.screenshotPath !== undefined ? `screenshot: ${f.screenshotPath}` : undefined,
          f.tracePath !== undefined ? `trace: ${f.tracePath}` : undefined,
        ].filter((part): part is string => part !== undefined);
        lines.push(`  - ${f.detail}${artefacts.length > 0 ? ` — ${artefacts.join(", ")}` : ""}`);
      }
    }
  }
  return lines;
}

/** design §7: "Under `--entry registration` for suites 1-12 the same table
 *  appears in a 'Registration at volume' section with no gates." Suite 13
 *  (`SUITE_13_KEY`) keeps its own gated funnel oracle inside its own suite
 *  section (`renderSuitesSection`) — it is deliberately EXCLUDED from this
 *  aggregate, never double-counted into an ungated view of a gated result. */
function renderRegistrationAtVolumeSection(report: BenchReport): string {
  if (report.entryMode !== "registration") return "";
  const divisions = report.suites.filter((s) => s.suite !== SUITE_13_KEY).flatMap((s) => s.registration ?? []);
  const lines = ["## Registration at volume", "", "Report-only — no gates (design §7)."];
  if (divisions.length === 0) {
    lines.push("", "(no registration divisions ran)");
    return lines.join("\n");
  }
  lines.push("", ...renderRegistrationTable(divisions));
  const notes = renderRegistrationDivisionNotes(divisions);
  if (notes.length > 0) lines.push("", ...notes);
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
    // Rendered on a GREEN suite too — that is the whole point of the channel:
    // "this oracle was not checked offline" is a fact a reader has to see, and
    // a warning printed only next to a failure is a warning nobody reads.
    if (suite.warnings && suite.warnings.length > 0) {
      lines.push("- Warnings (not gated):");
      for (const w of suite.warnings) lines.push(`  - ${w}`);
    }
    if (suite.registration && suite.registration.length > 0) {
      lines.push("", "#### Registration", "", ...renderRegistrationTable(suite.registration));
      const notes = renderRegistrationDivisionNotes(suite.registration);
      if (notes.length > 0) lines.push("", ...notes);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderMarkdown(report: BenchReport): string {
  const sections = [
    renderHeader(report),
    renderPreflightSection(report),
    renderSuitesSection(report),
    renderRegistrationAtVolumeSection(report),
  ];
  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}
