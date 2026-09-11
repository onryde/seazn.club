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
import { renderProvenance } from "./provenance.ts";
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

/**
 * T7e — `SuiteReport.gate`'s own vocabulary, a THIRD, non-green value beyond
 * the run-level `GateStatus`: "skipped" is a `--keep` short circuit that
 * skipped seeding AND scheduling entirely (`tiny.ts`'s `lookup.kind ===
 * "reuse"` branch). Before this, that branch returned the literal `"green"` —
 * the same value a run that actually scheduled, checked and certified a board
 * reports — so a reader (and `gateOf`) could not tell "this passed" from
 * "nothing was measured this run". That is exactly the failure class B04
 * exists to catch everywhere else (`CheckerReport.unexercised` is the same
 * idea one layer down): a clean verdict must never be able to mean "checked
 * nothing".
 *
 * A SEPARATE schema from `GateStatus`, not a widening of it, because the
 * run-level `BenchReport.gate` stays a closed two-value CI-exit-code signal
 * (`bench.ts`'s `gate === "red" ? 1 : 0`) — the distinction that matters at
 * that level is pass/fail, and `gateOf` below folds "skipped" into "red"
 * there. The finer "why didn't this pass" distinction belongs on the suite,
 * where a reader can see the warning that explains it.
 */
export const SuiteGateStatus = z.enum(["green", "red", "skipped"]);
export type SuiteGateStatus = z.infer<typeof SuiteGateStatus>;

export const PhaseTimings = z.object({
  seedMs: z.number().optional(),
  scheduleMs: z.number().optional(),
  simMs: z.number().optional(),
  /** B05 T2 — division B's batch-import fold, separate from `simMs` (T1's
   *  single-event fold) so a reader can tell the two write paths apart. */
  importMs: z.number().optional(),
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

/**
 * B05 T6 fix 2 — a THIRD verdict beside pass/fail.
 *
 * The first live run printed `PASS oracle: d-tiny/s-league tie-order cascade
 * … (0 checked, 0 skipped)` for two of three divisions. A comparator that
 * checked nothing has not passed — it had no subject, which is the exact
 * vacuity this wave exists to eliminate, printing itself green in the wave's
 * own report.
 *
 * `no_subject` does not RED a run (an absent subject is not a failure), but it
 * must never READ as PASS.
 *
 * ---------------------------------------------------------------------------
 * B05 review round 1, MAJOR 2 — THE ZERO-SUBJECT RULE, stated once, here.
 *
 * The wave shipped three different answers to "this comparator had nothing to
 * compare": this verdict, a hard FAIL, and a warning with NO oracle row at all
 * (the last one invisible to `report.oracles` AND to the `oracle_checked`
 * stream, so a reader could not tell a skipped comparator from one that was
 * never written). Which answer is right turns on WHOSE side the emptiness is
 * on, and that is the whole rule:
 *
 *  - The PACK declared nothing for this comparator  -> `no_subject`.
 *    The bench was never owed a check. It still pushes an oracle row (and
 *    emits `oracle_checked`), so the absence is COUNTED rather than silent,
 *    and it never reds. Empty `expected.suspensions`/`expected.careers`, a
 *    division declaring no `tiebreakers`.
 *
 *  - The pack declared a subject and the PRODUCT returned nothing for it
 *    -> `fail`. That is not an absent subject, it is a missing answer to a
 *    question that WAS asked, and it reds. Every site that reds this way
 *    states the reason in one line beside the guard: `compareRankCrossings`
 *    and `compareFinalRanks` (an empty crossing where a completed stage owed
 *    a ranking), the person-cards block (a board `pack-schema.ts` gives
 *    `entries.min(1)` resolving to zero), the enforcement probe (a declared
 *    suspension with no missed fixture to refuse a sheet for).
 *
 * A new comparator picks its side by asking which of those two it is. There
 * is no third answer.
 * ---------------------------------------------------------------------------
 */
export const OracleVerdict = z.enum(["pass", "fail", "no_subject"]);
export type OracleVerdict = z.infer<typeof OracleVerdict>;

export const OracleResult = z
  .object({
    name: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
    /** Absent on every oracle written before B05 T6 — `oracleVerdictOf`
     *  derives `pass`/`fail` from `passed` for those, so an existing report
     *  round-trips and renders byte-identically. */
    verdict: OracleVerdict.optional(),
    /** B05 review round 1, MINOR: did this oracle actually COMPARE anything?
     *
     *  The run summary used to answer that by deriving it — `verdict !==
     *  "no_subject"` — which counted a FAIL raised precisely BECAUSE nothing
     *  was compared (a board resolving zero entries, an empty rank crossing)
     *  among the oracles that had a subject. It is set by the call site off
     *  the comparator's OWN field — `RankCrossingComparison.reason`,
     *  `FinalRanksComparison.reason`, `TieOrderCascadeComparison.checkedPairs`,
     *  the resolved entry count — so the summary reports what the comparator
     *  measured instead of re-deriving it from the verdict.
     *
     *  Absent means "not reported", and the old derivation stands for it, so
     *  every oracle written before this round round-trips unchanged. */
    subject: z.boolean().optional(),
  })
  .superRefine((o, ctx) => {
    // B05 review round 1, MINOR: `no_subject` and `subject: true` are two
    // answers to one question, and left free to drift they are how the
    // summary line would quietly start over-counting again.
    if (o.verdict === "no_subject" && o.subject === true) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message: `oracle "${o.name}": verdict "no_subject" cannot also report subject: true`,
      });
    }
    if (o.verdict === undefined) return;
    // `passed` is the GATE-facing half and `verdict` the READER-facing half.
    // Pinned against each other here rather than left to each call site,
    // because two answers to one question left free to drift is how a
    // "no_subject" oracle would quietly acquire a red gate (or a "fail" a
    // green one). Only ONE combination is legal per verdict.
    const expectedPassed = o.verdict !== "fail";
    if (o.passed !== expectedPassed) {
      ctx.addIssue({
        code: "custom",
        path: ["passed"],
        message: `oracle "${o.name}": verdict "${o.verdict}" requires passed: ${expectedPassed}, got ${o.passed}`,
      });
    }
  });
