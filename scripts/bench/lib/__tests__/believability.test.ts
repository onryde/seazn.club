// believability.test.ts — T5's suite.
//
// EVERY assertion here is on a REPORT-ONLY value. Nothing in believability.ts
// may red a run (design §3.5, `_RULES.md` §1's timings-and-measurements rule),
// so this file never asserts a throw as a desired behaviour — it asserts the
// opposite, that hostile input still returns a report.
//
// Two habits this suite keeps, both bought the hard way in this programme:
//
//  * Scores are pinned to HAND-COMPUTED values on purpose-built boards, never
//    to a second call of `assessHealth` from inside the test. Folding the same
//    mapping through the same function on both sides proves the fixture, not
//    the mapping (failure class 1).
//  * The metric KEY SET is derived from `assessHealth`'s own output rather than
//    typed in, so an engine-side rename moves this suite instead of leaving it
//    asserting yesterday's names (recurring failure class 19).

import { describe, expect, it } from "vitest";

import { assessHealth } from "@seazn/engine/scheduling/health";

import type { Board, BoardFixture, EncodedConstraints } from "../board.ts";
import type { ActualEngine, EngineSnapshot } from "../schedule.ts";
import {
  assessBelievability,
  GREEDY_ARTIFACT_KEY,
  OPTIMIZED_ARTIFACT_KEY,
  type BelievabilityHistory,
  type BelievabilityMetric,
  type BelievabilityReport,
} from "../believability.ts";
import { at, cleanConstraints, DIVISION_ID, DIVISION_REF, MON, TZ } from "./_board-fixtures.ts";

// ---------------------------------------------------------------------------
// The engine's own vocabulary, read from the engine
// ---------------------------------------------------------------------------

/** `assessHealth`'s metric keys, IN ITS OWN ORDER, for each gating. Derived,
 *  never typed: a rename in `health.ts` moves these with it. */
const RR_KEYS = assessHealth([], { isRoundRobin: true }).metrics.map((m) => m.key);
const NON_RR_KEYS = assessHealth([], { isRoundRobin: false }).metrics.map((m) => m.key);

const HOME_AWAY = "homeAwayAlternation";
const GAP_DISPERSION = "gapDispersion";
const COURT_BALANCE = "courtBalance";
const PRIME_SLOT = "primeSlotFairness";

const COURT_1 = "court-1";
const COURT_2 = "court-2";
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function fixtureOf(over: Partial<BoardFixture> & { fixtureId: string }): BoardFixture {
  return {
    divisionId: DIVISION_ID,
    divisionRef: DIVISION_REF,
    entrantIds: [],
    personIds: [],
    officialIds: [],
    locked: false,
    ...over,
  };
}

/** One placed fixture. `entrants[0]` is the HOME side and `entrants[1]` the
 *  away side — the positional convention `schedule.ts:toBoardFixture` builds
 *  `entrantIds` with (`[home_entrant_id, away_entrant_id]`). */
function placed(
  fixtureId: string,
  courtId: string,
  hhmm: string,
  entrants: readonly string[] = [],
  minutes = 30,
  ymd: string = MON,
): BoardFixture {
  const start = at(ymd, hhmm);
  return fixtureOf({ fixtureId, courtId, start, end: start + minutes * MINUTE_MS, entrantIds: entrants });
}

function boardOf(fixtures: readonly BoardFixture[]): Board {
  return { divisionId: DIVISION_ID, divisionRef: DIVISION_REF, tz: TZ, fixtures, courts: [] };
}

/** `cleanConstraints()` with NO session windows by default, so a test that
 *  cares about the operating window has to say so — otherwise the window would
 *  silently move `gapDispersion` in every case that never mentions it. */
function constraintsOf(over: Partial<EncodedConstraints> = {}): EncodedConstraints {
  return { ...cleanConstraints(), sessionWindows: [], ...over };
}

function scoreOf(report: BelievabilityReport, key: string): number | undefined {
  return report.metrics.find((m) => m.key === key)?.score;
}

