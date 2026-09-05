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
/** TYPE-ONLY, so nothing here adds a runtime edge to the scheduling layer —
 *  these exist purely so the enums below cannot drift from the vocabularies
 *  `schedule.ts` already owns (the same `satisfies` discipline `entryMode`
 *  already uses against `CliEntryFlag`). `SolverMode` is read OFF
 *  `ScheduleOutcome` rather than imported by name because `schedule.ts`
 *  declares that union inline and this file may not widen its exports. */
import type { ActualEngine, RequestedEngine, ScheduleOutcome } from "./schedule.ts";

type SolverMode = NonNullable<ScheduleOutcome["mode"]>;

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

// ---------------------------------------------------------------------------
// B04 — the scheduling layer's report shape (design §3.2-§3.5)
//
// Every array below is `.readonly()` so the lib types (`CheckerReport`,
// `CertificateVerdict`, `BelievabilityReport`, `ScheduleOutcome` — all of them
// `readonly`) assign straight in. A mutable `z.array` would force each call
// site to copy, and a copy is a place where a field can be dropped in silence.
//
// The unions that ALREADY exist elsewhere are pinned with `satisfies` rather
// than restated: a second copy of `ActualEngine` here would compile happily
// while meaning something different from the one `schedule.ts` writes.
// `CheckerFindingKind` is deliberately NOT pinned — it is a closed union of 14
// members that grows with the checker, and `z.string()` plus this note is
// honest about the coupling in a way a stale 14-member copy would not be.
// ---------------------------------------------------------------------------

const REQUESTED_ENGINES = ["optimized", "greedy", "both"] satisfies readonly RequestedEngine[];
const ACTUAL_ENGINES = ["greedy", "optimized"] satisfies readonly ActualEngine[];
const SOLVER_MODES = ["build", "reflow", "polish"] satisfies readonly SolverMode[];

/** `ScheduleMetricsOut` (`schedule.ts`), which is `ScheduleMetrics`
 *  (`schemas.ts:1693-1699`) camelCased once at the driver seam. */
export const ScheduleMetricsReport = z.object({
  makespanMinutes: z.number(),
  worstIdleGapMinutes: z.number(),
  courtImbalanceMinutes: z.number(),
  /** THE SOLVER'S OWN PROPOSAL, never the fetched board — see
   *  `DivisionScheduleReport.unplacedCount` for the other denominator and why
   *  the two are reported side by side rather than reconciled into one. */
  placed: z.number(),
  total: z.number(),
});
export type ScheduleMetricsReport = z.infer<typeof ScheduleMetricsReport>;

export const CheckerFindingReport = z.object({
  kind: z.string(),
  divisionRef: z.string(),
  /** BOTH sides of a pairwise breach — a round-order or overlap finding
   *  naming only one fixture cannot be acted on (`board.ts`). */
  fixtureIds: z.array(z.string()).readonly(),
  detail: z.string(),
  measured: z.number().optional(),
  required: z.number().optional(),
});
export type CheckerFindingReport = z.infer<typeof CheckerFindingReport>;

export const UncheckedConstraintReport = z.object({ type: z.string(), reason: z.string() });
export type UncheckedConstraintReport = z.infer<typeof UncheckedConstraintReport>;

/**
 * `CheckerReport`, verbatim.
 *
 * `unchecked` travels WITH `clean` and is rendered beside it (design
 * §1.4/§3.3): a checker that verified four of a pack's six declared
 * constraints and found nothing wrong is reporting "clean" about four
 * constraints, and a report that prints the verdict without the list lets that
 * read as six.
 */
export const CheckerVerdictReport = z.object({
  clean: z.boolean(),
  findings: z.array(CheckerFindingReport).readonly(),
  unchecked: z.array(UncheckedConstraintReport).readonly(),
});
export type CheckerVerdictReport = z.infer<typeof CheckerVerdictReport>;