export type OracleResult = z.infer<typeof OracleResult>;

/** The reader-facing verdict for one oracle — the ONE place `passed` is
 *  turned into a label, so a renderer can never invent a fourth answer. */
export function oracleVerdictOf(o: OracleResult): OracleVerdict {
  return o.verdict ?? (o.passed ? "pass" : "fail");
}

/**
 * The `oracle_checked` pino payload's verdict half — `kind`, the reader-facing
 * `verdict`, and the `passed` boolean every existing log consumer already
 * reads, all DERIVED here from one input so the log stream cannot carry a
 * `no_subject` event that also says `passed: false` (or a `fail` that says
 * `passed: true`). The report's own `superRefine` above stops the same drift
 * inside report.json; this stops it in the logs.
 */
export function oracleLogFields(kind: string, verdict: OracleVerdict): {
  readonly kind: string;
  readonly passed: boolean;
  readonly verdict: OracleVerdict;
} {
  return { kind, passed: verdict !== "fail", verdict };
}

const ORACLE_VERDICT_LABEL: Readonly<Record<OracleVerdict, string>> = {
  pass: "PASS",
  fail: "FAIL",
  no_subject: "NO SUBJECT",
};

/** B05 T1 — one refusal `simulate.ts` hit while folding a division's streams
 *  through the live single-event scoring route. Reported, never silently
 *  retried or dropped (D5): a `SEQ_CONFLICT` (409), an entitlement/feature
 *  refusal (`PAYMENT_REQUIRED`, 402 — the REAL shape; see `dls-gate.ts`'s own
 *  header comment on why an entitlement refusal is 402, not 422), or a
 *  generic 422. */
export const SimulationFinding = z.object({
  streamKey: z.string(),
  fixtureId: z.string(),
  eventIndex: z.number().int(),
  status: z.number().int(),
  code: z.string(),
  message: z.string(),
  currentSeq: z.number().int().optional(),
});
export type SimulationFinding = z.infer<typeof SimulationFinding>;

/** B05 T1 — the single-event write-path fold's own section: report-only
 *  throughput (never a gate — the load-sensitive-timing rule, `_RULES.md`
 *  §1) plus any refusal findings. Kept minimal on purpose: T7 owns the
 *  report's PRESENTATION and the "which checks had a subject" naming. */
export const SimulationReport = z.object({
  eventsSent: z.number().int(),
  wallMs: z.number(),
  eventsPerSecond: z.number(),
  findings: z.array(SimulationFinding).optional(),
});
export type SimulationReport = z.infer<typeof SimulationReport>;

