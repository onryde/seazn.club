// believability.ts — B04's board-quality report. REPORT-ONLY, always.
//
// -------------------------------------------------------------------------
// Nothing in this file may ever red a run
// -------------------------------------------------------------------------
//
// Design §3.5 and `_RULES.md` §1's timings-and-measurements rule: believability
// metrics never gate. Correctness gates in this repo; measurements do not. So
// this module throws for no input — a malformed engine artifact, a board with
// no fixtures and a history row full of nonsense all come back as a REPORT
// that says what it could not do, never as an exception that fails the leg.
// A gate added here would be a change to what the bench asserts, not a
// hardening of it.
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
// Three absences that are NOT zeroes
// -------------------------------------------------------------------------
//
// Each of these was specified as an absence because the zero would be a false
// CLAIM rather than a missing measurement:
//
//  1. `homeAwayAlternation` for a non-round-robin stage. `assessHealth` omits
//     it itself; this module does not add it back. A bracket has no home/away
//     pattern, so "0" would report a fairness failure on a property the stage
//     does not have.
//  2. `engineDelta` when only one leg ran. The delta is assembled from two
//     separate RUNS (design §2.1 — `AutoScheduleRequest` carries no engine
//     field, nothing selects an engine, and the product always attempts the
//     solver and falls back to greedy on capacity or an unreachable placement
//     service). One leg is not a comparison, and a partial one rendered as a
//     comparison is worse than none. `engineDeltaNote` says which leg was
//     there, so the absence is legible rather than silent.
//  3. `similarityToHistoricalPct` without history. 0 reads as "completely
//     dissimilar", which is an assertion about a corpus that does not exist.

import { assessHealth, type HealthConfig, type HealthFixture, type HealthWindow } from "@seazn/engine/scheduling/health";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";

import type { Board, EncodedConstraints } from "./board.ts";
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

/** One previously-accepted board's metric scores.
 *
 *  History is supplied by the CALLER and is not produced anywhere yet — no
 *  corpus of accepted boards exists in this repo. The shape is the report's
 *  own metric vector so that yesterday's report is directly usable as
 *  tomorrow's history, with no adapter and no second definition of what a
 *  "historical board" is. */
export interface BelievabilityHistory {
  metrics: readonly BelievabilityMetric[];
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
  /** `readEngineArtifacts(reportDir, runId)`'s return, keyed by the engine in
   *  each filename. Absent when the caller did not read the run directory. */
  engineArtifacts?: Readonly<Record<string, unknown>>;
  history?: readonly BelievabilityHistory[];
}