/** `CertificateVerdict` (`board.ts`). `branch` is `z.string()` for the same
 *  reason `CheckerFindingReport.kind` is — `certificate.ts` owns that union
 *  and derives `red` from it through a total record, so a copy here could
 *  only ever disagree. */
export const CertificateVerdictReport = z.object({
  branch: z.string(),
  reason: z.string(),
  red: z.boolean(),
  violations: z.array(CheckerFindingReport).readonly(),
});
export type CertificateVerdictReport = z.infer<typeof CertificateVerdictReport>;

/** `BelievabilityReport` (`believability.ts`) — report-only, never a gate. */
export const BelievabilityDivisionReport = z.object({
  metrics: z
    .array(z.object({ key: z.string(), score: z.number() }))
    .readonly(),
  metricsNote: z.string().optional(),
  similarityToHistorical: z
    .object({
      sameDayPct: z.number(),
      sameInstantPct: z.number(),
      /** The denominator, stated rather than implied — "100%" over one lucky
       *  match reads exactly like "100%" over a full timetable. */
      comparedFixtures: z.number(),
      historicalRows: z.number(),
    })
    .optional(),
  similarityNote: z.string().optional(),
});
export type BelievabilityDivisionReport = z.infer<typeof BelievabilityDivisionReport>;

/**
 * One division's whole walk: the driver's telemetry, then the three
 * verification layers, then the composed verdict.
 *
 * `checker`/`certificate` are OPTIONAL, and the reason is the honest one: a
 * division that threw before its board was fetched has no board for the
 * checker to judge, and `checkBoard` on an empty board returns `clean: true`
 * having measured nothing. Recording that as a clean checker would be design
 * §1.4's false clean wearing the schema's own type annotation, so the field is
 * absent instead and `reasons` carries the errors that made it absent.
 */
export const DivisionScheduleReport = z.object({
  divisionRef: z.string(),
  requestedEngine: z.enum(REQUESTED_ENGINES),
  /** Absent when `auto` never answered, or answered without telemetry. */
  actualEngine: z.enum(ACTUAL_ENGINES).optional(),
  solverStatus: z.string().optional(),
  notSearchedReason: z.string().optional(),
  mode: z.enum(SOLVER_MODES).optional(),
  budgetExpired: z.boolean().optional(),
  tiersCompleted: z.number().optional(),
  tiersTotal: z.number().optional(),
  /** The PROPOSAL's own counts. Absent means `auto` returned no metrics at
   *  all — which is a schedule error, not a zero: see `metricsNote`. */
  metrics: ScheduleMetricsReport.optional(),
  /** Why `metrics` is absent, when it is. Present exactly when `metrics` is
   *  not, so "the solver placed nothing" and "the solver said nothing" can
   *  never be read as the same state. */
  metricsNote: z.string().optional(),
  /** `/validate` rows with `blocking: true` — layer 1, asserted at zero. */
  blockingCount: z.number(),
  /** Warn-level `/validate` rows per `details.kind`. Report-only. */
  warnKindTally: z.record(z.string(), z.number()),
  /** Fixtures with no slot on the FETCHED board. The OTHER denominator —
   *  never `metrics.total - metrics.placed`, which describes the proposal. */
  unplacedCount: z.number(),
  wallMs: z.number(),
  scheduleErrors: z.array(z.string()).readonly(),
  checker: CheckerVerdictReport.optional(),
  /**
   * F-T6-2 — the SAME checker, re-run after officials auto-assign landed.
   *
   * `/officials/auto` only considers fixtures whose `scheduled_at` is already
   * set, so it cannot run before apply — which means `checker` above judged a
   * board that predates it. BOTH verdicts are carried, never one: a single
   * post-officials verdict would hide which stage introduced a finding, and
   * "clean when scheduled, dirty once the officials landed" is precisely the
   * fact a reader needs. Absent when auto-assign applied nothing, which is the
   * ordinary case.
   */
  checkerAfterOfficials: CheckerVerdictReport.optional(),
  certificate: CertificateVerdictReport.optional(),
  believability: BelievabilityDivisionReport.optional(),
  /** `judgeDivision`'s composition, carried so the report never re-derives a
   *  verdict a second way. */
  red: z.boolean(),
  reasons: z.array(z.string()).readonly(),
});
export type DivisionScheduleReport = z.infer<typeof DivisionScheduleReport>;