/** B05 T2 — the batch write-path fold's own finding shape. Flattens
 *  `import.ts`'s three finding kinds (`stream_oversize`, `call_refused`,
 *  `stream_not_imported`) into one reportable row rather than three
 *  separate arrays — `code` and `message`/`eventCount`/`cap` are populated
 *  per kind. Never a gate — same D5 "report, never silently retry or drop"
 *  convention `SimulationFinding` already follows.
 *
 *  T2.5 review MINOR: `kind` is a REQUIRED discriminator, not inferred from
 *  which optional fields happen to be populated. The three kinds' field sets
 *  are disjoint TODAY (a `chunkIndex` names a call-level refusal; a bare
 *  `streamKey` with no `chunkIndex` names either an oversize stream or a
 *  per-stream product outcome) but nothing enforced that beyond the mapper's
 *  own discipline — a reader inferring the kind from field presence breaks
 *  the moment two kinds' shapes overlap even slightly, and a discriminator
 *  costs nothing to keep correct. */
export const ImportFindingReport = z.object({
  kind: z.enum(["stream_oversize", "call_refused", "stream_not_imported"]),
  chunkIndex: z.number().int().optional(),
  streamKeys: z.array(z.string()).optional(),
  streamKey: z.string().optional(),
  fixture: z.string().optional(),
  status: z.union([z.number().int(), z.enum(["skipped_duplicate", "rejected"])]).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  eventIndex: z.number().int().optional(),
  eventCount: z.number().int().optional(),
  cap: z.number().int().optional(),
});
export type ImportFindingReport = z.infer<typeof ImportFindingReport>;

/** B05 T2 — division B's streams folded through the batch-import route.
 *  Kept minimal, same as `SimulationReport` above: report-only throughput
 *  (never a gate) plus any refusal/oversize/per-stream findings. T7 owns the
 *  report's PRESENTATION and the "which checks had a subject" naming. */
export const ImportSimulationReport = z.object({
  eventsSent: z.number().int(),
  wallMs: z.number(),
  eventsPerSecond: z.number(),
  chunks: z.number().int(),
  findings: z.array(ImportFindingReport).optional(),
});
export type ImportSimulationReport = z.infer<typeof ImportSimulationReport>;

/** B05 T2.5 (D9) — one `ScheduleConflict` row `runDivisionStartLayer` read
 *  off a 422 body. Same three fields `schedule.ts`'s own `WireConflict`
 *  reads and no others (`details.kind` ONLY, never `code`/`detail` — see
 *  that type's own doc comment) — present on BOTH refusal codes
 *  (`assertPublishable`'s shared `{ conflicts }` extra, apps/web). */
export const DivisionStartConflictReport = z.object({
  fixtureId: z.string().optional(),
  blocking: z.boolean().optional(),
  kind: z.string().optional(),
});
export type DivisionStartConflictReport = z.infer<typeof DivisionStartConflictReport>;

/** B05 T2.5 (D9) — one division's walk through `runDivisionStartLayer`: the
 *  step between "scheduled" and every write path this bench drives after it
 *  (`simulate.ts`'s and `import.ts`'s folds both 409 against an unstarted
 *  division). Never a gate on its own fields — `_tiny.ts`'s wiring folds a
 *  blocking refusal or a failed re-read into the suite's own `errors`, which
 *  is what actually reds `SuiteReport.gate`. */
