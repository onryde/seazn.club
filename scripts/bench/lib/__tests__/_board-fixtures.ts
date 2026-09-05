// _board-fixtures.ts — the hand-built board every `checker.test.ts` case
// perturbs by exactly one thing.
//
// NOT a test file (no `.test.ts` suffix), so vitest never collects it and
// `tsconfig.scripts.json` DOES typecheck it — which is the point: a fixture
// that stopped satisfying `Board` / `EncodedConstraints` would otherwise only
// show up as a confusing runtime red.
//
// -------------------------------------------------------------------------
// Why the sizes are asymmetric, and why the clock is not UTC
// -------------------------------------------------------------------------
//
// THREE fixtures, TWO courts, FOUR entrants, TWO rounds, TWO days. Every
// dimension differs from every other, so an implementation that transposed a
// pair of indices — courts for fixtures, entrants for persons — cannot pass by
// coincidence.
//
// The zone is `Europe/London` on a JUNE date, i.e. BST (+01:00), NOT UTC. A
// checker that read the wall clock off the epoch instant instead of off the
// division's zone is exactly one hour out here, which lands `f0` (09:00 local)
// at 08:00 — inside `court-1`'s hours either way, but OUTSIDE the 09:00
// session window. So the tz path is load-bearing on the CLEAN board and a
// tz-blind checker fails the very first test.
//
// -------------------------------------------------------------------------
// The clean board, in one picture (all times Europe/London, BST)
// -------------------------------------------------------------------------
//
//   Mon 2027-06-07        09:00   09:30   11:00   11:30   12:00   13:00
//   court-1 (06:00-14:00)  [f0 r1 ]        [f2 r2 ]        <blackout>
//   court-2 (06:00-20:00)  [f1 r1 ]
//
//   session window: 09:00-20:00 on Mon AND on Tue (the Tue window exists so a
//   round-order test can move a round across days without also tripping
//   containment; the clean board never uses it).
//
//   entrants: f0 = e-a,e-b · f1 = e-c,e-d · f2 = e-a,e-c
//   persons:  f0 = p-a,p-b · f1 = p-c,p-d · f2 = p-a,p-c
//   officials: f0 = o-1 · f1 = o-2 · f2 = o-1   (o-1 twice, never overlapping)
//
// Deliberate slack, so that a single-fixture perturbation reds ONE rule:
//
//   * `court-1` closes at 14:00 while `court-2` closes at 20:00 — so 14:00 on
//     court-1 is a court-hours breach and the SAME instant on court-2 is
//     clean. A checker that unioned every court's hours passes the first and
//     fails the differential.
//   * the session window (09:00) opens LATER than either court (06:00), so
//     07:00 breaches the window alone.
//   * the blackout (12:00-13:00) sits strictly inside court-1's hours and the
//     session window, so 12:00 breaches the blackout alone.
//   * e-a's two fixtures are 90 minutes apart against a 60-minute floor, so a
//     30-minute move does not accidentally red the rest rule.
//   * `pins` is EMPTY. Almost every test moves a fixture, and a pin on the
//     moved one would add a second finding to every case; the pin rule gets
//     its own fixtures instead, in both directions.

import type { Board, EncodedConstraints } from "../board.ts";

/** Monday. Weekday 1 in `CourtHoursRow`'s 0=Sunday convention. */
export const MON = "2027-06-07";
/** Tuesday. Weekday 2. Used only by the round-order cases. */
export const TUE = "2027-06-08";

/** Local wall clock in `Europe/London` -> epoch ms.
 *
 *  The `+01:00` is written out rather than inferred: `Date.parse` resolves an
 *  offsetless ISO date-time against the HOST zone, which would make every
 *  expectation in this suite machine-dependent — the same refusal
 *  `board.ts`'s `epochMs` makes for a pack. */
export function at(ymd: string, hhmm: string): number {
  const ms = Date.parse(`${ymd}T${hhmm}:00+01:00`);
  if (!Number.isFinite(ms)) throw new Error(`_board-fixtures: unparseable ${ymd} ${hhmm}`);
  return ms;
}

export const TZ = "Europe/London";
export const DIVISION_ID = "div-one";
export const DIVISION_REF = "d-one";
export const COURT_1 = "court-1";
export const COURT_2 = "court-2";

/** 30 minutes, matching `cleanConstraints().matchMinutes`. Occupancy is
 *  `[start, start + matchMinutes)` and NEVER `end` (ruling R12), but the
 *  fixtures still carry a consistent `end` so a test can prove the checker
 *  ignores it. */
export const MATCH_MINUTES = 30;

function endOf(start: number): number {
  return start + MATCH_MINUTES * 60_000;
}

/** The clean board. Fresh object graph on every call, so a test may mutate
 *  copies without leaking into the next one. */