/**
 * F-T6-3 — one court held by two overlapping fixtures from DIFFERENT
 * divisions. A RUN-level fact, so it hangs off the suite and not off a
 * division: no per-division layer can see it, which is the whole reason it
 * exists. `checkBoard` is handed one division's `Board`, `certify` one
 * division's encoding, and `POST /divisions/{id}/schedule/validate` is
 * addressed by a division id.
 *
 * Both sides are always named, for the same reason `CheckerFinding.fixtureIds`
 * carries both: a clash naming one fixture cannot be acted on.
 */
export const CrossDivisionCourtClashReport = z.object({
  courtId: z.string(),
  a: z.object({
    divisionRef: z.string(),
    fixtureId: z.string(),
    /** Epoch ms, the unit every occupancy rule in this bench measures in. */
    start: z.number(),
    end: z.number(),
  }),
  b: z.object({
    divisionRef: z.string(),
    fixtureId: z.string(),
    start: z.number(),
    end: z.number(),
  }),
});
export type CrossDivisionCourtClashReport = z.infer<typeof CrossDivisionCourtClashReport>;

/** `EngineSnapshot` (`schedule.ts`) as it comes back off disk. */
export const EngineSnapshotReport = z.object({
  runId: z.string(),
  requestedEngine: z.enum(REQUESTED_ENGINES),
  engine: z.enum(ACTUAL_ENGINES),
  divisions: z
    .array(
      z.object({
        divisionRef: z.string(),
        metrics: ScheduleMetricsReport.optional(),
        solverStatus: z.string().optional(),
        notSearchedReason: z.string().optional(),
        mode: z.enum(SOLVER_MODES).optional(),
        budgetExpired: z.boolean().optional(),
        tiersCompleted: z.number().optional(),
        tiersTotal: z.number().optional(),
        blockingCount: z.number(),
        unplacedCount: z.number(),
        wallMs: z.number(),
        verdict: z
          .object({ red: z.boolean(), reasons: z.array(z.string()).readonly() })
          .optional(),
      }),
    )
    .readonly(),
});
export type EngineSnapshotReport = z.infer<typeof EngineSnapshotReport>;

/** `EngineDeltaReport` (`believability.ts`) — a RUN-level fact, assembled
 *  from two separate runs' artifacts, so it hangs off the suite once and not
 *  off each division. `note` is present exactly when `delta` is absent, and
 *  it is what keeps "only greedy ran" from reading as "the engines tied". */
export const EngineDeltaSection = z.object({
  delta: z
    .object({
      greedy: EngineSnapshotReport,
      optimized: EngineSnapshotReport,
      /** GREEDY MINUS OPTIMIZED — positive is what optimizing bought. The
       *  sign is kept, because "the optimizer did worse" is a legitimate and
       *  interesting result. */
      makespanDeltaMinutes: z.number(),
      courtImbalanceDeltaMinutes: z.number(),
      /** Which divisions the two sums actually cover. Two legs sharing NO
       *  division produce 0 and 0, which reads identically to a tie. */
      comparedDivisionRefs: z.array(z.string()).readonly(),
    })
    .optional(),
  note: z.string().optional(),
});
export type EngineDeltaSection = z.infer<typeof EngineDeltaSection>;

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
  /** B04 — one row per division this suite actually drove through the
   *  scheduling layer, in the order it drove them. Absent for a suite that
   *  never scheduled anything (a `--keep` short circuit, a pack refused by
   *  stage 0, a run that died before seeding). */
  scheduling: z.array(DivisionScheduleReport).readonly().optional(),
  /** B04 — the greedy-vs-optimized comparison. RUN-level, so exactly one per
   *  suite: `assessEngineDelta` is called ONCE after the division loop, never
   *  per division, or every copy would list every other division's refs in
   *  `comparedDivisionRefs`. */
  engineDelta: EngineDeltaSection.optional(),
  /** F-T6-3 — the run-level cross-division court gate's findings. RUN-level,
   *  so exactly one list per suite. Absent when it found nothing. */
  crossDivisionCourtClashes: z.array(CrossDivisionCourtClashReport).readonly().optional(),
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