export const DivisionStartReport = z.object({
  divisionRef: z.string(),
  /** True iff the retry (`acknowledge_warnings: true`) is what succeeded. */
  acknowledgedWarnings: z.boolean(),
  /** Every warning conflict recorded from an `SCHEDULE_UNACKNOWLEDGED_WARNINGS`
   *  refusal, before the retry — empty when the first attempt succeeded
   *  outright. */
  warnings: z.array(DivisionStartConflictReport),
  /** Present only on a `SCHEDULE_BLOCKING_CONFLICTS` refusal — the product's
   *  own conflict list. */
  blockingConflicts: z.array(DivisionStartConflictReport).optional(),
  /** D9's "report both sides": what B04's OWN independent checker
   *  (`checkBoard`, `SuiteReport.scheduling[]`'s own `.checker` field for the
   *  SAME `divisionRef`) said about this board moments earlier — populated
   *  alongside `blockingConflicts` so a reader can see the product's fresh
   *  refusal next to the checker's own verdict for the same board. */
  checkerClean: z.boolean().optional(),
  checkerFindingCount: z.number().int().optional(),
  /** T2.5 review MINOR — set (`true`) INSTEAD of `checkerClean`/
   *  `checkerFindingCount` when a `SCHEDULE_BLOCKING_CONFLICTS` refusal fires
   *  but this division's own `scheduling[]` row carries no `.checker` at all
   *  (the board fetch itself failed earlier in this SAME division's walk).
   *  Without this, "the checker had nothing to say" and "the checker said
   *  clean" were both just an absent `checkerClean` — D9's "report both
   *  sides" silently degraded to one side that reads as agreement. */
  checkerUnavailable: z.boolean().optional(),
  /** The division's status as RE-READ after a 200 — absent when no attempt
   *  ever returned 200. */
  confirmedStatus: z.string().optional(),
  /** THE D9 gate this row exists to prove: true iff a 200 was returned AND
   *  the re-read confirms the product's own "started" status. */
  started: z.boolean(),
});
export type DivisionStartReport = z.infer<typeof DivisionStartReport>;

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
 * T7b — the OPPOSITE direction from `UncheckedConstraintReport`: a rule this
 * build fully MODELS but which the board it just judged gave nothing to
 * compare (an empty blackout list, a rest floor of zero, a court with no
 * hours). Same `{ ..., reason }` idiom as `unchecked` deliberately, so a
 * reader meets one convention rather than two — `rule` rather than `type`
 * because the thing named is one of `checker.ts`'s own eight rules (`Rule 1`
 * .. `Rule 8`, with `2a`/`2b`/`2c` for its three independently-vacuous
 * operands), not a pack-declared knob.
 */
export const UnexercisedRuleReport = z.object({ rule: z.string(), reason: z.string() });
export type UnexercisedRuleReport = z.infer<typeof UnexercisedRuleReport>;

/**
 * `CheckerReport`, verbatim.
 *
 * `unchecked` travels WITH `clean` and is rendered beside it (design
 * §1.4/§3.3): a checker that verified four of a pack's six declared
 * constraints and found nothing wrong is reporting "clean" about four
 * constraints, and a report that prints the verdict without the list lets that
 * read as six.
 *
 * `unexercised` (T7b) travels with it for the same reason, in the other
 * direction: a rule can be fully modelled, run, and still find nothing
 * because the board gave it zero candidates — a court with no hours, a rest
 * floor of zero. Both fields are required, never optional, so a caller cannot
 * populate one and quietly drop the other.
 */