function snapshot(
  engine: ActualEngine,
  divisions: readonly { ref: string; makespan?: number; imbalance?: number }[],
  runId = "sha-aaaa",
): EngineSnapshot {
  return {
    runId,
    requestedEngine: "both",
    engine,
    divisions: divisions.map((d) => ({
      divisionRef: d.ref,
      ...(d.makespan === undefined || d.imbalance === undefined
        ? {}
        : {
            metrics: {
              makespanMinutes: d.makespan,
              worstIdleGapMinutes: 0,
              courtImbalanceMinutes: d.imbalance,
              placed: 1,
              total: 1,
            },
          }),
      blockingCount: 0,
      unplacedCount: 0,
      wallMs: 1,
    })),
  };
}

function shifted(metrics: readonly BelievabilityMetric[], by: number): BelievabilityHistory {
  return { metrics: metrics.map((m) => ({ key: m.key, score: m.score + by })) };
}

// ---------------------------------------------------------------------------
// The boards, each built for exactly one hand-computed number
// ---------------------------------------------------------------------------

/** court-1, one day, two 30-minute fixtures with a 30-minute hole between
 *  them: 09:00-09:30 and 10:00-10:30. */
function twoWithAHole(): Board {
  return boardOf([placed("fx-a", COURT_1, "09:00", ["e-a", "e-b"]), placed("fx-b", COURT_1, "10:00", ["e-c", "e-d"])]);
}

/** Four fixtures in ONE court-day bucket.
 *
 *  `twoWithAHole` cannot witness a mapping leak and this can. With two
 *  fixtures in a bucket, `PRIME_N` (2) makes EVERY fixture prime and every
 *  entrant's expected prime share equal to its actual one, so a stray fixture
 *  leaking into the mapping moves no metric at all and an exclusion probe
 *  built on it passes whether the exclusion happens or not. Four fixtures make
 *  the prime set strictly smaller than the board, which is what gives
 *  `primeSlotFairness` something to move.
 *
 *  Both survivors of this suite's first mutation sweep lived here. */
function fourOnOneCourtDay(): Board {
  return boardOf([
    placed("fx-1", COURT_1, "09:00", ["e-a", "e-b"]),
    placed("fx-2", COURT_1, "10:00", ["e-a", "e-c"]),
    placed("fx-3", COURT_1, "11:00", ["e-a", "e-d"]),
    placed("fx-4", COURT_1, "12:00", ["e-b", "e-c"]),
  ]);
}

