// believability.test.ts — T5's suite.
//
// EVERY assertion here is on a REPORT-ONLY value. Nothing in believability.ts
// may red a run (design §3.5, `_RULES.md` §1's timings-and-measurements rule),
// so this file never asserts a throw as a desired behaviour — it asserts the
// opposite, that hostile input still returns a report.
//
// Three habits this suite keeps, all bought the hard way in this programme:
//
//  * Scores are pinned to HAND-COMPUTED values on purpose-built boards, never
//    to a second call of `assessHealth` from inside the test. Folding the same
//    mapping through the same function on both sides proves the fixture, not
//    the mapping (failure class 1).
//  * The metric KEY SET is derived from `assessHealth`'s own output rather than
//    typed in, so an engine-side rename moves this suite instead of leaving it
//    asserting yesterday's names (recurring failure class 19).
//  * An exclusion probe must sit on a board that can SEE the leak it denies.
//    Two of them here once passed while proving nothing; the guard test in the
//    mapping block exists to stop that recurring silently.

import { describe, expect, it } from "vitest";

import { assessHealth } from "@seazn/engine/scheduling/health";

import type { Board, BoardFixture, EncodedConstraints } from "../board.ts";
import type { PackHistoricalAssignment } from "../pack-schema.ts";
import type { ActualEngine, EngineSnapshot } from "../schedule.ts";
import {
  assessBelievability,
  assessEngineDelta,
  GREEDY_ARTIFACT_KEY,
  OPTIMIZED_ARTIFACT_KEY,
  type BelievabilityReport,
  type EngineDeltaReport,
} from "../believability.ts";
import { at, cleanConstraints, DIVISION_ID, DIVISION_REF, MON, TUE, TZ } from "./_board-fixtures.ts";

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

/** A zone `Intl` has never heard of. `dayKeyInTz` builds an
 *  `Intl.DateTimeFormat` from it and raises `RangeError` — the one reachable
 *  way this never-red module could red a run. */
const BOGUS_TZ = "Not/AZone";

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

/** A placed fixture that also carries the `ext_key` history is matched on. */
function keyed(fixtureId: string, extKey: string, hhmm: string, ymd: string = MON): BoardFixture {
  return { ...placed(fixtureId, COURT_1, hhmm, ["e-a", "e-b"], 30, ymd), extKey };
}