export const CheckerVerdictReport = z.object({
  clean: z.boolean(),
  findings: z.array(CheckerFindingReport).readonly(),
  unchecked: z.array(UncheckedConstraintReport).readonly(),
  unexercised: z.array(UnexercisedRuleReport).readonly(),
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

/** `EngineSnapshot` (`schedule.ts`) as it comes back off disk.
 *
 *  `engine` (the leg-level summary) is OPTIONAL (T7d): absent exactly when
 *  the leg's own divisions disagreed about which engine actually ran, which
 *  is a real, legitimate shape — see each division's own `actualEngine`. */
export const EngineSnapshotReport = z.object({
  runId: z.string(),
  requestedEngine: z.enum(REQUESTED_ENGINES),
  engine: z.enum(ACTUAL_ENGINES).optional(),
  divisions: z
    .array(
      z.object({
        divisionRef: z.string(),
        /** THIS division's own resolved engine — separate from the leg-level
         *  `engine` above, and the two can legitimately disagree. */
        actualEngine: z.enum(ACTUAL_ENGINES).optional(),
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
  gate: SuiteGateStatus,
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
  /** B01 declared this and nothing wrote it until B06a. Kept alongside the
   *  fuller `provenance` breakdown below so an older report still parses. */
  provenancePct: z.number().optional(),
  /** B06a task 5 — the counts behind the percentage, so a reader can see
   *  "6/8, 2 reconstructed" rather than a bare number whose denominator is
   *  invisible. */
  provenance: z
    .object({
      total: z.number(),
      real: z.number(),
      reconstructed: z.number(),
      synthetic: z.number(),
      realPct: z.number(),
    })
    .optional(),
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
  /** B05 T2.5 (D9) — one row per division `runDivisionStartLayer` started,
   *  in the order it started them — always BEFORE `simulation`/
   *  `importSimulation` below, since neither fold can run against an
   *  unstarted division. Absent for a run that never reached the step (no
   *  `input.sql`) or that declared no streamed division at all. */
  divisionStart: z.array(DivisionStartReport).optional(),
  /** B05 T1 — division A's streams folded through the single-event scoring
   *  route. Absent for a run that never reached the step (no `input.sql`,
   *  same gating the DLS-gate probe and the player-stats baseline already
   *  use) or whose division declared no streams at all. */
  simulation: SimulationReport.optional(),
  /** B05 T2 — division B's streams folded through the batch-import route
   *  (D4's OTHER write path). Same gating as `simulation` above; absent when
   *  no division besides division A declares streams. */
  importSimulation: ImportSimulationReport.optional(),
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
 *  whole run. Timings and solver telemetry never factor in here.
 *
 *  T7e: a suite gate of `"skipped"` reds the run too, same as `"red"` — the
 *  check is "anything not green", never "anything specifically red". A run
 *  that skipped seeding and scheduling (a `--keep` short circuit) has not
 *  passed anything, and folding it into `"green"` here would be the exact
 *  bare-green-on-nothing-measured defect this function exists to prevent,
 *  just relocated from the suite level to the run level. */
export function gateOf(report: Pick<BenchReport, "preflight" | "suites">): GateStatus {
  if (!report.preflight.ok) return "red";
  return report.suites.some((s) => s.gate !== "green") ? "red" : "green";
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
  // B05 T6 fix 2 — the run-level answer to "how many oracles actually had a
  // subject". Rendered only when a run produced oracles at all, so an
  // oracle-free report (a preflight refusal, a `--keep` short circuit) stays
  // byte-identical to what it was.
  const allOracles = report.suites.flatMap((s) => s.oracles ?? []);
  if (allOracles.length > 0) {
    const verdicts = allOracles.map(oracleVerdictOf);
    const noSubject = verdicts.filter((v) => v === "no_subject").length;
    // B05 review round 1, MINOR: read from the comparator's own `subject`
    // where it reports one, and fall back to the verdict only for oracles
    // that do not — a FAIL raised over ZERO comparisons is not an oracle that
    // had a subject, and deriving this from the verdict alone said it was.
    // The verdict tallies below stay verdict tallies, so this number
    // deliberately need not add up to them: that gap IS the fact.
    const withSubject = allOracles.filter((o) => o.subject ?? oracleVerdictOf(o) !== "no_subject").length;
    lines.push(
      `- Oracles: ${allOracles.length} total, ${withSubject} with a subject ` +
        `(${verdicts.filter((v) => v === "pass").length} PASS, ${verdicts.filter((v) => v === "fail").length} FAIL), ` +
        `${noSubject} NO SUBJECT`,
    );
  }
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
      t.importMs !== undefined ? `import ${t.importMs}ms` : undefined,
    ].filter((part): part is string => part !== undefined);
    if (timingParts.length > 0) lines.push(`- Timings: ${timingParts.join(", ")}`);
    if (suite.keep !== undefined) lines.push(`- Data left in place: ${suite.keep ? "yes (--keep)" : "no (--wipe requested)"}`);
    if (suite.solver) {
      lines.push(
        `- Solver: requested=${suite.solver.requestedEngine ?? "n/a"}, actual=${suite.solver.engine ?? "n/a"}, status=${suite.solver.status ?? "n/a"}`,
      );
    }
    if (suite.conflictCount !== undefined) lines.push(`- Blocking conflicts: ${suite.conflictCount}`);
    if (suite.provenance !== undefined) lines.push(`- Provenance: ${renderProvenance(suite.provenance)}`);
    else if (suite.provenancePct !== undefined) lines.push(`- Provenance: ${suite.provenancePct}% real`);
    // B07a T3 — declared since B01 with no writer, exactly as `provenancePct`
    // had none until B06a T5. Provenance says how much of a pack was
    // GENERATED rather than observed; this says how much of reality was
    // RESHAPED to fit the product's model (design §7A), and a thin-data pack's
    // honesty claim rests on both halves being visible.
    //
    // The count is stated even when it is ZERO, and an ABSENT field is a
    // different state from an empty one: a pre-B07a report never measured
    // this, while an empty list is a pack asserting it reshaped nothing.
    // Render silence for both and a pack whose adaptations went missing on
    // the way here reads as the cleanest pack in the suite.
    if (suite.adaptations !== undefined) {
      if (suite.adaptations.length === 0) {
        lines.push("- Adaptations: 0 adaptations — this pack reshaped nothing.");
      } else {
        lines.push(
          `- Adaptations: ${suite.adaptations.length} adaptations — where reality was reshaped to fit the model:`,
        );
        // Every one of them, never a count alone: "2 adaptations" cannot be
        // told apart from two trivia or from a reshaped draw, and §7A's whole
        // requirement is prose a human can audit.
        for (const a of suite.adaptations) lines.push(`  - ${a}`);
      }
    }
    // B06a T6 — declared since B01 and written by nothing until claims were
    // actually accepted. Both numbers, never a bare percentage: a report that
    // says invites were minted without saying how many a human could use is
    // the silence this task exists to break.
    if (suite.claims !== undefined) {
      lines.push(`- Claims: ${suite.claims.accepted}/${suite.claims.total} invites accepted`);
    }
    // B06a T7 — declared since B01 and written by nothing, for the same
    // reason `claims` was not: until this wave the bench never turned news
    // drafting on, so the product drafted nothing for it to report.
    if (suite.news !== undefined) {
      lines.push(`- News: ${suite.news.published}/${suite.news.drafted} drafted posts published`);
    }
    if (suite.oracles && suite.oracles.length > 0) {
      lines.push("- Oracles:");
      for (const o of suite.oracles) {
        lines.push(`  - ${ORACLE_VERDICT_LABEL[oracleVerdictOf(o)]} ${o.name}${o.detail ? ` — ${o.detail}` : ""}`);
      }
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

function renderUncheckedLines(unchecked: readonly UncheckedConstraintReport[]): string[] {
  if (unchecked.length === 0) {
    return ["- Unchecked constraints: none — every declared constraint was modelled."];
  }
  const lines = [`- Unchecked constraints (${unchecked.length}) — "clean" above does NOT cover these:`];
  for (const u of unchecked) lines.push(`  - \`${u.type}\`: ${u.reason}`);
  return lines;
}

/**
 * T7b — the OPPOSITE direction from `unchecked`: a rule this build DOES
 * model, but which had nothing on THIS board to judge. Its own renderer
 * (rather than folding into `renderUncheckedLines`) because it is reused at
 * BOTH checker call sites below — unlike `unchecked`, which is encode-time
 * and identical for a division's two checker runs, `unexercised` is a
 * per-run fact and rule 7 (officials) is exactly the rule the post-officials
 * re-check (F-T6-2) exists to move from unexercised to exercised.
 */
function renderUnexercisedLines(unexercised: readonly UnexercisedRuleReport[]): string[] {
  if (unexercised.length === 0) {
    return ["- Unexercised rules: none — every modelled rule had something to judge."];
  }
  const lines = [
    `- Unexercised rules (${unexercised.length}) — modelled, but nothing on this board exercised them:`,
  ];
  for (const u of unexercised) lines.push(`  - \`${u.rule}\`: ${u.reason}`);
  return lines;
}

/** Renders one `CheckerVerdictReport`'s `unchecked` AND `unexercised` lists,
 *  together — the primary verdict's own caveats (design §1.4/§3.3, extended
 *  by T7b). The post-officials verdict (F-T6-2) renders `unexercised` alone,
 *  via `renderUnexercisedLines` directly — see that function's own note. */
function renderCheckerCaveats(checker: CheckerVerdictReport): string[] {
  return [...renderUncheckedLines(checker.unchecked), ...renderUnexercisedLines(checker.unexercised)];
}

/**
 * The checker's verdict AND its `unchecked`/`unexercised` lists, in one place.
 *
 * All three are rendered TOGETHER and that is the requirement, not a layout
 * choice (design §1.4/§3.3, extended by T7b): "checker clean" is a claim
 * about the constraints the checker actually modelled AND about the rules
 * that actually had something to judge — a pack can declare knobs it does not
 * model, and a modelled rule can still find nothing because the board gave it
 * no candidates. Printing the verdict without either list lets a reader take
 * "clean" for "every declared constraint was fully verified" — the exact
 * false clean this whole layer exists to prevent. So a division with an empty
 * `unchecked` or an empty `unexercised` says so explicitly rather than
 * rendering silence.
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
    lines.push(...renderCheckerCaveats(checker));
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
      // `unexercised` only, never `unchecked` — see `renderUnexercisedLines`'s
      // own note on why this run's list can legitimately differ from the
      // first one's (rule 7 is exactly the rule this second pass exists to
      // move from unexercised to exercised) while `unchecked` cannot.
      lines.push(...renderUnexercisedLines(after.unexercised));
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