describe("assessBelievability — metrics come from assessHealth", () => {
  it("carries assessHealth's metric keys, in the engine's own order", () => {
    const report = assessBelievability({
      board: twoWithAHole(),
      constraints: constraintsOf({ isRoundRobin: true }),
    });
    expect(report.metrics.map((m) => m.key)).toEqual(RR_KEYS);
  });

  it("scores gapDispersion 0 for a hole that fills the whole measured span", () => {
    // No session window, so `health.ts` falls back to the span of the placed
    // fixtures: window 09:00-10:30 (90m), busy 60m, idle_inside 30m,
    // idle_edges 0 => frag 30/30 = 1 => score 0.
    const report = assessBelievability({ board: twoWithAHole(), constraints: constraintsOf() });
    expect(scoreOf(report, GAP_DISPERSION)).toBe(0);
  });

  it("scores gapDispersion 95 for the SAME board once the session window is declared", () => {
    // The identical board with a declared 09:00-20:00 window: 660m window,
    // 60m busy, 30m inside, 570m at the edges => frag 30/600 = 0.05 => 95.
    // The differential is the point — 0 vs 95 on one board is what proves
    // `courtWindows` is built from the pack's sessionWindows and actually
    // reaches `assessHealth`, rather than being dropped on the floor.
    const report = assessBelievability({
      board: twoWithAHole(),
      constraints: constraintsOf({ sessionWindows: [{ from: at(MON, "09:00"), to: at(MON, "20:00") }] }),
    });
    expect(scoreOf(report, GAP_DISPERSION)).toBe(95);
  });

  it("envelopes a day's SEVERAL declared session windows into one operating window", () => {
    // The same board again, with the day split into 09:00-12:00 and
    // 13:00-20:00. The envelope is 09:00-20:00, so the score is the 95 above.
    // An implementation that kept only the first window would measure against
    // 180 minutes instead of 660 - frag 30/120 = 0.25 => 75 - so this case is
    // what stops "the first window on the day" from passing as "the day".
    const report = assessBelievability({
      board: twoWithAHole(),
      constraints: constraintsOf({
        sessionWindows: [
          { from: at(MON, "09:00"), to: at(MON, "12:00") },
          { from: at(MON, "13:00"), to: at(MON, "20:00") },
        ],
      }),
    });
    expect(scoreOf(report, GAP_DISPERSION)).toBe(95);
  });

  it("scores courtBalance 100 when an entrant's four fixtures split evenly across two courts", () => {
    const board = boardOf([
      placed("fx-1", COURT_1, "09:00", ["e-a", "e-b"]),
      placed("fx-2", COURT_2, "10:00", ["e-a", "e-c"]),
      placed("fx-3", COURT_1, "11:00", ["e-a", "e-d"]),
      placed("fx-4", COURT_2, "12:00", ["e-a", "e-e"]),
    ]);
    const report = assessBelievability({ board, constraints: constraintsOf() });
    expect(scoreOf(report, COURT_BALANCE)).toBe(100);
  });

  it("scores courtBalance 0 when the same four fixtures all land on one court", () => {
    // `fx-5` exists only to make the board's distinct-court count 2, so
    // `health.ts`'s "nowhere to spread" branch (H_max === 0 => full marks)
    // is NOT the branch under test here.
    const board = boardOf([
      placed("fx-1", COURT_1, "09:00", ["e-a", "e-b"]),
      placed("fx-2", COURT_1, "10:00", ["e-a", "e-c"]),
      placed("fx-3", COURT_1, "11:00", ["e-a", "e-d"]),
      placed("fx-4", COURT_1, "12:00", ["e-a", "e-e"]),
      placed("fx-5", COURT_2, "09:00", ["e-f", "e-g"]),
    ]);
    const report = assessBelievability({ board, constraints: constraintsOf() });
    expect(scoreOf(report, COURT_BALANCE)).toBe(0);
  });
});