export function cleanBoard(): Board {
  const f0Start = at(MON, "09:00");
  const f1Start = at(MON, "09:00");
  const f2Start = at(MON, "11:00");
  return {
    divisionId: DIVISION_ID,
    divisionRef: DIVISION_REF,
    tz: TZ,
    fixtures: [
      {
        fixtureId: "fx-0",
        extKey: "r1-a",
        divisionId: DIVISION_ID,
        divisionRef: DIVISION_REF,
        roundNo: 1,
        poolId: "pool-a",
        start: f0Start,
        end: endOf(f0Start),
        courtId: COURT_1,
        courtName: "Court 1",
        venueId: "venue-1",
        entrantIds: ["e-a", "e-b"],
        personIds: ["p-a", "p-b"],
        officialIds: ["o-1"],
        locked: false,
      },
      {
        fixtureId: "fx-1",
        extKey: "r1-b",
        divisionId: DIVISION_ID,
        divisionRef: DIVISION_REF,
        roundNo: 1,
        poolId: "pool-b",
        start: f1Start,
        end: endOf(f1Start),
        courtId: COURT_2,
        courtName: "Court 2",
        venueId: "venue-1",
        entrantIds: ["e-c", "e-d"],
        personIds: ["p-c", "p-d"],
        officialIds: ["o-2"],
        locked: false,
      },
      {
        fixtureId: "fx-2",
        extKey: "r2-a",
        divisionId: DIVISION_ID,
        divisionRef: DIVISION_REF,
        roundNo: 2,
        poolId: "pool-a",
        start: f2Start,
        end: endOf(f2Start),
        courtId: COURT_1,
        courtName: "Court 1",
        venueId: "venue-1",
        entrantIds: ["e-a", "e-c"],
        personIds: ["p-a", "p-c"],
        officialIds: ["o-1"],
        locked: false,
      },
    ],
    courts: [
      {
        courtId: COURT_1,
        name: "Court 1",
        venueId: "venue-1",
        // 06:00-14:00 on Mon and Tue. Narrower than court-2 ON PURPOSE.
        hours: [
          { weekday: 1, openMin: 360, closeMin: 840 },
          { weekday: 2, openMin: 360, closeMin: 840 },
        ],
        exceptions: [],
      },
      {
        courtId: COURT_2,
        name: "Court 2",
        venueId: "venue-1",
        hours: [
          { weekday: 1, openMin: 360, closeMin: 1200 },
          { weekday: 2, openMin: 360, closeMin: 1200 },
        ],
        exceptions: [],
      },
    ],
  };
}

/** The oracle the clean board satisfies.
 *
 *  `declaresOfficials: true` because the clean board's fixtures all carry an
 *  official — so the "declared officials, fetched none" rule is live on the
 *  clean board rather than opt-in, and a test that empties `officialIds` reds
 *  with no other change. */
export function cleanConstraints(): EncodedConstraints {
  return {
    divisionRef: DIVISION_REF,
    matchMinutes: MATCH_MINUTES,
    gapMinutes: 0,
    startAt: at(MON, "06:00"),
    endAt: at(TUE, "22:00"),
    courtIds: [COURT_1, COURT_2],
    perEntrantMinRest: 60,
    blackouts: [{ courtId: COURT_1, from: at(MON, "12:00"), to: at(MON, "13:00") }],
    sessionWindows: [
      { from: at(MON, "09:00"), to: at(MON, "20:00") },
      { from: at(TUE, "09:00"), to: at(TUE, "20:00") },
    ],
    // Only `max_fixtures_per_day` — `min_rest_minutes` is no longer part of
    // `EncodedHardRule` at all (ruling R23: unmeasurable in every rest_scope,
    // reported in `unmodelled[]` instead), and `not_before`/`not_after` are
    // supplied per-test so a bound cannot answer for another rule.
    hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } }],
    pins: [],
    isRoundRobin: true,
    declaresOfficials: true,
    unmodelled: [],
  };
}

/** `cleanBoard()` with one fixture replaced. Keeps every test's perturbation
 *  to a single visible line instead of a re-spread array. */
export function withFixture(
  board: Board,
  index: number,
  patch: Partial<Board["fixtures"][number]>,
): Board {
  const fixtures = board.fixtures.map((f, i) => (i === index ? { ...f, ...patch } : f));
  return { ...board, fixtures };
}

/** Moves a fixture to a new local wall clock, keeping `end` consistent with
 *  it — so a test that moves a fixture never silently also tests the
 *  `end`-is-ignored rule. */
export function movedTo(
  board: Board,
  index: number,
  ymd: string,
  hhmm: string,
  courtId?: string,
): Board {
  const start = at(ymd, hhmm);
  return withFixture(board, index, {
    start,
    end: endOf(start),
    ...(courtId === undefined ? {} : { courtId }),
  });
}