function boardOf(fixtures: readonly BoardFixture[], tz: string = TZ): Board {
  return { divisionId: DIVISION_ID, divisionRef: DIVISION_REF, tz, fixtures, courts: [] };
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

/** The real tournament's own row for one fixture. The `+01:00` is written out
 *  for the same reason `_board-fixtures.ts:at` writes it: an offsetless
 *  timestamp resolves against the HOST zone and makes the suite
 *  machine-dependent. `PackHistoricalAssignment.startsAt` is
 *  `z.iso.datetime({ offset: true })`, so a real row always carries one. */
function historyRow(
  fixtureExtKey: string,
  ymd: string,
  hhmm: string,
  divisionRef: string = DIVISION_REF,
): PackHistoricalAssignment {
  return { divisionRef, fixtureExtKey, venue: "Somewhere Real", startsAt: `${ymd}T${hhmm}:00+01:00` };
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

/** Four keyed fixtures at 09:00, 10:00, 11:00 and 12:00 on MON. */
function keyedBoard(): Board {
  return boardOf([
    keyed("fx-1", "k1", "09:00"),
    keyed("fx-2", "k2", "10:00"),
    keyed("fx-3", "k3", "11:00"),
    keyed("fx-4", "k4", "12:00"),
  ]);
}

describe("assessBelievability — metrics come from assessHealth", () => {
  it("carries assessHealth's metric keys, in the engine's own order", () => {
    const report = assessBelievability({
      board: twoWithAHole(),
      constraints: constraintsOf({ isRoundRobin: true }),
    });
    expect(report.metrics.map((m) => m.key)).toEqual(RR_KEYS);
    expect(report.metricsNote).toBeUndefined();
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
    // 180 minutes instead of 660 — frag 30/120 = 0.25 => 75 — so this case is
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
    expect(scoreOf(assessBelievability({ board, constraints: constraintsOf() }), COURT_BALANCE)).toBe(100);
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
    expect(scoreOf(assessBelievability({ board, constraints: constraintsOf() }), COURT_BALANCE)).toBe(0);
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
    // metric on the board could move anyway — which is exactly how both of
    // them survived this suite's first mutation sweep. primeSlotFairness
    // sitting below 100 is what says this board discriminates; if it ever
    // reads 100, those probes have gone vacuous and must be rebuilt.
    const base = assessBelievability({ board: fourOnOneCourtDay(), constraints: constraintsOf() });
    expect(scoreOf(base, PRIME_SLOT)).toBeLessThan(100);
  });

  it("excludes an UNPLACED fixture even when it already holds a COURT", () => {
    // A court assigned with no time yet is a real board state:
    // `schedule.ts:toBoardFixture` reads `court_id` and `scheduled_at`
    // independently. The court is deliberately COURT_1 — a probe whose fixture
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

describe("assessBelievability — a board timezone Intl rejects DEGRADES, it does not throw", () => {
  // This is the ONE reachable path that could red a module specified never to
  // red a run: `dayKeyInTz` builds an `Intl.DateTimeFormat` from `board.tz`
  // (`tz.ts:57-70`) and raises RangeError for an unrecognised zone. A pack
  // with a typo'd zone would otherwise take a whole bench leg down.
  it("does not throw", () => {
    expect(() =>
      assessBelievability({ board: boardOf(twoWithAHole().fixtures, BOGUS_TZ), constraints: constraintsOf() }),
    ).not.toThrow();
  });

  it("reports NO metrics and says why, naming the zone", () => {
    const report = assessBelievability({
      board: boardOf(twoWithAHole().fixtures, BOGUS_TZ),
      constraints: constraintsOf(),
    });
    expect(report.metrics).toEqual([]);
    expect(report.metricsNote).toContain(BOGUS_TZ);
  });

  it("degrades similarity for the same reason, separately", () => {
    const report = assessBelievability({
      board: boardOf(keyedBoard().fixtures, BOGUS_TZ),
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("k1", MON, "09:00")],
    });
    expect(report.similarityToHistorical).toBeUndefined();
    expect(report.similarityNote).toContain(BOGUS_TZ);
  });

  it("still computes metrics normally for a zone Intl DOES know — the positive pair", () => {
    const report = assessBelievability({ board: twoWithAHole(), constraints: constraintsOf() });
    expect(report.metrics).toHaveLength(RR_KEYS.length);
    expect(report.metricsNote).toBeUndefined();
  });
});

describe("assessBelievability — similarity to the historical TIMETABLE", () => {
  it("reports the same-day and same-instant fractions over the fixtures it matched", () => {
    // k1 at the same instant; k2 the same day at a different time; k3 a day
    // late; k4 has no historical row at all. Compared 3 => same day 2/3 = 67,
    // same instant 1/3 = 33.
    const report = assessBelievability({
      board: keyedBoard(),
      constraints: constraintsOf(),
      historicalAssignment: [
        historyRow("k1", MON, "09:00"),
        historyRow("k2", MON, "15:00"),
        historyRow("k3", TUE, "10:00"),
      ],
    });
    expect(report.similarityToHistorical).toEqual({
      sameDayPct: 67,
      sameInstantPct: 33,
      comparedFixtures: 3,
      historicalRows: 3,
    });
    expect(report.similarityNote).toBeUndefined();
  });

  it("reaches 100% same-day once every matched fixture lands on history's day", () => {
    // Same three rows, but k3's row now names MON. The differential is what
    // proves the day comparison reads the rows rather than counting matches.
    const report = assessBelievability({
      board: keyedBoard(),
      constraints: constraintsOf(),
      historicalAssignment: [
        historyRow("k1", MON, "09:00"),
        historyRow("k2", MON, "15:00"),
        historyRow("k3", MON, "10:00"),
      ],
    });
    expect(report.similarityToHistorical?.sameDayPct).toBe(100);
    // Only k1 is at the same instant, so the strict fraction stays behind.
    expect(report.similarityToHistorical?.sameInstantPct).toBe(33);
  });

  it("never reports a same-instant fraction above its same-day fraction", () => {
    // Same instant implies same day, so this ordering is structural. It is
    // asserted because an implementation that compared instants against the
    // day bucket (or vice versa) would break it silently.
    const report = assessBelievability({
      board: keyedBoard(),
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("k1", MON, "09:00"), historyRow("k2", MON, "15:00"), historyRow("k3", TUE, "10:00")],
    });
    const s = report.similarityToHistorical;
    expect(s).toBeDefined();
    expect(s!.sameInstantPct).toBeLessThanOrEqual(s!.sameDayPct);
  });

  it("compares the calendar day in the BOARD'S timezone, not UTC", () => {
    // Our fixture sits at 09:00 London on MON; history put it at 00:30 London
    // the same MON, which is 23:30 UTC on SUNDAY. Read in London they share a
    // day (100%); read in UTC they do not (0%).
    const board = boardOf([keyed("fx-1", "k1", "09:00")]);
    const report = assessBelievability({
      board,
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("k1", MON, "00:30")],
    });
    expect(report.similarityToHistorical?.sameDayPct).toBe(100);
    expect(report.similarityToHistorical?.sameInstantPct).toBe(0);
  });

  it("is UNDEFINED, with no note, when the pack declares no history at all", () => {
    // 0 would read as "we reproduced none of the timetable", which is a claim
    // about a timetable nobody supplied.
    const report = assessBelievability({ board: keyedBoard(), constraints: constraintsOf() });
    expect(report.similarityToHistorical).toBeUndefined();
    expect("similarityToHistorical" in report).toBe(false);
    expect(report.similarityNote).toBeUndefined();
  });

  it("ignores rows belonging to ANOTHER division", () => {
    // The pack's array is competition-wide, so scoping is this module's job.
    // Scoring this board against another division's rows would report 0% on
    // fixtures it was never going to place.
    const report = assessBelievability({
      board: keyedBoard(),
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("k1", MON, "09:00", "d-somewhere-else")],
    });
    expect(report.similarityToHistorical).toBeUndefined();
    expect(report.similarityNote).toBeUndefined();
  });

  it("SAYS SO when history is declared for this division and nothing matched", () => {
    // Rows exist and no ext key lines up — a fact about ext-key agreement, not
    // about scheduling. Silently returning undefined would hide it behind the
    // ordinary "no history" state.
    const report = assessBelievability({
      board: keyedBoard(),
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("nothing-like-it", MON, "09:00"), historyRow("nor-this", MON, "10:00")],
    });
    expect(report.similarityToHistorical).toBeUndefined();
    expect(report.similarityNote).toContain("2 historical assignment(s)");
    expect(report.similarityNote).toContain("fixtureExtKey");
  });

  it("cannot match a fixture that carries no extKey", () => {
    const board = boardOf([placed("fx-1", COURT_1, "09:00", ["e-a", "e-b"])]);
    const report = assessBelievability({
      board,
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("k1", MON, "09:00")],
    });
    expect(report.similarityToHistorical).toBeUndefined();
    expect(report.similarityNote).toContain("1 historical assignment(s)");
  });

  it("does not compare an UNPLACED fixture, even when history has its row", () => {
    // The whole quantity is "where and when did this land"; an unplaced
    // fixture landed nowhere. Counting it would put a fixture with no instant
    // into a fraction reported as measured.
    const board = boardOf([keyed("fx-1", "k1", "09:00"), fixtureOf({ fixtureId: "fx-2", extKey: "k2", courtId: COURT_1 })]);
    const report = assessBelievability({
      board,
      constraints: constraintsOf(),
      historicalAssignment: [historyRow("k1", MON, "09:00"), historyRow("k2", MON, "10:00")],
    });
    expect(report.similarityToHistorical?.comparedFixtures).toBe(1);
    // historicalRows still reports 2 — the unmatched half of history stays
    // visible rather than shrinking the denominator out of sight.
    expect(report.similarityToHistorical?.historicalRows).toBe(2);
    expect(report.similarityToHistorical?.sameDayPct).toBe(100);
  });

  it("skips a row whose startsAt will not parse, without throwing", () => {
    const report = assessBelievability({
      board: keyedBoard(),
      constraints: constraintsOf(),
      historicalAssignment: [{ ...historyRow("k1", MON, "09:00"), startsAt: "not a timestamp" }],
    });
    expect(report.similarityToHistorical).toBeUndefined();
    expect(report.similarityNote).toContain("1 historical assignment(s)");
  });
});