describe("assessBelievability — homeAwayAlternation is OMITTED, never scored zero", () => {
  it("names homeAwayAlternation among the engine's round-robin keys", () => {
    // Vacuity guard for the two assertions below: if the engine ever renames
    // this metric, `some(...) === false` would pass for the wrong reason.
    expect(RR_KEYS).toContain(HOME_AWAY);
    expect(NON_RR_KEYS).not.toContain(HOME_AWAY);
  });

  it("omits homeAwayAlternation entirely for a non-round-robin stage", () => {
    const report = assessBelievability({
      board: twoWithAHole(),
      constraints: constraintsOf({ isRoundRobin: false }),
    });
    expect(report.metrics.some((m) => m.key === HOME_AWAY)).toBe(false);
    expect(scoreOf(report, HOME_AWAY)).toBeUndefined();
    expect(report.metrics).toHaveLength(NON_RR_KEYS.length);
  });

  it("includes homeAwayAlternation for a round-robin stage — the positive pair", () => {
    const report = assessBelievability({
      board: twoWithAHole(),
      constraints: constraintsOf({ isRoundRobin: true }),
    });
    expect(report.metrics.some((m) => m.key === HOME_AWAY)).toBe(true);
    expect(report.metrics).toHaveLength(RR_KEYS.length);
  });

  it("reads entrantIds[0] as the home side — a fixed-home board scores 25, an alternating one 100", () => {
    // Four entrants, six fixtures, one court, ascending starts.
    //
    // NOTE, so this test is not over-read: alternation is SYMMETRIC under a
    // global home/away swap (`health.ts` compares `f.home === id`, so swapping
    // every side flips every entrant's series and leaves flips and runs
    // identical). This case therefore proves the two sides are read
    // POSITIONALLY and separately — it cannot witness which of the two is
    // "home". No metric in `assessHealth` can; recorded rather than papered
    // over.
    const fixedHome = boardOf([
      placed("fx-1", COURT_1, "09:00", ["e-a", "e-b"]),
      placed("fx-2", COURT_1, "10:00", ["e-a", "e-c"]),
      placed("fx-3", COURT_1, "11:00", ["e-a", "e-d"]),
      placed("fx-4", COURT_1, "12:00", ["e-b", "e-c"]),
      placed("fx-5", COURT_1, "13:00", ["e-b", "e-d"]),
      placed("fx-6", COURT_1, "14:00", ["e-c", "e-d"]),
    ]);
    // mean alternation 0.25, longest same-side run 3 (no run penalty) => 25.
    expect(scoreOf(assessBelievability({ board: fixedHome, constraints: constraintsOf({ isRoundRobin: true }) }), HOME_AWAY)).toBe(25);

    const alternating = boardOf([
      placed("fx-1", COURT_1, "09:00", ["e-a", "e-b"]),
      placed("fx-2", COURT_1, "10:00", ["e-c", "e-a"]),
      placed("fx-3", COURT_1, "11:00", ["e-a", "e-d"]),
      placed("fx-4", COURT_1, "12:00", ["e-b", "e-c"]),
      placed("fx-5", COURT_1, "13:00", ["e-d", "e-b"]),
      placed("fx-6", COURT_1, "14:00", ["e-c", "e-d"]),
    ]);
    // every entrant flips on every gap => mean 1, longest run 1 => 100.
    expect(scoreOf(assessBelievability({ board: alternating, constraints: constraintsOf({ isRoundRobin: true }) }), HOME_AWAY)).toBe(100);
  });
});

describe("assessBelievability — the board mapping", () => {
  it("buckets a court-day by the BOARD'S timezone, not UTC", () => {
    // 00:30 Europe/London on a June date is 23:30 UTC the PREVIOUS day. Both
    // fixtures share one London court-day, so gapDispersion measures the
    // eight-hour hole between them and scores 0. A UTC-keyed mapping would
    // split them into two single-fixture buckets, both skipped by
    // `health.ts`'s `length < 2` rule, and score 100.
    const board = boardOf([
      placed("fx-early", COURT_1, "00:30", ["e-a", "e-b"]),
      placed("fx-late", COURT_1, "09:00", ["e-c", "e-d"]),
    ]);
    expect(scoreOf(assessBelievability({ board, constraints: constraintsOf() }), GAP_DISPERSION)).toBe(0);
  });

  it("counts a placed fixture with NO entrants toward the court-day metrics", () => {
    // A TBD bracket slot holds a court and a time and no entrants. Dropping it
    // would leave one fixture in the bucket, which `health.ts` skips => 100.
    const board = boardOf([placed("fx-a", COURT_1, "09:00", ["e-a", "e-b"]), placed("fx-tbd", COURT_1, "10:00", [])]);
    expect(scoreOf(assessBelievability({ board, constraints: constraintsOf() }), GAP_DISPERSION)).toBe(0);
  });

  it("gives the exclusion probes below a board that can SEE a leak", () => {
    // Guard for the two `toEqual` probes that follow. They compare a board
    // against itself-plus-one-ignored-fixture, which passes trivially if no
    // metric on the board could move anyway - which is exactly how both of
    // them survived this suite's first mutation sweep. primeSlotFairness
    // sitting below 100 is what says this board discriminates; if it ever
    // reads 100, those probes have gone vacuous and must be rebuilt.
    const base = assessBelievability({ board: fourOnOneCourtDay(), constraints: constraintsOf() });
    expect(scoreOf(base, PRIME_SLOT)).toBeLessThan(100);
  });

  it("excludes an UNPLACED fixture even when it already holds a COURT", () => {
    // A court assigned with no time yet is a real board state:
    // `schedule.ts:toBoardFixture` reads `court_id` and `scheduled_at`
    // independently. The court is deliberately COURT_1 - a probe whose fixture
    // lacks BOTH a court and a start is skipped by either half of the guard,
    // and so tests neither half.
    const constraints = constraintsOf();
    const withUnplaced = boardOf([
      ...fourOnOneCourtDay().fixtures,
      fixtureOf({ fixtureId: "fx-none", courtId: COURT_1, entrantIds: ["e-a", "e-d"] }),
    ]);
    expect(assessBelievability({ board: withUnplaced, constraints })).toEqual(
      assessBelievability({ board: fourOnOneCourtDay(), constraints }),
    );
  });

  it("excludes a fixture that has a start but NO court", () => {
    const constraints = constraintsOf();
    const start = at(MON, "13:00");
    const withCourtless = boardOf([
      ...fourOnOneCourtDay().fixtures,
      fixtureOf({ fixtureId: "fx-courtless", start, end: start + 30 * MINUTE_MS, entrantIds: ["e-a", "e-d"] }),
    ]);
    expect(assessBelievability({ board: withCourtless, constraints })).toEqual(
      assessBelievability({ board: fourOnOneCourtDay(), constraints }),
    );
  });
});

