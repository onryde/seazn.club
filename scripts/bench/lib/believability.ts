// believability.ts — B04's board-quality report. REPORT-ONLY, always.
//
// -------------------------------------------------------------------------
// Nothing in this file may ever red a run
// -------------------------------------------------------------------------
//
// Design §3.5 and `_RULES.md` §1's timings-and-measurements rule: believability
// metrics never gate. Correctness gates in this repo; measurements do not. So
// this module throws for no input — a malformed engine artifact, a board with
// no fixtures, a history row full of nonsense and a `Board` carrying a zone
// `Intl` has never heard of all come back as a REPORT that says what it could
// not do, never as an exception that fails the leg. A gate added here would be
// a change to what the bench asserts, not a hardening of it.
//
// That guarantee is TOTAL, and it is enforced rather than asserted: the two
// computations that can throw are each wrapped, and each reports its own
// reason. See `metricsNote` and `similarityNote`.
//
// It also has to hold ONE INDIRECTION AWAY, and that is where it was first
// broken. A value this module returns is a value `writeReport` will hand to
// `BenchReport.parse`, so a shape this module merely CASTS is a shape that
// throws from someone else's stack frame — at the end of a run, taking
// report.json and report.md with it, including every finding the run had
// already collected. "Never reds a run" therefore means: nothing leaves here
// that the report schema would refuse. `divisionOf` is where that is enforced;
// see its own note for why required and optional fields degrade differently.
//
// -------------------------------------------------------------------------
// Why `assessHealth` is imported as a VALUE, and why the checker may not
// -------------------------------------------------------------------------
//
// Design §2.3 permits exactly this: the believability layer SHARES the
// product's metric arithmetic on purpose, so that a later swap of one for the
// other is a no-op. `checker.ts` may not, because a verifier that recomputed a
// rule with the product's own function would make that rule a tautology. The
// two modules sit on opposite sides of that line deliberately.
//
// The import is from the PINNED subpaths (`@seazn/engine/scheduling/health`
// and `.../tz`) rather than the `@seazn/engine/scheduling` barrel. The barrel
// re-exports `build.ts`, which reaches the gRPC placement client — a pure
// report module has no business loading a solver transport to compute five
// averages, and `health.ts`'s own header insists it is a zero-import leaf.
// Same functions, same arithmetic; strictly less pulled in.
//
// -------------------------------------------------------------------------
// Two absences that are NOT zeroes, and one that is a different SHAPE
// -------------------------------------------------------------------------
//
//  1. `homeAwayAlternation` for a non-round-robin stage. `assessHealth` omits
//     it itself; this module does not add it back. A bracket has no home/away
//     pattern, so "0" would report a fairness failure on a property the stage
//     does not have.
//  2. `similarityToHistorical` when the pack declares no history for this
//     division. 0 would read as "we reproduced none of it", which is a claim
//     about a timetable nobody supplied.
//  3. The engine delta is NOT part of this per-division report at all — it is
//     `assessEngineDelta`, a separate run-level call. See its own note.

import { assessHealth, type HealthConfig, type HealthFixture, type HealthWindow } from "@seazn/engine/scheduling/health";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";

import type { Board, EncodedConstraints } from "./board.ts";
import type { PackHistoricalAssignment } from "./pack-schema.ts";
import type { EngineSnapshot, EngineSnapshotDivision } from "./schedule.ts";

// ---------------------------------------------------------------------------
// This module's vocabulary
// ---------------------------------------------------------------------------

/** One metric as the report carries it — `assessHealth`'s key and score, and
 *  deliberately NOT its offenders or explanation. Those are the product's
 *  panel copy (an i18n key plus params); the bench report prints numbers. */
export interface BelievabilityMetric {
  key: string;
  score: number;
}

/** How much of the REAL tournament's timetable this board reproduced.
 *
 *  The parent spec names this quantity "similarity to historical timetable %"
 *  (`2026-08-12-scheduler-bench-design.md:35,178`, `_PACK-PLAYBOOK.md:34`) — a
 *  claim about WHERE AND WHEN fixtures landed, not about how alike two metric
 *  vectors are. The input is the pack's own `historicalAssignment` rows
 *  (`pack-schema.ts:838-845`, wired at `:1372`), matched to placed fixtures by
 *  `fixtureExtKey`.
 *
 *  Two fractions, because they answer different questions and the strict one
 *  alone would be misleading: putting the final on the right DAY is the
 *  meaningful resemblance, and hitting the exact minute is a bonus. */