export interface BelievabilityReport {
  metrics: readonly BelievabilityMetric[];
  /** Present ONLY when both legs' artifacts were read and agree about which
   *  run and which engine each is. */
  engineDelta?: EngineDelta;
  /** Why `engineDelta` is absent, when it is — the explicit statement that
   *  keeps "only greedy ran" from looking like "the engines tied". Report
   *  copy, never a gate, and absent whenever the delta itself is present. */
  engineDeltaNote?: string;
  similarityToHistoricalPct?: number;
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
// The engine delta
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows one artifact read off disk.
 *
 *  `readEngineArtifacts` returns `unknown` per file — it parses JSON and makes
 *  no shape claim. Everything the delta depends on is checked here rather than
 *  asserted with a cast, because the two numbers this module subtracts decide
 *  what the report says the optimizer bought. Returns `undefined` rather than
 *  throwing: an unreadable artifact is a thing to REPORT, not a thing to fail
 *  the run over. */
function asSnapshot(value: unknown): EngineSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { runId, requestedEngine, engine, divisions } = value;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  if (requestedEngine !== "optimized" && requestedEngine !== "greedy" && requestedEngine !== "both") return undefined;
  if (engine !== "greedy" && engine !== "optimized") return undefined;
  if (!Array.isArray(divisions)) return undefined;
  const out: EngineSnapshotDivision[] = [];
  for (const d of divisions) {
    if (!isRecord(d)) return undefined;
    if (typeof d.divisionRef !== "string" || d.divisionRef.length === 0) return undefined;
    out.push(d as unknown as EngineSnapshotDivision);
  }
  return { runId, requestedEngine, engine, divisions: out };
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

interface DeltaResolution {
  delta?: EngineDelta;
  note?: string;
}

const NO_ARTIFACTS_NOTE =
  "engine delta omitted: no engine artifact was read for this run, so there is nothing to compare";

/** Decides whether a delta may be emitted at all, and says why when it may
 *  not. Every refusal below is a DIFFERENT fact about the run, so each gets
 *  its own note rather than one shared "unavailable". */
function resolveDelta(artifacts: Readonly<Record<string, unknown>> | undefined): DeltaResolution {
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
// Similarity to historical
// ---------------------------------------------------------------------------

/** How close this board's metric vector sits to the mean of the historical
 *  ones, as a percentage: 100 minus the mean absolute per-metric difference,
 *  expressed against the metrics' own 0-100 range.
 *
 *  Only keys THIS board scored are compared. A history row carrying
 *  `homeAwayAlternation` for a board whose stage is a bracket describes a
 *  property this board does not have, and averaging it in would move a number
 *  that is supposed to describe this board.
 *
 *  `undefined` — never 0 — when there is no history, when it is empty, or when
 *  it shares no key with this board. */
function similarityPct(
  current: readonly BelievabilityMetric[],
  history: readonly BelievabilityHistory[] | undefined,
): number | undefined {
  if (history === undefined || history.length === 0) return undefined;

  const byKey = new Map<string, { total: number; n: number }>();
  for (const observation of history) {
    for (const m of observation.metrics) {
      if (typeof m.score !== "number" || !Number.isFinite(m.score)) continue;
      const acc = byKey.get(m.key);
      if (acc === undefined) byKey.set(m.key, { total: m.score, n: 1 });
      else {
        acc.total += m.score;
        acc.n += 1;
      }
    }
  }

  const diffs: number[] = [];
  for (const m of current) {
    const acc = byKey.get(m.key);
    if (acc === undefined || acc.n === 0) continue;
    diffs.push(Math.abs(m.score - acc.total / acc.n) / SCORE_RANGE);
  }
  if (diffs.length === 0) return undefined;

  const meanDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const pct = SCORE_RANGE * (1 - meanDiff);
  return Math.round(Math.max(0, Math.min(SCORE_RANGE, pct)));
}

// ---------------------------------------------------------------------------
// assessBelievability
// ---------------------------------------------------------------------------

/** Measures one division's fetched board and, where both legs of the run left
 *  an artifact, reports what the optimizer bought.
 *
 *  Pure and total: no HTTP, no DB, no clock, no filesystem (the caller reads
 *  the artifacts and hands them in), and no throw. Same inputs, same report. */
export function assessBelievability(input: BelievabilityInput): BelievabilityReport {
  const fixtures = toHealthFixtures(input.board);
  const courtWindows = courtWindowsFor(input.board, input.constraints, fixtures);
  const config: HealthConfig = {
    // The pack's declaration, forwarded — never re-derived from the board.
    // Nothing on a `Board` can tell a round-robin stage from a bracket, and a
    // guess here would decide whether a fairness metric is reported at all.
    isRoundRobin: input.constraints.isRoundRobin,
    ...(courtWindows === undefined ? {} : { courtWindows }),
  };

  const metrics: BelievabilityMetric[] = assessHealth(fixtures, config).metrics.map((m) => ({
    key: m.key,
    score: m.score,
  }));

  const { delta, note } = resolveDelta(input.engineArtifacts);
  const similarity = similarityPct(metrics, input.history);

  return {
    metrics,
    ...(delta === undefined ? {} : { engineDelta: delta }),
    ...(note === undefined ? {} : { engineDeltaNote: note }),
    ...(similarity === undefined ? {} : { similarityToHistoricalPct: similarity }),
  };
}