// ---------------------------------------------------------------------------
// B04 — scheduling, checker, certificate, believability, engine delta
//
// FIVE sections rather than one, because they answer five different questions
// and a reader chasing one of them should not have to read the other four.
// Each renders "" when nothing populated it, and `renderMarkdown` drops empty
// sections — so a pre-B04 report (or a `--keep` short circuit, which schedules
// nothing) is byte-identical to what it was.
// ---------------------------------------------------------------------------

/** Every scheduled division across every suite, each carrying the suite it
 *  came from. Flattened once here rather than in five places. */
function scheduledDivisions(
  report: BenchReport,
): readonly { suite: string; division: DivisionScheduleReport }[] {
  return report.suites.flatMap((s) =>
    (s.scheduling ?? []).map((division) => ({ suite: s.suite, division })),
  );
}

const NA = "n/a";
const num = (value: number | undefined): string => (value === undefined ? NA : String(value));

function renderSchedulingSection(report: BenchReport): string {
  const rows = scheduledDivisions(report);
  if (rows.length === 0) return "";
  const lines = [
    "## Scheduling",
    "",
    "| Suite | Division | Requested | Actual | Status | Mode | Blocking | Unplaced (board) | Placed/Total (proposal) | Wall |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const { suite, division: d } of rows) {
    // TWO denominators, side by side and never merged: "Unplaced (board)" is
    // what the FETCHED board shows and is `judgeDivision`'s own gate;
    // "Placed/Total (proposal)" is what the solver CLAIMED and is what the
    // certificate's UNPLACED branch reads. They answer different questions,
    // and a run where they disagree is exactly the run a reader needs to see
    // both numbers for.
    const proposal =
      d.metrics === undefined ? NA : `${d.metrics.placed}/${d.metrics.total}`;
    lines.push(
      `| ${suite} | ${d.divisionRef} | ${d.requestedEngine} | ${d.actualEngine ?? NA} | ${d.solverStatus ?? NA} | ${d.mode ?? NA} | ${d.blockingCount} | ${d.unplacedCount} | ${proposal} | ${d.wallMs}ms |`,
    );
  }
  const notes: string[] = [];
  for (const { division: d } of rows) {
    if (d.metricsNote !== undefined) notes.push(`- \`${d.divisionRef}\`: ${d.metricsNote}`);
    if (d.notSearchedReason !== undefined) {
      notes.push(`- \`${d.divisionRef}\`: solver did not search — ${d.notSearchedReason}`);
    }
    if (d.budgetExpired === true) {
      notes.push(
        `- \`${d.divisionRef}\`: solver budget expired (tiers ${num(d.tiersCompleted)}/${num(d.tiersTotal)})`,
      );
    }
    const warnKinds = Object.entries(d.warnKindTally);
    if (warnKinds.length > 0) {
      notes.push(
        `- \`${d.divisionRef}\`: warn-level conflicts — ${warnKinds.map(([kind, n]) => `${kind}=${n}`).join(", ")}`,
      );
    }
    for (const err of d.scheduleErrors) notes.push(`- \`${d.divisionRef}\` ERROR: ${err}`);
  }
  if (notes.length > 0) lines.push("", ...notes);
  return lines.join("\n");
}

/**
 * The checker's verdict AND its `unchecked` list, in one place.
 *
 * The two are rendered TOGETHER and that is the requirement, not a layout
 * choice (design §1.4/§3.3): "checker clean" is a claim about the constraints
 * the checker actually modelled, and a pack can declare knobs it does not
 * model. Printing the verdict without the list lets a reader take "clean" for
 * "every declared constraint was verified" — the exact false clean this whole
 * layer exists to prevent. So a division with an empty `unchecked` says so
 * explicitly rather than rendering nothing.
 */