export interface TimetableSimilarity {
  /** THE HEADLINE. Fraction of compared fixtures placed on the same calendar
   *  day as history, in the board's own timezone. */
  sameDayPct: number;
  /** The strict bonus. Fraction placed at the same INSTANT. Necessarily less
   *  than or equal to `sameDayPct` — same instant implies same day. */
  sameInstantPct: number;
  /** The denominator, stated rather than implied.
   *
   *  Both percentages are over fixtures that were matched to a historical row
   *  AND placed. Without this number "100%" over a single lucky match reads
   *  exactly like "100%" over a full timetable. */
  comparedFixtures: number;
  /** How many rows the pack declared for this division. `historicalRows`
   *  well above `comparedFixtures` means most of history matched nothing — a
   *  fact about `fixtureExtKey` agreement, not about scheduling quality. */
  historicalRows: number;
}

export interface BelievabilityInput {
  /** The FETCHED board (design §4.1) for one division. */
  board: Board;
  /** That division's encoded oracle. Read for exactly two things: whether the
   *  stage is round-robin (which gates `homeAwayAlternation`) and the declared
   *  session windows (which become `assessHealth`'s per-court-day operating
   *  window). Nothing here is checked against the board — that is
   *  `checker.ts`'s job, and this module has no verdict. */
  constraints: EncodedConstraints;
  /** The pack's `historicalAssignment` rows. Rows naming ANOTHER division are
   *  ignored, so a caller may pass the pack's whole array unfiltered. */
  historicalAssignment?: readonly PackHistoricalAssignment[];
}

export interface BelievabilityReport {
  /** Empty when the metrics could not be computed at all — see `metricsNote`,
   *  which is then present. */
  metrics: readonly BelievabilityMetric[];
  /** Why `metrics` is empty, when it is. Absent on a normal run. */
  metricsNote?: string;
  /** Absent when the pack declared no history for this division. */
  similarityToHistorical?: TimetableSimilarity;
  /** Why `similarityToHistorical` is absent DESPITE history being declared —
   *  the case where rows exist and none of them matched a placed fixture.
   *  Absent when no history was declared at all, because that is the ordinary
   *  state and needs no explanation. */
  similarityNote?: string;
}

const SCORE_RANGE = 100;

// ---------------------------------------------------------------------------
// Board -> HealthFixture
// ---------------------------------------------------------------------------

/** Only PLACED fixtures reach `assessHealth`.
 *
 *  A fixture with no `start` (or no court) has no slot, and every one of the
 *  five metrics measures a slot: a court-day bucket, an inter-match gap, a
 *  prime-slot share. Passing an unplaced one through with a synthesised
 *  instant would put a fabricated slot into an average that is reported as
 *  measured. Unplaced fixtures are `ScheduleOutcome.unplacedCount`'s subject,
 *  not this module's.
 *
 *  `entrantIds[0]` is the home side and `[1]` the away side — the positional
 *  order `schedule.ts:toBoardFixture` builds the array in
 *  (`[home_entrant_id, away_entrant_id]`, filtered for presence).
 *
 *  KNOWN GAP, recorded rather than hidden: that filter drops absent sides
 *  WITHOUT preserving position, so a fixture with exactly one resolved
 *  entrant arrives here indistinguishable from a home-only one and is read as
 *  home. Every metric except `homeAwayAlternation` is side-blind, so this
 *  costs nothing for four of the five; and `homeAwayAlternation` runs only for
 *  round-robin stages, where both sides are always resolved. A half-resolved
 *  fixture is a bracket shape, and brackets omit that metric entirely. */