describe("assessBelievability — the engine delta comes from two RUNS", () => {
  const board = twoWithAHole();
  const constraints = constraintsOf();

  function withArtifacts(engineArtifacts: Record<string, unknown>): BelievabilityReport {
    return assessBelievability({ board, constraints, engineArtifacts });
  }

  it("emits the delta when BOTH legs' artifacts are present", () => {
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.engineDelta).toBeDefined();
    expect(report.engineDelta?.makespanDeltaMinutes).toBe(60);
    expect(report.engineDelta?.courtImbalanceDeltaMinutes).toBe(60);
    expect(report.engineDelta?.comparedDivisionRefs).toEqual(["d-1"]);
    expect(report.engineDelta?.greedy.engine).toBe("greedy");
    expect(report.engineDelta?.optimized.engine).toBe("optimized");
    expect(report.engineDeltaNote).toBeUndefined();
  });

  it("signs the delta NEGATIVE when the optimized leg produced the worse board", () => {
    // The sign is directional, not a magnitude: greedy minus optimized, so a
    // positive number is what optimizing BOUGHT. Without this case an
    // `Math.abs` would survive the case above.
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
    });
    expect(report.engineDelta?.makespanDeltaMinutes).toBe(-60);
    expect(report.engineDelta?.courtImbalanceDeltaMinutes).toBe(-60);
  });

  it("pairs divisions by divisionRef, NEVER by index", () => {
    // A pure permutation cannot witness this: the SUM of a paired difference
    // is invariant under any re-pairing of the same two multisets. What does
    // witness it is a division the sibling leg never scheduled — greedy has
    // d-1 and d-2, optimized only d-2, so index-pairing would compare d-1's
    // 300 against d-2's 90 and report 210 over the ref ["d-1"].
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [
        { ref: "d-1", makespan: 300, imbalance: 90 },
        { ref: "d-2", makespan: 120, imbalance: 40 },
      ]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-2", makespan: 90, imbalance: 10 }]),
    });
    expect(report.engineDelta?.comparedDivisionRefs).toEqual(["d-2"]);
    expect(report.engineDelta?.makespanDeltaMinutes).toBe(30);
    expect(report.engineDelta?.courtImbalanceDeltaMinutes).toBe(30);
  });

  it("sums every division the two legs share", () => {
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [
        { ref: "d-1", makespan: 300, imbalance: 90 },
        { ref: "d-2", makespan: 120, imbalance: 40 },
      ]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [
        { ref: "d-2", makespan: 90, imbalance: 10 },
        { ref: "d-1", makespan: 250, imbalance: 60 },
      ]),
    });
    expect(report.engineDelta?.comparedDivisionRefs).toEqual(["d-1", "d-2"]);
    expect(report.engineDelta?.makespanDeltaMinutes).toBe(80);
    expect(report.engineDelta?.courtImbalanceDeltaMinutes).toBe(60);
  });

  it("skips a division whose metrics one leg never reported", () => {
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [
        { ref: "d-1", makespan: 300, imbalance: 90 },
        { ref: "d-2", makespan: 120, imbalance: 40 },
      ]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1" }, { ref: "d-2", makespan: 90, imbalance: 10 }]),
    });
    expect(report.engineDelta?.comparedDivisionRefs).toEqual(["d-2"]);
    expect(report.engineDelta?.makespanDeltaMinutes).toBe(30);
  });

  it("says WHICH divisions it compared when the two legs share none", () => {
    // Both artifacts exist, so a delta is emitted — but it sums nothing. A
    // bare `0` here is indistinguishable from "the two engines tied", which is
    // the suppressed-symptom trap; `comparedDivisionRefs` is what tells them
    // apart, so it is asserted rather than the zeroes alone.
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-9", makespan: 90, imbalance: 10 }]),
    });
    expect(report.engineDelta?.comparedDivisionRefs).toEqual([]);
    expect(report.engineDelta?.makespanDeltaMinutes).toBe(0);
  });

  it("omits the delta and NAMES the leg that ran when only greedy's artifact exists", () => {
    const report = withArtifacts({ [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]) });
    expect(report.engineDelta).toBeUndefined();
    expect(report.engineDeltaNote).toContain(`only the ${GREEDY_ARTIFACT_KEY} leg`);
  });

  it("omits the delta and NAMES the leg that ran when only optimized's artifact exists", () => {
    const report = withArtifacts({
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.engineDelta).toBeUndefined();
    expect(report.engineDeltaNote).toContain(`only the ${OPTIMIZED_ARTIFACT_KEY} leg`);
  });

  it("omits the delta when no artifacts were read at all", () => {
    expect(assessBelievability({ board, constraints }).engineDelta).toBeUndefined();
    expect(assessBelievability({ board, constraints }).engineDeltaNote).toContain("no engine artifact");
    expect(withArtifacts({}).engineDeltaNote).toContain("no engine artifact");
  });

  it("omits the delta, without throwing, when GREEDY'S artifact is not a readable snapshot", () => {
    // A truncated artifact must not be read as "that leg never ran": the note
    // names the file, so a two-leg run cannot be reported as a one-leg run.
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: { runId: "sha-aaaa" },
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.engineDelta).toBeUndefined();
    expect(report.engineDeltaNote).toContain(`the ${GREEDY_ARTIFACT_KEY} artifact is not a readable`);
  });

  it("omits the delta, without throwing, when OPTIMIZED'S artifact is not a readable snapshot", () => {
    // The mirror of the case above. Without it, a guard covering only one of
    // the two files passes on the strength of the other's test.
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: { runId: "sha-aaaa", requestedEngine: "both", engine: "optimized", divisions: "nope" },
    });
    expect(report.engineDelta).toBeUndefined();
    expect(report.engineDeltaNote).toContain(`the ${OPTIMIZED_ARTIFACT_KEY} artifact is not a readable`);
  });

  it("omits the delta when the two legs carry different runIds", () => {
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }], "sha-aaaa"),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }], "sha-bbbb"),
    });
    expect(report.engineDelta).toBeUndefined();
    expect(report.engineDeltaNote).toContain("runId");
  });

  it("omits the delta when an artifact's own engine field disagrees with the file it came from", () => {
    // Two greedy legs filed as one of each would otherwise be subtracted from
    // one another and reported as the optimizer's gain.
    const report = withArtifacts({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.engineDelta).toBeUndefined();
    expect(report.engineDeltaNote).toContain("engine field");
  });
});