describe("assessEngineDelta — the comparison comes from two RUNS, and is RUN-level", () => {
  it("emits the delta when BOTH legs' artifacts are present", () => {
    const report: EngineDeltaReport = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.delta).toBeDefined();
    expect(report.delta?.makespanDeltaMinutes).toBe(60);
    expect(report.delta?.courtImbalanceDeltaMinutes).toBe(60);
    expect(report.delta?.comparedDivisionRefs).toEqual(["d-1"]);
    expect(report.delta?.greedy.engine).toBe("greedy");
    expect(report.delta?.optimized.engine).toBe("optimized");
    expect(report.note).toBeUndefined();
  });

  it("is NOT part of the per-division believability report", () => {
    // T6 calls `assessBelievability` once per division. A delta carried there
    // would be emitted N times, each copy listing every OTHER division's refs.
    const report = assessBelievability({ board: twoWithAHole(), constraints: constraintsOf() });
    expect(report).not.toHaveProperty("engineDelta");
    expect(report).not.toHaveProperty("engineDeltaNote");
  });

  it("signs the delta NEGATIVE when the optimized leg produced the worse board", () => {
    // The sign is directional, not a magnitude: greedy minus optimized, so a
    // positive number is what optimizing BOUGHT. Without this case an
    // `Math.abs` would survive the case above.
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
    });
    expect(report.delta?.makespanDeltaMinutes).toBe(-60);
    expect(report.delta?.courtImbalanceDeltaMinutes).toBe(-60);
  });

  it("pairs divisions by divisionRef, NEVER by index", () => {
    // A pure permutation cannot witness this: the SUM of a paired difference
    // is invariant under any re-pairing of the same two multisets. What does
    // witness it is a division the sibling leg never scheduled — greedy has
    // d-1 and d-2, optimized only d-2, so index-pairing would compare d-1's
    // 300 against d-2's 90 and report 210 over the ref ["d-1"].
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [
        { ref: "d-1", makespan: 300, imbalance: 90 },
        { ref: "d-2", makespan: 120, imbalance: 40 },
      ]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-2", makespan: 90, imbalance: 10 }]),
    });
    expect(report.delta?.comparedDivisionRefs).toEqual(["d-2"]);
    expect(report.delta?.makespanDeltaMinutes).toBe(30);
    expect(report.delta?.courtImbalanceDeltaMinutes).toBe(30);
  });

  it("sums every division the two legs share", () => {
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [
        { ref: "d-1", makespan: 300, imbalance: 90 },
        { ref: "d-2", makespan: 120, imbalance: 40 },
      ]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [
        { ref: "d-2", makespan: 90, imbalance: 10 },
        { ref: "d-1", makespan: 250, imbalance: 60 },
      ]),
    });
    expect(report.delta?.comparedDivisionRefs).toEqual(["d-1", "d-2"]);
    expect(report.delta?.makespanDeltaMinutes).toBe(80);
    expect(report.delta?.courtImbalanceDeltaMinutes).toBe(60);
  });

  it("skips a division whose metrics one leg never reported", () => {
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [
        { ref: "d-1", makespan: 300, imbalance: 90 },
        { ref: "d-2", makespan: 120, imbalance: 40 },
      ]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1" }, { ref: "d-2", makespan: 90, imbalance: 10 }]),
    });
    expect(report.delta?.comparedDivisionRefs).toEqual(["d-2"]);
    expect(report.delta?.makespanDeltaMinutes).toBe(30);
  });

  it("says WHICH divisions it compared when the two legs share none", () => {
    // Both artifacts exist, so a delta is emitted — but it sums nothing. A
    // bare `0` here is indistinguishable from "the two engines tied", which is
    // the suppressed-symptom trap; `comparedDivisionRefs` is what tells them
    // apart, so it is asserted rather than the zeroes alone.
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-9", makespan: 90, imbalance: 10 }]),
    });
    expect(report.delta?.comparedDivisionRefs).toEqual([]);
    expect(report.delta?.makespanDeltaMinutes).toBe(0);
  });

  it("omits the delta and NAMES the leg that ran when only greedy's artifact exists", () => {
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
    });
    expect(report.delta).toBeUndefined();
    expect(report.note).toContain(`only the ${GREEDY_ARTIFACT_KEY} leg`);
  });

  it("omits the delta and NAMES the leg that ran when only optimized's artifact exists", () => {
    const report = assessEngineDelta({
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.delta).toBeUndefined();
    expect(report.note).toContain(`only the ${OPTIMIZED_ARTIFACT_KEY} leg`);
  });

  it("omits the delta when no artifacts were read at all", () => {
    expect(assessEngineDelta(undefined).delta).toBeUndefined();
    expect(assessEngineDelta(undefined).note).toContain("no engine artifact");
    expect(assessEngineDelta({}).note).toContain("no engine artifact");
  });

  it("omits the delta, without throwing, when GREEDY'S artifact is not a readable snapshot", () => {
    // A truncated artifact must not be read as "that leg never ran": the note
    // names the file, so a two-leg run cannot be reported as a one-leg run.
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: { runId: "sha-aaaa" },
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.delta).toBeUndefined();
    expect(report.note).toContain(`the ${GREEDY_ARTIFACT_KEY} artifact is not a readable`);
  });

  it("omits the delta, without throwing, when OPTIMIZED'S artifact is not a readable snapshot", () => {
    // The mirror of the case above. Without it, a guard covering only one of
    // the two files passes on the strength of the other's test.
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: { runId: "sha-aaaa", requestedEngine: "both", engine: "optimized", divisions: "nope" },
    });
    expect(report.delta).toBeUndefined();
    expect(report.note).toContain(`the ${OPTIMIZED_ARTIFACT_KEY} artifact is not a readable`);
  });

  it("omits the delta when the two legs carry different runIds", () => {
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }], "sha-aaaa"),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }], "sha-bbbb"),
    });
    expect(report.delta).toBeUndefined();
    expect(report.note).toContain("runId");
  });

  it("omits the delta when an artifact's own engine field disagrees with the file it came from", () => {
    // Two greedy legs filed as one of each would otherwise be subtracted from
    // one another and reported as the optimizer's gain.
    const report = assessEngineDelta({
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    });
    expect(report.delta).toBeUndefined();
    expect(report.note).toContain("engine field");
  });

  it("never throws on hostile artifacts", () => {
    expect(() =>
      assessEngineDelta({ [GREEDY_ARTIFACT_KEY]: null, [OPTIMIZED_ARTIFACT_KEY]: 42, "engine-x": "nope" }),
    ).not.toThrow();
  });
});

describe("assessBelievability — report-only, and pure", () => {
  it("never throws on a board with no fixtures at all", () => {
    expect(() => assessBelievability({ board: boardOf([]), constraints: constraintsOf() })).not.toThrow();
  });

  it("returns the same report for the same input, twice", () => {
    const input = {
      board: keyedBoard(),
      constraints: constraintsOf({ isRoundRobin: true }),
      historicalAssignment: [historyRow("k1", MON, "09:00"), historyRow("k2", TUE, "15:00")],
    };
    expect(assessBelievability(input)).toEqual(assessBelievability(input));
  });

  it("returns the same engine delta for the same artifacts, twice", () => {
    const artifacts = {
      [GREEDY_ARTIFACT_KEY]: snapshot("greedy", [{ ref: "d-1", makespan: 300, imbalance: 90 }]),
      [OPTIMIZED_ARTIFACT_KEY]: snapshot("optimized", [{ ref: "d-1", makespan: 240, imbalance: 30 }]),
    };
    expect(assessEngineDelta(artifacts)).toEqual(assessEngineDelta(artifacts));
  });
});