function toHealthFixtures(board: Board): HealthFixture[] {
  const out: HealthFixture[] = [];
  for (const f of board.fixtures) {
    if (f.start === undefined || f.end === undefined || f.courtId === undefined) continue;
    const home = f.entrantIds[0];
    const away = f.entrantIds[1];
    out.push({
      fixtureId: f.fixtureId,
      court: f.courtId,
      start: f.start,
      end: f.end,
      // Caller-resolved calendar day in the ORGANISER's zone — `health.ts`'s
      // module header makes this the caller's job precisely so the metric
      // module can stay import-free. Reading the day off the epoch instant
      // instead would put a 00:30 BST fixture on the previous day and split
      // one court-day into two single-fixture buckets, which `health.ts`
      // skips — a fragmented board would score a clean 100.
      dayKey: dayKeyInTz(f.start, board.tz),
      ...(home === undefined ? {} : { home }),
      ...(away === undefined ? {} : { away }),
      ...(f.roundNo === undefined ? {} : { roundNo: f.roundNo }),
      ...(f.poolId === undefined ? {} : { poolId: f.poolId }),
      divisionId: f.divisionId,
    });
  }
  return out;
}

/** The per-court-day operating window `gapDispersion` measures idle_edges
 *  against, built from the pack's DECLARED session windows.
 *
 *  Worth supplying rather than leaving to `health.ts`'s fallback: with no
 *  window the fallback measures against the span of the placed fixtures
 *  themselves, which makes idle_edges structurally 0 and therefore frag
 *  exactly 1 for ANY court-day with a hole in it. gapDispersion would collapse
 *  to a binary 100-or-0 and report a lightly-fragmented board as the worst
 *  possible one.
 *
 *  The session windows are division-wide, so every court on a day gets that
 *  day's window — the product declares operating hours per session, not per
 *  court. A day carrying several declared windows is ENVELOPED into
 *  [min from, max to]; a deliberate break between two of them then reads as
 *  inside-idle. That over-reports fragmentation for a split session, and is
 *  accepted here because the metric is report-only and the alternative
 *  (dropping the window) mis-scores every board rather than the split ones.
 *
 *  A day with no declared window is simply left out of the map — `health.ts`
 *  falls back to that court-day's own span, which is its documented default. */