describe("assessBelievability — similarity to historical", () => {
  const board = twoWithAHole();
  const constraints = constraintsOf({ isRoundRobin: true });
  const base = assessBelievability({ board, constraints });

  it("is UNDEFINED, never 0, when no history is supplied", () => {
    // 0 reads as "completely dissimilar", which is a claim. Absence is the
    // truth, so the field is absent.
    expect(base.similarityToHistoricalPct).toBeUndefined();
    expect("similarityToHistoricalPct" in base).toBe(false);
  });

  it("is UNDEFINED for an empty history array", () => {
    expect(assessBelievability({ board, constraints, history: [] }).similarityToHistoricalPct).toBeUndefined();
  });

  it("is UNDEFINED when history shares no metric key with this board", () => {
    const history: BelievabilityHistory[] = [{ metrics: [{ key: "aMetricNobodyEmits", score: 50 }] }];
    expect(assessBelievability({ board, constraints, history }).similarityToHistoricalPct).toBeUndefined();
  });

  it("is 100 when this board scores exactly what history did", () => {
    const history: BelievabilityHistory[] = [{ metrics: base.metrics }];
    expect(assessBelievability({ board, constraints, history }).similarityToHistoricalPct).toBe(100);
  });

  it("is 90 when every metric sits 10 points off history", () => {
    const history = [shifted(base.metrics, 10)];
    expect(assessBelievability({ board, constraints, history }).similarityToHistoricalPct).toBe(90);
  });

  it("floors at 0 for history nothing like this board - and 0 is a REAL value here", () => {
    // This is what makes the absence cases above meaningful: 0 is reachable,
    // and it means "measured, and completely dissimilar". `undefined` means
    // "not measured". A percentage that ran negative and printed as such, or
    // one that collapsed both states onto 0, would lose that distinction.
    const history = [shifted(base.metrics, 500)];
    expect(assessBelievability({ board, constraints, history }).similarityToHistoricalPct).toBe(0);
  });

  it("averages ACROSS observations rather than reading only the first", () => {
    // +10 and -10 average back to this board's own scores => 100. An
    // implementation that took history[0] would report 90, which is exactly
    // the case above — so the two together pin the mean.
    const history = [shifted(base.metrics, 10), shifted(base.metrics, -10)];
    expect(assessBelievability({ board, constraints, history }).similarityToHistoricalPct).toBe(100);
  });

  it("compares only the keys THIS board has, ignoring a metric history carries and it does not", () => {
    // A non-round-robin board has no homeAwayAlternation. A history row that
    // carries one must not drag the percentage around.
    const nonRr = constraintsOf({ isRoundRobin: false });
    const nonRrBase = assessBelievability({ board, constraints: nonRr });
    const history: BelievabilityHistory[] = [
      { metrics: [...shifted(nonRrBase.metrics, 10).metrics, { key: HOME_AWAY, score: -1000 }] },
    ];
    expect(assessBelievability({ board, constraints: nonRr, history }).similarityToHistoricalPct).toBe(90);
  });
});

describe("assessBelievability — report-only, and pure", () => {
  it("never throws on hostile artifacts", () => {
    const board = twoWithAHole();
    const constraints = constraintsOf();
    expect(() =>
      assessBelievability({
        board,
        constraints,
        engineArtifacts: { [GREEDY_ARTIFACT_KEY]: null, [OPTIMIZED_ARTIFACT_KEY]: 42, "engine-x": "nope" },
      }),
    ).not.toThrow();
  });

  it("never throws on a board with no fixtures at all", () => {
    expect(() => assessBelievability({ board: boardOf([]), constraints: constraintsOf() })).not.toThrow();
  });

  it("returns the same report for the same input, twice", () => {
    const input = {
      board: twoWithAHole(),
      constraints: constraintsOf({ isRoundRobin: true }),
      engineArtifacts: {
        [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
        [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
      },
    };
    expect(assessBelievability(input)).toEqual(assessBelievability(input));
  });
});