function renderCheckerSection(report: BenchReport): string {
  const rows = scheduledDivisions(report).filter(({ division }) => division.checker !== undefined);
  if (rows.length === 0) return "";
  const lines = ["## Checker (independent verifier)", ""];
  for (const { suite, division: d } of rows) {
    const checker = d.checker;
    if (checker === undefined) continue;
    lines.push(
      `### ${suite} / ${d.divisionRef} — ${checker.clean ? "CLEAN" : `${checker.findings.length} FINDING(S)`}`,
      "",
    );
    if (checker.unchecked.length === 0) {
      lines.push("- Unchecked constraints: none — every declared constraint was modelled.");
    } else {
      lines.push(
        `- Unchecked constraints (${checker.unchecked.length}) — "clean" above does NOT cover these:`,
      );
      for (const u of checker.unchecked) lines.push(`  - \`${u.type}\`: ${u.reason}`);
    }
    for (const f of checker.findings) lines.push(`- ${renderFinding(f)}`);

    // F-T6-2 — the SECOND verdict, on the board as it stands after officials
    // auto-assign. Rendered beside the first, never instead of it: which of
    // the two stages introduced a finding is the actionable half, and a lone
    // post-officials verdict throws it away.
    const after = d.checkerAfterOfficials;
    if (after !== undefined) {
      lines.push(
        "",
        `After officials auto-assign — ${after.clean ? "CLEAN" : `${after.findings.length} FINDING(S)`}` +
          (after.clean === checker.clean
            ? " (unchanged)"
            : ` (CHANGED from ${checker.clean ? "clean" : "dirty"} — officials auto-assign is what moved it)`),
      );
      for (const f of after.findings) lines.push(`- ${renderFinding(f)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** One finding, rendered once — both sides of a pairwise breach named, and the
 *  measured/required pair only when the kind actually has a scalar. */
function renderFinding(f: CheckerFindingReport): string {
  const measured =
    f.measured !== undefined && f.required !== undefined
      ? ` (measured ${f.measured}, required ${f.required})`
      : "";
  return `\`${f.kind}\` [${f.fixtureIds.join(", ")}]: ${f.detail}${measured}`;
}

/**
 * F-T6-3 — the run-level cross-division court gate.
 *
 * Its own section rather than a line inside "Checker", because it is the one
 * verdict in this report that is NOT per-division — and because its absence is
 * the interesting state. A reader who finds no such section on a multi-division
 * run should be able to conclude the check ran and found nothing, so the
 * section renders whenever any division was scheduled, not only when it fired.
 */
function renderCrossDivisionSection(report: BenchReport): string {
  const suites = report.suites.filter((s) => (s.scheduling ?? []).length > 0);
  if (suites.length === 0) return "";
  const lines = [
    "## Cross-division court occupancy (run-level gate)",
    "",
    "One court cannot hold two fixtures at once whichever division each belongs to.",
    "Every OTHER layer in this report is division-scoped and blind to this by construction.",
  ];
  for (const suite of suites) {
    const clashes = suite.crossDivisionCourtClashes ?? [];
    if (clashes.length === 0) {
      lines.push("", `- \`${suite.suite}\`: none — checked across ${(suite.scheduling ?? []).length} division(s).`);
      continue;
    }
    lines.push("", `- \`${suite.suite}\`: **${clashes.length} clash(es)**`);
    for (const c of clashes) {
      lines.push(
        `  - court \`${c.courtId}\`: ${c.a.divisionRef}/${c.a.fixtureId} ` +
          `[${new Date(c.a.start).toISOString()} .. ${new Date(c.a.end).toISOString()}) overlaps ` +
          `${c.b.divisionRef}/${c.b.fixtureId} ` +
          `[${new Date(c.b.start).toISOString()} .. ${new Date(c.b.end).toISOString()})`,
      );
    }
  }
  return lines.join("\n");
}

function renderCertificateSection(report: BenchReport): string {
  const rows = scheduledDivisions(report).filter(
    ({ division }) => division.certificate !== undefined,
  );
  if (rows.length === 0) return "";
  const lines = [
    "## Feasibility certificate",
    "",
    "| Suite | Division | Branch | Red? | Reason |",
    "|---|---|---|---|---|",
  ];
  for (const { suite, division: d } of rows) {
    const c = d.certificate;
    if (c === undefined) continue;
    lines.push(
      `| ${suite} | ${d.divisionRef} | \`${c.branch}\` | ${c.red ? "yes" : "no"} | ${c.reason} |`,
    );
  }
  const violations: string[] = [];
  for (const { division: d } of rows) {
    for (const v of d.certificate?.violations ?? []) {
      violations.push(`- \`${d.divisionRef}\` \`${v.kind}\` [${v.fixtureIds.join(", ")}]: ${v.detail}`);
    }
  }
  if (violations.length > 0) {
    lines.push("", "History's own violations of this pack's encoding:", ...violations);
  }
  return lines.join("\n");
}

function renderBelievabilitySection(report: BenchReport): string {
  const rows = scheduledDivisions(report).filter(
    ({ division }) => division.believability !== undefined,
  );
  if (rows.length === 0) return "";
  const lines = [
    "## Believability",
    "",
    "Report-only — nothing here ever reds a run (design §3.5).",
    "",
  ];
  for (const { suite, division: d } of rows) {
    const b = d.believability;
    if (b === undefined) continue;
    const metrics =
      b.metrics.length === 0
        ? "(none)"
        : b.metrics.map((m) => `${m.key}=${m.score}`).join(", ");
    lines.push(`- \`${suite}/${d.divisionRef}\`: ${metrics}`);
    if (b.metricsNote !== undefined) lines.push(`  - ${b.metricsNote}`);
    if (b.similarityToHistorical !== undefined) {
      const s = b.similarityToHistorical;
      lines.push(
        `  - similarity to historical: ${s.sameDayPct}% same day, ${s.sameInstantPct}% same instant ` +
          `over ${s.comparedFixtures} compared fixture(s) of ${s.historicalRows} declared row(s)`,
      );
    }
    if (b.similarityNote !== undefined) lines.push(`  - ${b.similarityNote}`);
  }
  return lines.join("\n");
}

function renderEngineDeltaSection(report: BenchReport): string {
  const suites = report.suites.filter((s) => s.engineDelta !== undefined);
  if (suites.length === 0) return "";
  const lines = ["## Engine delta (greedy − optimized)", ""];
  for (const suite of suites) {
    const section = suite.engineDelta;
    if (section === undefined) continue;
    if (section.delta === undefined) {
      // The note is the point: "only greedy ran" and "the engines tied" both
      // produce no numbers, and only this line tells them apart.
      lines.push(`- \`${suite.suite}\`: ${section.note ?? "no delta and no reason given"}`);
      continue;
    }
    const d = section.delta;
    const covered =
      d.comparedDivisionRefs.length === 0
        ? "NO divisions in common — the two sums below compare nothing"
        : d.comparedDivisionRefs.join(", ");
    lines.push(
      `- \`${suite.suite}\`: makespan ${d.makespanDeltaMinutes}min, court imbalance ${d.courtImbalanceDeltaMinutes}min ` +
        `(positive = optimizing bought it), over: ${covered}`,
      `  - greedy leg run \`${d.greedy.runId}\`, optimized leg run \`${d.optimized.runId}\``,
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(report: BenchReport): string {
  const sections = [
    renderHeader(report),
    renderPreflightSection(report),
    renderSuitesSection(report),
    renderRegistrationAtVolumeSection(report),
    // B04 (design §10's own convention: append, never edit the existing).
    renderSchedulingSection(report),
    renderCheckerSection(report),
    renderCrossDivisionSection(report),
    renderCertificateSection(report),
    renderBelievabilitySection(report),
    renderEngineDeltaSection(report),
  ];
  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}