function courtWindowsFor(
  board: Board,
  constraints: EncodedConstraints,
  fixtures: readonly HealthFixture[],
): Record<string, HealthWindow> | undefined {
  if (constraints.sessionWindows.length === 0) return undefined;
  const byDay = new Map<string, HealthWindow>();
  for (const w of constraints.sessionWindows) {
    const day = dayKeyInTz(w.from, board.tz);
    const seen = byDay.get(day);
    byDay.set(
      day,
      seen === undefined ? { from: w.from, to: w.to } : { from: Math.min(seen.from, w.from), to: Math.max(seen.to, w.to) },
    );
  }
  const out: Record<string, HealthWindow> = {};
  for (const f of fixtures) {
    const key = `${f.court}::${f.dayKey}`;
    if (key in out) continue;
    const window = byDay.get(f.dayKey);
    if (window !== undefined) out[key] = window;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Similarity to the historical timetable
// ---------------------------------------------------------------------------

function pct(n: number, d: number): number {
  return Math.round((SCORE_RANGE * n) / d);
}

interface SimilarityResolution {
  similarity?: TimetableSimilarity;
  note?: string;
}

/** Matches this board's placed fixtures to the real tournament's own
 *  assignments by `fixtureExtKey`, and reports how much of the timetable was
 *  reproduced.
 *
 *  `divisionRef` scoping happens HERE rather than at the call site: the pack's
 *  array is competition-wide (`pack-schema.ts:1372`), and comparing a
 *  division's board against another division's history would silently score 0
 *  on rows this board was never going to place. */
function timetableSimilarity(
  board: Board,
  rows: readonly PackHistoricalAssignment[] | undefined,
): SimilarityResolution {
  if (rows === undefined) return {};
  const mine = rows.filter((r) => r.divisionRef === board.divisionRef);
  // No history for THIS division is the ordinary state, and it needs no note:
  // a pack that declares history for one division would otherwise print an
  // explanation on every other division's report.
  if (mine.length === 0) return {};

  const byExtKey = new Map<string, PackHistoricalAssignment>();
  for (const r of mine) {
    if (!byExtKey.has(r.fixtureExtKey)) byExtKey.set(r.fixtureExtKey, r);
  }

  let sameDay = 0;
  let sameInstant = 0;
  let compared = 0;
  for (const f of board.fixtures) {
    // Unplaced fixtures are not comparable: there is no "when" to compare.
    if (f.start === undefined || f.extKey === undefined) continue;
    const row = byExtKey.get(f.extKey);
    if (row === undefined) continue;
    // `startsAt` is `z.iso.datetime({ offset: true })`, so the offset is
    // always present and `Date.parse` is unambiguous — no host-zone reading.
    // Re-checked anyway: this row came off a JSON file.
    const historical = Date.parse(row.startsAt);
    if (!Number.isFinite(historical)) continue;
    compared += 1;
    if (f.start === historical) sameInstant += 1;
    if (dayKeyInTz(f.start, board.tz) === dayKeyInTz(historical, board.tz)) sameDay += 1;
  }

  if (compared === 0) {
    return {
      note:
        `similarity omitted: the pack declares ${mine.length} historical assignment(s) for this division ` +
        `and none of them matched a placed fixture by fixtureExtKey`,
    };
  }
  return {
    similarity: {
      sameDayPct: pct(sameDay, compared),
      sameInstantPct: pct(sameInstant, compared),
      comparedFixtures: compared,
      historicalRows: mine.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The engine delta — a RUN-level fact, deliberately not part of the report
// above
// ---------------------------------------------------------------------------

/** The engine names that become artifact FILENAMES (`engine-<engine>.json`,
 *  `schedule.ts:writeEngineArtifact`) and therefore the keys
 *  `readEngineArtifacts` returns. Exported so a caller and a test name the
 *  same string this module matches on, rather than three copies of a literal
 *  that can drift apart. */
export const GREEDY_ARTIFACT_KEY = "greedy";
export const OPTIMIZED_ARTIFACT_KEY = "optimized";

export interface EngineDelta {
  /** The two legs, echoed whole, so the report can show what was compared
   *  rather than only the difference. */
  greedy: EngineSnapshot;
  optimized: EngineSnapshot;
  /** GREEDY MINUS OPTIMIZED, summed over the divisions both legs scheduled.
   *  Positive is what optimizing BOUGHT — 60 here means the optimizer's boards
   *  finished 60 minutes earlier in total. Negative means it did worse, which
   *  is a legitimate and interesting result, so the sign is kept rather than
   *  reported as a magnitude. */
  makespanDeltaMinutes: number;
  /** Same convention and same sign: greedy minus optimized. */
  courtImbalanceDeltaMinutes: number;
  /** Exactly which divisions the two sums cover, in the greedy leg's own
   *  order.
   *
   *  Carried because the sums cannot speak for themselves: a run where the two
   *  legs share NO division produces `0` and `0`, which reads identically to
   *  "the two engines tied". This list is what tells those apart, and an empty
   *  one is the report saying it compared nothing. */
  comparedDivisionRefs: readonly string[];
}

export interface EngineDeltaReport {
  delta?: EngineDelta;
  /** Why `delta` is absent, when it is — the explicit statement that keeps
   *  "only greedy ran" from looking like "the engines tied". Report copy,
   *  never a gate, and absent whenever the delta itself is present. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A number this snapshot can carry all the way into `report.json`.
 *
 *  `NaN` and the infinities are `typeof "number"` and `JSON.stringify`s them
 *  to `null`, so a snapshot holding one is not round-trippable even when it
 *  type-checks. The same test `metricMinutes` applies, for the same reason. */
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type SolverMode = NonNullable<EngineSnapshotDivision["mode"]>;
type SnapshotMetrics = NonNullable<EngineSnapshotDivision["metrics"]>;
type SnapshotVerdict = NonNullable<EngineSnapshotDivision["verdict"]>;

/** The solver modes `schedule.ts` declares, as a lookup.
 *
 *  A `Record<SolverMode, true>` rather than an array of the same three
 *  strings, because the object literal is checked BOTH ways: a mode added to
 *  `EngineSnapshotDivision` reds this line as a missing property, and one
 *  removed there reds it as an excess one. An array would silently drift, and
 *  a drifted list here does not throw — it makes a legitimate mode vanish from
 *  the report, which is the harder failure to notice. */
const SOLVER_MODES: Readonly<Record<SolverMode, true>> = { build: true, reflow: true, polish: true };

function modeOf(value: unknown): SolverMode | undefined {
  // `Object.hasOwn`, not `in`: `"toString" in SOLVER_MODES` is true.
  return typeof value === "string" && Object.hasOwn(SOLVER_MODES, value) ? (value as SolverMode) : undefined;
}

/** The five numbers `ScheduleMetricsOut` declares, rebuilt rather than cast.
 *
 *  Destructured on purpose: `tsc` reds here if the metrics type gains a
 *  required field, which is the only mechanism that keeps this narrowing in
 *  step with the type it claims to produce. */
function metricsOf(value: unknown): SnapshotMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const { makespanMinutes, worstIdleGapMinutes, courtImbalanceMinutes, placed, total } = value;
  if (!finiteNumber(makespanMinutes)) return undefined;
  if (!finiteNumber(worstIdleGapMinutes)) return undefined;
  if (!finiteNumber(courtImbalanceMinutes)) return undefined;
  if (!finiteNumber(placed)) return undefined;
  if (!finiteNumber(total)) return undefined;
  return { makespanMinutes, worstIdleGapMinutes, courtImbalanceMinutes, placed, total };
}

function verdictOf(value: unknown): SnapshotVerdict | undefined {
  if (!isRecord(value)) return undefined;
  const { red, reasons } = value;
  if (typeof red !== "boolean") return undefined;
  if (!Array.isArray(reasons)) return undefined;
  const out: string[] = [];
  for (const reason of reasons) {
    if (typeof reason !== "string") return undefined;
    out.push(reason);
  }
  return { red, reasons: out };
}

/** Narrows ONE division row off an artifact, rebuilding it field by field.
 *
 *  This function is the whole of Finding 2's fix, and the reason it is worth a
 *  function of its own is that the two kinds of field must degrade
 *  DIFFERENTLY:
 *
 *   * A REQUIRED number that is missing or is not finite (`blockingCount`,
 *     `unplacedCount`, `wallMs` — non-optional both here and in `report.ts`'s
 *     `EngineSnapshotReport`) cannot be supplied or omitted, so the row is
 *     rejected, which rejects the artifact, which the caller REPORTS. That is
 *     the only honest answer: the report schema would refuse it downstream,
 *     and refusing it downstream means throwing out of `writeReport` at the
 *     end of a run and losing report.json and report.md for the whole bench —
 *     every finding already collected, destroyed by one stale file.
 *   * A malformed OPTIONAL field is DROPPED and the row kept. Refusing a whole
 *     two-leg comparison because one `solverStatus` came back as a number
 *     would be the over-refusing guard that silently deletes the run's
 *     headline measurement. Report-only means report what can be reported.
 *
 *  Nothing is cast through: an unknown key is not carried, so no unvalidated
 *  value can reach the report by riding along inside a row. The cost is that a
 *  field ADDED to `EngineSnapshotDivision` as optional would be dropped here
 *  until it is added below — a required one reds `tsc` on the return
 *  statement, an optional one is caught by the round-trip test in the suite. */
function divisionOf(value: unknown): EngineSnapshotDivision | undefined {
  if (!isRecord(value)) return undefined;
  const { divisionRef, blockingCount, unplacedCount, wallMs } = value;
  if (typeof divisionRef !== "string" || divisionRef.length === 0) return undefined;
  if (!finiteNumber(blockingCount)) return undefined;
  if (!finiteNumber(unplacedCount)) return undefined;
  if (!finiteNumber(wallMs)) return undefined;

  const metrics = metricsOf(value.metrics);
  const mode = modeOf(value.mode);
  const verdict = verdictOf(value.verdict);
  const { solverStatus, notSearchedReason, budgetExpired, tiersCompleted, tiersTotal, actualEngine } = value;

  return {
    divisionRef,
    blockingCount,
    unplacedCount,
    wallMs,
    // T7d: THIS division's own engine, separate from the leg-level `engine`
    // `asSnapshot` reads below — the two can legitimately disagree.
    ...(actualEngine === "greedy" || actualEngine === "optimized" ? { actualEngine } : {}),
    ...(metrics === undefined ? {} : { metrics }),
    ...(typeof solverStatus === "string" ? { solverStatus } : {}),
    ...(typeof notSearchedReason === "string" ? { notSearchedReason } : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(typeof budgetExpired === "boolean" ? { budgetExpired } : {}),
    ...(finiteNumber(tiersCompleted) ? { tiersCompleted } : {}),
    ...(finiteNumber(tiersTotal) ? { tiersTotal } : {}),
    ...(verdict === undefined ? {} : { verdict }),
  };
}

/** Narrows one artifact read off disk.
 *
 *  `readEngineArtifacts` returns `unknown` per file — it parses JSON and makes
 *  no shape claim. Everything the delta depends on is checked here rather than
 *  asserted with a cast, because the two numbers this module subtracts decide
 *  what the report says the optimizer bought. Returns `undefined` rather than
 *  throwing: an unreadable artifact is a thing to REPORT, not a thing to fail
 *  the run over.
 *
 *  `requestedEngine` is a THREE-member set and `"both"` is the member a real
 *  run never writes: `tiny.ts` puts the CLI's own `--engine` into the artifact
 *  and a comparison is assembled from two separate single-engine runs, so a
 *  live delta reads `"greedy"` and `"optimized"`. Narrowing this guard would
 *  turn every real two-leg run's delta into "not a readable EngineSnapshot" —
 *  silently deleting design §2.1's headline run-level measurement — which is
 *  why the suite reads all three members back rather than only the one the
 *  fixtures found convenient.
 *
 *  `engine` (the leg-level summary) is OPTIONAL, unlike `requestedEngine`
 *  (T7d): it is absent exactly when the leg's own divisions disagreed about
 *  which engine actually ran, which is a real, legitimate shape and not a
 *  malformed artifact. When PRESENT it is still validated against the closed
 *  two-member set — a stray third value is still rejected. */
function asSnapshot(value: unknown): EngineSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { runId, requestedEngine, engine, divisions } = value;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  if (requestedEngine !== "optimized" && requestedEngine !== "greedy" && requestedEngine !== "both") return undefined;
  if (engine !== undefined && engine !== "greedy" && engine !== "optimized") return undefined;
  if (!Array.isArray(divisions)) return undefined;
  const out: EngineSnapshotDivision[] = [];
  for (const d of divisions) {
    const division = divisionOf(d);
    if (division === undefined) return undefined;
    out.push(division);
  }
  return { runId, requestedEngine, ...(engine === undefined ? {} : { engine }), divisions: out };
}

/** One metric field off a snapshot division, re-checked at the point of use.
 *
 *  `EngineSnapshotDivision.metrics` is typed, but this object came from JSON on
 *  disk, so the type is a claim about the writer rather than about the bytes. A
 *  `null` or a string here would otherwise turn a subtraction into `NaN` and
 *  the report would print a delta of `NaN` minutes. */
function metricMinutes(
  division: EngineSnapshotDivision,
  field: "makespanMinutes" | "courtImbalanceMinutes",
): number | undefined {
  const metrics: unknown = division.metrics;
  if (!isRecord(metrics)) return undefined;
  const value = metrics[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface DeltaSums {
  makespan: number;
  courtImbalance: number;
  refs: string[];
}

/** Sums greedy MINUS optimized over the divisions both legs scheduled.
 *
 *  KEYED BY `divisionRef`, NEVER BY INDEX — `schedule.ts`'s own rule for the
 *  same reason it states there: a division that failed before its board was
 *  fetched contributes no snapshot entry, so the two legs' arrays are not
 *  index-aligned and a leg may simply be shorter.
 *
 *  A division is compared only when BOTH legs reported BOTH numbers. Dropping
 *  it from both sums (rather than treating a missing number as 0) is what
 *  keeps the two totals describing the same set of divisions —
 *  `comparedDivisionRefs` then says which set that was. */
function sumDelta(greedy: EngineSnapshot, optimized: EngineSnapshot): DeltaSums {
  const optimizedByRef = new Map<string, EngineSnapshotDivision>();
  for (const d of optimized.divisions) {
    if (!optimizedByRef.has(d.divisionRef)) optimizedByRef.set(d.divisionRef, d);
  }
  let makespan = 0;
  let courtImbalance = 0;
  const refs: string[] = [];
  for (const g of greedy.divisions) {
    const o = optimizedByRef.get(g.divisionRef);
    if (o === undefined) continue;
    const greedyMakespan = metricMinutes(g, "makespanMinutes");
    const optimizedMakespan = metricMinutes(o, "makespanMinutes");
    const greedyImbalance = metricMinutes(g, "courtImbalanceMinutes");
    const optimizedImbalance = metricMinutes(o, "courtImbalanceMinutes");
    if (
      greedyMakespan === undefined ||
      optimizedMakespan === undefined ||
      greedyImbalance === undefined ||
      optimizedImbalance === undefined
    ) {
      continue;
    }
    makespan += greedyMakespan - optimizedMakespan;
    courtImbalance += greedyImbalance - optimizedImbalance;
    refs.push(g.divisionRef);
  }
  return { makespan, courtImbalance, refs };
}

const NO_ARTIFACTS_NOTE =
  "engine delta omitted: no engine artifact was read for this run, so there is nothing to compare";

/** The greedy-vs-optimized comparison for the WHOLE RUN.
 *
 *  A separate top-level call rather than a field on `BelievabilityReport`,
 *  because it is a run-level fact and that report is per-division. T6 calls
 *  `assessBelievability` once per division (its step 3) and renders
 *  believability and the engine delta as two separate report sections (its
 *  step 6); a delta carried on the per-division report would be emitted N
 *  times, each copy listing every OTHER division's refs in
 *  `comparedDivisionRefs`. Scoping the sums to one division instead would
 *  destroy the run-level total that design §2.1 actually asks for.
 *
 *  Call it ONCE, after the division loop, with `readEngineArtifacts`' return.
 *
 *  The delta is assembled from two separate RUNS, not two calls: design §2.1 —
 *  `AutoScheduleRequest` carries no engine field, nothing selects an engine,
 *  and the product always attempts the solver and falls back to greedy on
 *  capacity or an unreachable placement service. One leg is not a comparison,
 *  and a partial one rendered as a comparison is worse than none. */
export function assessEngineDelta(artifacts: Readonly<Record<string, unknown>> | undefined): EngineDeltaReport {
  if (artifacts === undefined) return { note: NO_ARTIFACTS_NOTE };

  const rawGreedy = artifacts[GREEDY_ARTIFACT_KEY];
  const rawOptimized = artifacts[OPTIMIZED_ARTIFACT_KEY];
  const greedy = rawGreedy === undefined ? undefined : asSnapshot(rawGreedy);
  const optimized = rawOptimized === undefined ? undefined : asSnapshot(rawOptimized);

  // A file that IS there but does not parse into a snapshot is a different
  // state from one that is absent, and it is the more alarming of the two — a
  // truncated artifact silently treated as "that leg never ran" would render a
  // two-leg run as a one-leg run.
  if (rawGreedy !== undefined && greedy === undefined) {
    return {
      note: `engine delta omitted: the ${GREEDY_ARTIFACT_KEY} artifact is not a readable EngineSnapshot`,
    };
  }
  if (rawOptimized !== undefined && optimized === undefined) {
    return {
      note: `engine delta omitted: the ${OPTIMIZED_ARTIFACT_KEY} artifact is not a readable EngineSnapshot`,
    };
  }

  if (greedy === undefined && optimized === undefined) return { note: NO_ARTIFACTS_NOTE };
  if (optimized === undefined) {
    return {
      note: `engine delta omitted: only the ${GREEDY_ARTIFACT_KEY} leg has an artifact for this run — one leg is not a comparison`,
    };
  }
  if (greedy === undefined) {
    return {
      note: `engine delta omitted: only the ${OPTIMIZED_ARTIFACT_KEY} leg has an artifact for this run — one leg is not a comparison`,
    };
  }

  // Which leg is which decides the SIGN of everything below, and the filename
  // is the only thing that has claimed it so far. `AutoScheduleResult.solver
  // .engine` is what actually ran, so if the two disagree the pairing is not
  // trustworthy — two greedy legs filed one per name would be subtracted from
  // each other and printed as the optimizer's gain.
  if (greedy.engine !== GREEDY_ARTIFACT_KEY || optimized.engine !== OPTIMIZED_ARTIFACT_KEY) {
    return {
      note:
        `engine delta omitted: an artifact's own engine field disagrees with the file it was read from ` +
        `(engine-${GREEDY_ARTIFACT_KEY}.json reports "${greedy.engine}", ` +
        `engine-${OPTIMIZED_ARTIFACT_KEY}.json reports "${optimized.engine}")`,
    };
  }

  // `runId` is the git SHA, which is what puts two legs of one commit in one
  // directory. Two different ids in one comparison means two different trees,
  // and the difference between them is not the engine.
  if (greedy.runId !== optimized.runId) {
    return {
      note:
        `engine delta omitted: the two legs carry different runIds ` +
        `("${greedy.runId}" vs "${optimized.runId}"), so they are not two legs of one commit`,
    };
  }

  const sums = sumDelta(greedy, optimized);
  return {
    delta: {
      greedy,
      optimized,
      makespanDeltaMinutes: sums.makespan,
      courtImbalanceDeltaMinutes: sums.courtImbalance,
      comparedDivisionRefs: sums.refs,
    },
  };
}

// ---------------------------------------------------------------------------
// assessBelievability
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Measures one division's fetched board.
 *
 *  Pure and TOTAL: no HTTP, no DB, no clock, no filesystem, and no throw for
 *  any input. Same inputs, same report.
 *
 *  The two `try` blocks are the whole of that "no throw" guarantee, and they
 *  exist for one reachable cause: `dayKeyInTz` builds an
 *  `Intl.DateTimeFormat` from `board.tz` (`tz.ts:57-70`), which raises
 *  `RangeError` for any string that is not a recognised IANA zone. A `Board`
 *  carries whatever zone the division was configured with, so a typo'd zone in
 *  a pack would otherwise take a whole bench run down from the one module that
 *  is specified never to fail one. Degraded to an empty metric list plus the
 *  reason, which is the reportable form of the same fact. */
export function assessBelievability(input: BelievabilityInput): BelievabilityReport {
  // Deliberately NOT initialised: the empty list belongs to the catch, where
  // it is the reported value. Initialising here would make that assignment
  // dead code (the `try` never completes its own assignment when it throws),
  // and dead code in a degrade path is how a degrade path stops working
  // without anything noticing.
  let metrics: BelievabilityMetric[];
  let metricsNote: string | undefined;
  try {
    const fixtures = toHealthFixtures(input.board);
    const courtWindows = courtWindowsFor(input.board, input.constraints, fixtures);
    const config: HealthConfig = {
      // The pack's declaration, forwarded — never re-derived from the board.
      // Nothing on a `Board` can tell a round-robin stage from a bracket, and a
      // guess here would decide whether a fairness metric is reported at all.
      isRoundRobin: input.constraints.isRoundRobin,
      ...(courtWindows === undefined ? {} : { courtWindows }),
    };
    metrics = assessHealth(fixtures, config).metrics.map((m) => ({ key: m.key, score: m.score }));
  } catch (err) {
    metrics = [];
    metricsNote =
      `metrics unavailable: this board could not be bucketed by calendar day in timezone ` +
      `"${input.board.tz}" (${messageOf(err)})`;
  }

  let similarity: SimilarityResolution;
  try {
    similarity = timetableSimilarity(input.board, input.historicalAssignment);
  } catch (err) {
    similarity = {
      note:
        `similarity unavailable: historical assignments could not be compared in timezone ` +
        `"${input.board.tz}" (${messageOf(err)})`,
    };
  }

  return {
    metrics,
    ...(metricsNote === undefined ? {} : { metricsNote }),
    ...(similarity.similarity === undefined ? {} : { similarityToHistorical: similarity.similarity }),
    ...(similarity.note === undefined ? {} : { similarityNote: similarity.note }),
  };
}
