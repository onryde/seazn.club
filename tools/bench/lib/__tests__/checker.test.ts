// checker.test.ts — one violating board per rule, each perturbing the clean
// board by exactly ONE thing.
//
// The suite's contract with itself: every case below states the mutation that
// reds it. Where a rule has two guards that could cover for each other (a
// scope gate and its operand; the `<` of a half-open interval and its
// operand; `start` and `courtId` in a pin) each guard gets its OWN case, so
// deleting either one alone reds something.

import { describe, expect, it } from "vitest";
import { checkBoard } from "../checker.ts";
import type { ConstraintScope } from "@seazn/engine/scheduling";
import { encodeConstraints, type Board, type CheckerFinding, type EncodedConstraints } from "../board.ts";
import { buildTinyPack } from "../../packs/build-packs/_tiny.ts";
import {
  at,
  cleanBoard,
  DIVISION_ID,
  cleanConstraints,
  COURT_1,
  COURT_2,
  MON,
  movedTo,
  TUE,
  withFixture,
} from "./_board-fixtures.ts";

const kinds = (fs: readonly CheckerFinding[]): string[] => fs.map((f) => f.kind);

/** The clean board with round 1 on TUESDAY and round 2 on MONDAY. Every
 *  fixture is individually legal — both days carry a session window and both
 *  courts carry hours for both weekdays — so only the SEQUENCE is wrong. */
function roundsAcrossDays(): Board {
  const b = cleanBoard();
  return movedTo(movedTo(b, 0, TUE, "09:00"), 1, TUE, "09:00");
}

/** Round 2 at 09:00 and round 1 at 11:00, same Monday. Individually legal
 *  again — a rule that judged each row alone passes this board. */
function roundsSameDay(): Board {
  const b = cleanBoard();
  return movedTo(movedTo(movedTo(b, 2, MON, "09:00"), 0, MON, "11:00"), 1, MON, "11:00");
}

describe("checkBoard", () => {
  it("passes a clean board", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.findings).toEqual([]);
    expect(r.clean).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Rule 1 — court double-booking
  // -----------------------------------------------------------------------

  it("names BOTH fixtures of a court double-booking", () => {
    const b = cleanBoard();
    const f = [...b.fixtures];
    f[1] = { ...f[1], courtId: f[0].courtId, start: f[0].start, end: f[0].end };
    const r = checkBoard({ ...b, fixtures: f }, cleanConstraints());
    expect(kinds(r.findings)).toEqual(["court_double_booking"]);
    expect([...r.findings[0].fixtureIds].sort()).toEqual(
      [f[0].fixtureId, f[1].fixtureId].sort(),
    );
    // `clean` is the checker's own authority and must agree with its findings,
    // because `judgeDivision` reads the field and never re-derives it.
    expect(r.clean).toBe(false);
  });

  it("abuts without overlapping — two fixtures back to back on one court", () => {
    // 09:00-09:30 then 09:30-10:00 on court-1. A `<=` in the overlap test
    // reds this board; the half-open convention says it is clean. The rest
    // floor is lifted so the ZERO-minute turnaround cannot answer for the
    // overlap guard.
    const b = movedTo(cleanBoard(), 2, MON, "09:30");
    expect(
      checkBoard(b, { ...cleanConstraints(), perEntrantMinRest: 0, hard: [] }).findings,
    ).toEqual([]);
  });

  it("judges occupancy on matchMinutes, never on the board's own end", () => {
    // R12: `end` is T4's derivation and the checker does not trust it. A
    // checker reading `end` reds this board; one reading matchMinutes does not.
    const stretched = withFixture(cleanBoard(), 0, { end: at(MON, "12:00") });
    expect(checkBoard(stretched, cleanConstraints()).findings).toEqual([]);

    // ...and the other direction, so "ignores end" cannot be satisfied by a
    // rule that ignores duration altogether: 150 minutes DOES collide.
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), matchMinutes: 150 });
    expect(kinds(r.findings)).toContain("court_double_booking");
  });

  // -----------------------------------------------------------------------
  // Rule 2 — window / blackout containment
  // -----------------------------------------------------------------------

  it("flags a fixture inside a blackout", () => {
    // 12:00 on court-1: inside the session window, inside court-1's hours,
    // and inside the blackout. One finding, so the blackout guard is the only
    // thing that can produce it.
    const r = checkBoard(movedTo(cleanBoard(), 2, MON, "12:00"), cleanConstraints());
    expect(kinds(r.findings)).toEqual(["inside_blackout"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-2"]);
  });

  it("treats a blackout as half-open — abutting either edge is not a breach", () => {
    const before = {
      ...cleanConstraints(),
      blackouts: [{ courtId: COURT_1, from: at(MON, "08:30"), to: at(MON, "09:00") }],
    };
    const after = {
      ...cleanConstraints(),
      blackouts: [{ courtId: COURT_1, from: at(MON, "09:30"), to: at(MON, "10:00") }],
    };
    const hit = {
      ...cleanConstraints(),
      blackouts: [{ courtId: COURT_1, from: at(MON, "09:00"), to: at(MON, "09:30") }],
    };
    expect(checkBoard(cleanBoard(), before).findings).toEqual([]);
    expect(checkBoard(cleanBoard(), after).findings).toEqual([]);
    expect(kinds(checkBoard(cleanBoard(), hit).findings)).toEqual(["inside_blackout"]);
  });

  it("applies a court-scoped blackout to that court only", () => {
    // The same window on the OTHER court leaves fx-0 alone. A checker that
    // dropped the court key would red both boards.
    const scoped = {
      ...cleanConstraints(),
      blackouts: [{ courtId: COURT_2, from: at(MON, "09:00"), to: at(MON, "09:30") }],
    };
    expect(kinds(checkBoard(cleanBoard(), scoped).findings)).toEqual(["inside_blackout"]);
    expect(checkBoard(cleanBoard(), scoped).findings[0].fixtureIds).toEqual(["fx-1"]);
  });

  it("applies a blackout with no courtId to every court", () => {
    const global = {
      ...cleanConstraints(),
      blackouts: [{ from: at(MON, "09:00"), to: at(MON, "09:30") }],
    };
    const r = checkBoard(cleanBoard(), global);
    expect(kinds(r.findings)).toEqual(["inside_blackout", "inside_blackout"]);
    expect(r.findings.flatMap((f) => [...f.fixtureIds])).toEqual(["fx-0", "fx-1"]);
  });

  it("flags a fixture outside every session window", () => {
    // 07:00 is inside court-1's hours (06:00-14:00) and outside the 09:00
    // session window, so the window guard is the only producer.
    const r = checkBoard(movedTo(cleanBoard(), 0, MON, "07:00"), cleanConstraints());
    expect(kinds(r.findings)).toEqual(["outside_session_windows"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0"]);
  });

  it("reads the wall clock in the BOARD'S zone, not the host's and not UTC", () => {
    // Court hours are wall clocks; session windows and blackouts are
    // instants. So the same three instants judged in a +12 zone put every
    // fixture outside its court's hours while every instant-based rule stays
    // clean. A checker that read the clock off the epoch (or off the host)
    // returns the same answer for both boards.
    const b = cleanBoard();
    expect(checkBoard(b, cleanConstraints()).findings).toEqual([]);
    const shifted = checkBoard({ ...b, tz: "Pacific/Auckland" }, cleanConstraints());
    expect(kinds(shifted.findings)).toEqual([
      "outside_court_hours",
      "outside_court_hours",
      "outside_court_hours",
    ]);
  });

  it("requires a fixture to be WHOLLY inside a session window, not merely to start in one", () => {
    // fx-2 runs 11:00-11:30. Against a window closing at 11:15 it STARTS
    // inside and finishes outside, so a start-only containment test passes
    // this board and this case fails it. Court hours (06:00-14:00) admit the
    // fixture either way, so the window guard is the only producer.
    const narrowed = {
      ...cleanConstraints(),
      sessionWindows: [{ from: at(MON, "09:00"), to: at(MON, "11:15") }],
    };
    const r = checkBoard(cleanBoard(), narrowed);
    expect(kinds(r.findings)).toEqual(["outside_session_windows"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-2"]);

    // ...and the boundary: a window closing exactly at the fixture's end
    // contains it, so `<=` is right and `<` would red a legal board.
    const exact = {
      ...cleanConstraints(),
      sessionWindows: [{ from: at(MON, "09:00"), to: at(MON, "11:30") }],
    };
    expect(checkBoard(cleanBoard(), exact).findings).toEqual([]);
  });

  it("treats an empty sessionWindows list as unrestricted", () => {
    const unrestricted = { ...cleanConstraints(), sessionWindows: [] };
    expect(checkBoard(movedTo(cleanBoard(), 0, MON, "07:00"), unrestricted).findings).toEqual(
      [],
    );
  });

  it("flags a fixture outside its own court's hours", () => {
    // 14:00 is inside the session window and outside court-1's 06:00-14:00.
    const r = checkBoard(movedTo(cleanBoard(), 2, MON, "14:00"), cleanConstraints());
    expect(kinds(r.findings)).toEqual(["outside_court_hours"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-2"]);
  });

  it("reads hours PER COURT — the same instant is legal on the wider court", () => {
    // A checker that unioned every court's hours passes the previous test and
    // fails this one.
    const r = checkBoard(movedTo(cleanBoard(), 2, MON, "14:00", COURT_2), cleanConstraints());
    expect(r.findings).toEqual([]);
  });

  it("lets a closed-day exception override the weekly hours", () => {
    const b = cleanBoard();
    const courts = b.courts.map((c) =>
      c.courtId === COURT_2 ? { ...c, exceptions: [{ date: MON, closed: true }] } : c,
    );
    const r = checkBoard({ ...b, courts }, cleanConstraints());
    expect(kinds(r.findings)).toEqual(["outside_court_hours"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-1"]);
  });

  it("lets a ranged exception REPLACE the weekly hours for that date", () => {
    // court-1's Monday becomes 10:00-14:00, so fx-0 (09:00) breaches and
    // fx-2 (11:00) does not. A checker that merely intersected or ignored the
    // exception gets a different count.
    const b = cleanBoard();
    const courts = b.courts.map((c) =>
      c.courtId === COURT_1
        ? { ...c, exceptions: [{ date: MON, closed: false, openMin: 600, closeMin: 840 }] }
        : c,
    );
    const r = checkBoard({ ...b, courts }, cleanConstraints());
    expect(kinds(r.findings)).toEqual(["outside_court_hours"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0"]);
  });

  it("treats a court with NO hours rows as open all day", () => {
    // `court-windows.ts`'s note 1: no calendar declared is a property of the
    // COURT, and calendars strictly SUBTRACT. Both directions in one case.
    const b = movedTo(cleanBoard(), 2, MON, "14:00");
    expect(kinds(checkBoard(b, cleanConstraints()).findings)).toEqual(["outside_court_hours"]);
    const courts = b.courts.map((c) => (c.courtId === COURT_1 ? { ...c, hours: [] } : c));
    expect(checkBoard({ ...b, courts }, cleanConstraints()).findings).toEqual([]);
  });

  it("treats a court with hours but none for that weekday as CLOSED", () => {
    // Same note 1, the other half: a declared calendar saying "not this
    // weekday" is not an absent one.
    const b = cleanBoard();
    const courts = b.courts.map((c) =>
      c.courtId === COURT_1 ? { ...c, hours: [{ weekday: 2, openMin: 360, closeMin: 840 }] } : c,
    );
    const r = checkBoard({ ...b, courts }, cleanConstraints());
    expect(kinds(r.findings)).toEqual(["outside_court_hours", "outside_court_hours"]);
    expect(r.findings.flatMap((f) => [...f.fixtureIds])).toEqual(["fx-0", "fx-2"]);
  });

  // --- a court the board never declared (finding R02) ---------------------
  //
  // Both directions in one case, and the SAME instant on both sides, so the
  // pair witnesses the lookup and not the clock. A checker that kept the old
  // silent skip passes the first half and fails the second — which is the
  // whole point: the second half is a board that reported CLEAN while an
  // entire rule had been skipped for that fixture.
  it("FLAGS a fixture on a court the board never declared, instead of skipping its hours", () => {
    // 14:00 is outside court-1's 06:00-14:00, so on a DECLARED court this
    // instant reds. That is the control: it proves the instant is judgeable
    // and that the second half's silence would have been the lookup's doing.
    const known = checkBoard(movedTo(cleanBoard(), 2, MON, "14:00"), cleanConstraints());
    expect(kinds(known.findings)).toEqual(["outside_court_hours"]);

    // The same fixture at the same instant, moved onto a court id that is in
    // no `board.courts` entry. Court-hours containment is a rule the
    // product's own `/validate` does not block on, so the bench is its only
    // gate — and this used to walk out of the rule with no finding, no
    // `unchecked` line, and `clean: true`.
    const unknown = checkBoard(
      movedTo(cleanBoard(), 2, MON, "14:00", "court-not-in-this-venue"),
      cleanConstraints(),
    );
    expect(kinds(unknown.findings)).toEqual(["court_not_declared"]);
    expect(unknown.findings[0].fixtureIds).toEqual(["fx-2"]);
    expect(unknown.clean).toBe(false);
    // Names the id it could not resolve. Without this the finding could cite
    // any court at all and a reader could not tell which row to open.
    expect(unknown.findings[0].detail).toContain("court-not-in-this-venue");
  });

  it("does NOT flag a placed fixture that carries no court at all", () => {
    // The other half of the old guard, and deliberately still a skip. An
    // absent `court_id` is a state the product genuinely returns — `board.ts`
    // sets `courtId` only when `fixture.court_id` is a string — so a fixture
    // given a time and no court is a product answer this rule has no calendar
    // to judge, not a board referencing something that does not exist.
    // Flagging it here would file a false product defect from the court-hours
    // rule, and the two cases are separated so neither can cover for the
    // other.
    const b = cleanBoard();
    const f = [...b.fixtures];
    const { courtId: _dropped, ...courtless } = f[2];
    f[2] = { ...courtless, start: at(MON, "14:00"), end: at(MON, "14:00") + 30 * 60_000 };
    const r = checkBoard({ ...b, fixtures: f }, cleanConstraints());
    expect(kinds(r.findings)).toEqual([]);
    expect(r.clean).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Rule 3 — rest minima
  // -----------------------------------------------------------------------

  it("flags an entrant below rest, and reports measured vs required", () => {
    // fx-0 ends 09:30, fx-2 starts 09:50 -> 20 minutes of rest against 60.
    // `hard: []` so only the top-level floor can produce a finding.
    const b = movedTo(cleanBoard(), 2, MON, "09:50");
    const r = checkBoard(b, { ...cleanConstraints(), hard: [] });
    expect(r.findings[0].kind).toBe("entrant_below_rest");
    expect(r.findings[0].measured).toBe(20);
    expect(r.findings[0].required).toBe(60);
    // e-a and e-c both play fx-2, so both series breach; nothing else does.
    expect(kinds(r.findings)).toEqual(["entrant_below_rest", "entrant_below_rest"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
    expect(r.findings[1].fixtureIds).toEqual(["fx-1", "fx-2"]);
  });

  it("passes an entrant exactly AT the rest floor", () => {
    // fx-0 ends 09:30, fx-2 starts 10:30 -> exactly 60. A `<=` reds this.
    const b = movedTo(cleanBoard(), 2, MON, "10:30");
    expect(checkBoard(b, { ...cleanConstraints(), hard: [] }).findings).toEqual([]);
  });

  it("treats perEntrantMinRest 0 as no floor at all", () => {
    const b = movedTo(cleanBoard(), 2, MON, "09:30");
    expect(
      checkBoard(b, { ...cleanConstraints(), perEntrantMinRest: 0, hard: [] }).findings,
    ).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Rule 4 — day caps
  // -----------------------------------------------------------------------

  it("flags a day cap breach at count+1, and passes at exactly count", () => {
    const b = cleanBoard();
    const atCap = {
      ...cleanConstraints(),
      hard: [{ type: "max_fixtures_per_day" as const, count: 2, scope: { kind: "every_entrant" as const } }],
    };
    expect(checkBoard(b, atCap).findings).toEqual([]);

    const overCap = {
      ...atCap,
      hard: [{ type: "max_fixtures_per_day" as const, count: 1, scope: { kind: "every_entrant" as const } }],
    };
    const r = checkBoard(b, overCap);
    // e-a and e-c each play twice.
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded", "day_cap_exceeded"]);
    expect(r.findings[0].measured).toBe(2);
    expect(r.findings[0].required).toBe(1);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
  });

  it("does not red an entrant a day cap was not scoped to", () => {
    // e-b plays once. A cap of 1 scoped to e-b is satisfied even though e-a
    // plays twice on the same board.
    const scoped = {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day" as const,
          count: 1,
          scope: { kind: "entrant" as const, entrantId: "e-b" },
        },
      ],
    };
    expect(checkBoard(cleanBoard(), scoped).findings).toEqual([]);

    const onEa = {
      ...scoped,
      hard: [
        {
          type: "max_fixtures_per_day" as const,
          count: 1,
          scope: { kind: "entrant" as const, entrantId: "e-a" },
        },
      ],
    };
    const r = checkBoard(cleanBoard(), onEa);
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
  });

  it("tallies a competition scope WHOLE-RUN and every_entrant PER ENTRANT", () => {
    // Same board, same count: the competition scope counts three fixtures on
    // Monday and breaches; every_entrant counts at most two per entrant and
    // does not. This is `constraints.ts:36-50`'s worked example — reading a
    // universal scope as a whole-run cap caps the field.
    const wholeRun = {
      ...cleanConstraints(),
      hard: [
        { type: "max_fixtures_per_day" as const, count: 2, scope: { kind: "competition" as const } },
      ],
    };
    const perEntrant = {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day" as const,
          count: 2,
          scope: { kind: "every_entrant" as const },
        },
      ],
    };
    const r = checkBoard(cleanBoard(), wholeRun);
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded"]);
    expect(r.findings[0].measured).toBe(3);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-1", "fx-2"]);
    expect(checkBoard(cleanBoard(), perEntrant).findings).toEqual([]);
  });

  it("counts a day cap per LOCAL day, so a round on the next day resets it", () => {
    const overCap = {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day" as const,
          count: 1,
          scope: { kind: "every_entrant" as const },
        },
      ],
    };
    // fx-2 on Tuesday: e-a now plays once on each day.
    const spread = movedTo(cleanBoard(), 2, TUE, "11:00");
    expect(kinds(checkBoard(spread, overCap).findings)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Rule 5 — pin integrity
  // -----------------------------------------------------------------------

  it("passes a pin that held", () => {
    const pins = [{ fixtureId: "fx-0", start: at(MON, "09:00"), courtId: COURT_1 }];
    expect(checkBoard(cleanBoard(), { ...cleanConstraints(), pins }).findings).toEqual([]);
  });

  it("flags a pin whose start moved", () => {
    const pins = [{ fixtureId: "fx-0", start: at(MON, "09:00"), courtId: COURT_1 }];
    const r = checkBoard(movedTo(cleanBoard(), 0, MON, "09:30"), {
      ...cleanConstraints(),
      pins,
    });
    expect(kinds(r.findings)).toEqual(["pin_moved"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0"]);
  });

  it("flags a pin whose COURT moved even though its start held", () => {
    // The two halves of the pin predicate get their own case each, so
    // deleting either alone reds something.
    const pins = [{ fixtureId: "fx-2", start: at(MON, "11:00"), courtId: COURT_1 }];
    const moved = withFixture(cleanBoard(), 2, { courtId: COURT_2 });
    const r = checkBoard(moved, { ...cleanConstraints(), pins });
    expect(kinds(r.findings)).toEqual(["pin_moved"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-2"]);
  });

  it("flags a pin whose fixture is not on the board at all", () => {
    const pins = [{ fixtureId: "fx-gone", start: at(MON, "09:00"), courtId: COURT_1 }];
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), pins });
    expect(kinds(r.findings)).toEqual(["pin_moved"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-gone"]);
  });

  // -----------------------------------------------------------------------
  // Rule 6 — officials
  // -----------------------------------------------------------------------

  it("flags one official on two overlapping fixtures", () => {
    // o-1 already works fx-0 and fx-2, which never overlap. Give fx-1 o-1 as
    // well: fx-0 and fx-1 share 09:00-09:30 on different courts.
    const b = withFixture(cleanBoard(), 1, { officialIds: ["o-1"] });
    const r = checkBoard(b, cleanConstraints());
    expect(kinds(r.findings)).toEqual(["official_double_booking"]);
    expect([...r.findings[0].fixtureIds].sort()).toEqual(["fx-0", "fx-1"]);
  });

  it("REDS when a division that declared officials fetches none", () => {
    const b = cleanBoard();
    const f = b.fixtures.map((x) => ({ ...x, officialIds: [] }));
    const r = checkBoard(
      { ...b, fixtures: f },
      { ...cleanConstraints(), declaresOfficials: true },
    );
    expect(kinds(r.findings)).toContain("officials_unreadable");
  });

  it("does NOT red an empty officials array when the pack declared none", () => {
    const b = cleanBoard();
    const f = b.fixtures.map((x) => ({ ...x, officialIds: [] }));
    const r = checkBoard(
      { ...b, fixtures: f },
      { ...cleanConstraints(), declaresOfficials: false },
    );
    expect(r.findings).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Rule 7 — round order
  // -----------------------------------------------------------------------

  // ORDER-DIFFERENTIAL: every fixture is individually legal. Only the
  // sequence is wrong, so a rule that checked each row in isolation passes
  // this board and the test still fails.
  it("flags round 2 scheduled on a day before round 1", () => {
    const r = checkBoard(roundsAcrossDays(), cleanConstraints());
    expect(r.findings[0].kind).toBe("round_order_day");
    expect(r.findings[0].fixtureIds).toHaveLength(2);
    expect(kinds(r.findings)).toEqual(["round_order_day", "round_order_day"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
    expect(r.findings[1].fixtureIds).toEqual(["fx-1", "fx-2"]);
  });

  it("flags round 2 starting before round 1 on the SAME day", () => {
    const r = checkBoard(roundsSameDay(), cleanConstraints());
    expect(kinds(r.findings)).toEqual(["round_order_same_day", "round_order_same_day"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
  });

  it("does NOT apply round order to a non-round-robin stage", () => {
    const r = checkBoard(roundsAcrossDays(), { ...cleanConstraints(), isRoundRobin: false });
    expect(r.findings).toHaveLength(0);
  });

  it("passes rounds that share a start on the same day", () => {
    // r1 and r2 both at 11:00 on different courts: `start(r) <= start(r')`
    // holds, so a `<` here would red a legal board.
    const moved = movedTo(movedTo(cleanBoard(), 0, MON, "11:00"), 2, MON, "11:00", COURT_2);
    // o-1 works both of them; give the round-2 fixture its own official so
    // the officials rule does not answer for the round-order rule.
    const b = withFixture(moved, 2, { officialIds: ["o-3"] });
    const r = checkBoard(b, { ...cleanConstraints(), perEntrantMinRest: 0, hard: [] });
    expect(kinds(r.findings)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Rule 5 — wall-clock bounds (`not_before` / `not_after`)
  //
  // The clean board's local starts are 09:00, 09:00 and 11:00 in
  // `Europe/London` (BST), i.e. 08:00Z, 08:00Z and 10:00Z. Every case below
  // replaces `hard` outright so only the bound under test can produce a
  // finding.
  // -----------------------------------------------------------------------

  const COMPETITION: ConstraintScope = { kind: "competition" };
  const notBefore = (minutesIntoDay: number, scope: ConstraintScope = COMPETITION) => ({
    ...cleanConstraints(),
    hard: [{ type: "not_before" as const, minutesIntoDay, scope }],
  });
  const notAfter = (minutesIntoDay: number, scope: ConstraintScope = COMPETITION) => ({
    ...cleanConstraints(),
    hard: [{ type: "not_after" as const, minutesIntoDay, scope }],
  });

  it("flags every fixture starting before a not_before bound", () => {
    // 09:30 = 570. fx-0 and fx-1 start at 540; fx-2 at 660 is clear.
    const r = checkBoard(cleanBoard(), notBefore(570));
    expect(kinds(r.findings)).toEqual(["not_before_breached", "not_before_breached"]);
    expect(r.findings.flatMap((f) => [...f.fixtureIds])).toEqual(["fx-0", "fx-1"]);
    expect(r.findings[0].measured).toBe(540);
    expect(r.findings[0].required).toBe(570);
  });

  it("treats a start exactly ON a not_before as legal", () => {
    // `calendar.ts:747-750`: the placer and the verifier both use a STRICT
    // `<`, and an off-by-one here reds boards the product's own gate accepts.
    expect(checkBoard(cleanBoard(), notBefore(540)).findings).toEqual([]);
  });

  it("flags a fixture starting after a not_after bound", () => {
    // 10:30 = 630. Only fx-2 (660) breaches.
    const r = checkBoard(cleanBoard(), notAfter(630));
    expect(kinds(r.findings)).toEqual(["not_after_breached"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-2"]);
    expect(r.findings[0].measured).toBe(660);
    expect(r.findings[0].required).toBe(630);
  });

  it("bounds the START only — a fixture may FINISH after a not_after", () => {
    // fx-2 starts exactly at 11:00 (660) and runs to 11:30 (690). The product
    // compares `hhmmInTz(a.startAt, tz)` and nothing else
    // (`calendar.ts:1527-1531`), so this board is legal and a checker that
    // bounded the end would red it.
    expect(checkBoard(cleanBoard(), notAfter(660)).findings).toEqual([]);
  });

  it("judges a wall-clock bound in the BOARD's zone — legal in UTC, illegal in BST", () => {
    // Identical instants, identical rule. In `Europe/London` fx-2 reads 11:00
    // and breaches a 10:30 bound; in UTC the same instant reads 10:00 and does
    // not. A checker that took the clock off the epoch, or off the host, gives
    // one answer for both boards and fails this.
    const rule = notAfter(630);
    const b = cleanBoard();
    expect(kinds(checkBoard(b, rule).findings)).toEqual(["not_after_breached"]);
    expect(checkBoard({ ...b, tz: "UTC" }, rule).findings).toEqual([]);
  });

  it("applies a wall-clock bound through its SCOPE, not to every fixture", () => {
    // e-b plays fx-0 only. A rule applied universally reds fx-1 as well.
    const r = checkBoard(
      cleanBoard(),
      notBefore(570, { kind: "entrant", entrantId: "e-b" }),
    );
    expect(kinds(r.findings)).toEqual(["not_before_breached"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0"]);
  });

  it("fires nothing for a wall-clock bound scoped to nobody on this board", () => {
    const r = checkBoard(
      cleanBoard(),
      notBefore(570, { kind: "entrant", entrantId: "e-not-entered" }),
    );
    expect(r.findings).toEqual([]);
  });

  it("fires ONCE per fixture under a universal scope, not once per entrant", () => {
    // `every_entrant` yields a key per entrant, and fx-0 has two. A rule that
    // emitted per key would report this breach twice.
    const r = checkBoard(cleanBoard(), notBefore(570, { kind: "every_entrant" }));
    expect(kinds(r.findings)).toEqual(["not_before_breached", "not_before_breached"]);
    expect(r.findings.flatMap((f) => [...f.fixtureIds])).toEqual(["fx-0", "fx-1"]);
  });



  // -----------------------------------------------------------------------
  // The two `tallyKeys` arms nothing exercised
  //
  // A `return []` mutant on either survived the whole suite and produced the
  // same false-clean the `person` arm did — the same trap, two arms over.
  // -----------------------------------------------------------------------

  it("tallies a division-scoped cap on THAT division only", () => {
    // fx-1 is moved to a SECOND division on purpose. Every fixture on the
    // clean board shares one division, so a scoped-to-division assertion made
    // against it passes whether or not the arm filters — vacuous in exactly
    // the way the arm was.
    const b = withFixture(cleanBoard(), 1, { divisionId: "div-two" });
    const r = checkBoard(b, {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day",
          count: 1,
          scope: { kind: "division", divisionId: DIVISION_ID },
        },
      ],
    });
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded"]);
    // fx-1 is absent and the count is 2, not 3: an arm that keyed every
    // fixture regardless of division gives both away at once.
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
    expect(r.findings[0].measured).toBe(2);

    // The other direction: the division holding a single fixture is under cap.
    const other = checkBoard(b, {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day",
          count: 1,
          scope: { kind: "division", divisionId: "div-two" },
        },
      ],
    });
    expect(other.findings).toEqual([]);
  });

  it("tallies a pool-scoped cap per pool, and requires the DIVISION to match too", () => {
    // fx-0 and fx-2 are pool-a; fx-1 is pool-b. The fixtures already carried
    // these and no test had ever read `poolId`.
    const cap = (divisionId: string, pool: string) => ({
      ...cleanConstraints(),
      hard: [
        { type: "max_fixtures_per_day" as const, count: 1, scope: { kind: "pool" as const, divisionId, pool } },
      ],
    });

    const a = checkBoard(cleanBoard(), cap(DIVISION_ID, "pool-a"));
    expect(kinds(a.findings)).toEqual(["day_cap_exceeded"]);
    expect(a.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);

    // pool-b holds one fixture, so it is under the same cap.
    expect(checkBoard(cleanBoard(), cap(DIVISION_ID, "pool-b")).findings).toEqual([]);

    // The pool arm is a TWO-part predicate: same pool name, wrong division,
    // matches nothing. Without this an arm that dropped the division half
    // passes the two cases above.
    expect(checkBoard(cleanBoard(), cap("div-two", "pool-a")).findings).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Person scopes — the branch nothing exercised, and the reason `board.ts`
  // now refuses to encode one
  // -----------------------------------------------------------------------

  /** Every fixture stripped of its persons — what `schedule.ts` actually
   *  produces, because the product's `Fixture` carries no persons at all. */
  function withoutPersons(board: Board): Board {
    return { ...board, fixtures: board.fixtures.map((f) => ({ ...f, personIds: [] })) };
  }

  it("tallies a person-scoped day cap per PERSON when persons are present", () => {
    // p-a plays fx-0 and fx-2. This is the only thing that proves `tallyKeys`'
    // person branch resolves at all — no test used a person scope before.
    const r = checkBoard(cleanBoard(), {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day",
          count: 1,
          scope: { kind: "person", personKey: "p-a" },
        },
      ],
    });
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-0", "fx-2"]);
    expect(r.findings[0].measured).toBe(2);
  });

  it("matches NOTHING for a person scope on a board with no persons — the false-clean", () => {
    // The same rule and the same timetable, with `personIds` as a real board
    // has them. The rule does not fail: it silently covers no fixture and the
    // report comes back clean. That is why `board.ts` reports a person-scoped
    // rule as unmodelled rather than encoding it, and this case is what makes
    // the hole visible instead of theoretical.
    const r = checkBoard(withoutPersons(cleanBoard()), {
      ...cleanConstraints(),
      hard: [
        {
          type: "max_fixtures_per_day",
          count: 1,
          scope: { kind: "person", personKey: "p-a" },
        },
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("applies an every_person wall-clock bound per person, and to nobody without persons", () => {
    const rule = {
      ...cleanConstraints(),
      hard: [
        { type: "not_before" as const, minutesIntoDay: 570, scope: { kind: "every_person" as const } },
      ],
    };
    const present = checkBoard(cleanBoard(), rule);
    expect(kinds(present.findings)).toEqual(["not_before_breached", "not_before_breached"]);
    expect(present.findings.flatMap((f) => [...f.fixtureIds])).toEqual(["fx-0", "fx-1"]);

    expect(checkBoard(withoutPersons(cleanBoard()), rule).findings).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // The report's own contract
  // -----------------------------------------------------------------------

  it("forwards unmodelled constraints into unchecked, and stays clean", () => {
    const c = { ...cleanConstraints(), unmodelled: [{ type: "fixture_on_weekday", reason: "x" }] };
    const r = checkBoard(cleanBoard(), c);
    expect(r.clean).toBe(true);
    expect(r.unchecked).toEqual(c.unmodelled);
  });

  it("ignores unplaced fixtures rather than treating start=undefined as 0", () => {
    // Epoch 0 is 1970-01-01, which is outside every session window, outside
    // both courts' hours and a day BEFORE round 1 — a checker that coerced
    // `undefined` would red four rules at once.
    const b = withFixture(cleanBoard(), 2, { start: undefined, end: undefined });
    const r = checkBoard(b, cleanConstraints());
    expect(r.findings).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("names its own division on every finding", () => {
    const r = checkBoard(movedTo(cleanBoard(), 0, MON, "07:00"), cleanConstraints());
    expect(r.findings.map((f) => f.divisionRef)).toEqual(["d-one"]);
  });
});

// ---------------------------------------------------------------------------
// B04 T7a (fix round 1) — _tiny's OWN declared scheduleConfig, live for real
// ---------------------------------------------------------------------------
//
// Every case in this block is grounded in `_tiny`'s REAL declared config —
// via `buildTinyPack()` and the real `encodeConstraints`, never a hand-typed
// copy of its numbers — because "the pack now declares a blackout" and "the
// blackout rule notices" are different claims (task brief). Rules 2a
// (session windows), 2b (blackouts), 2c (court hours), 3 (rest) and 4 (day
// caps) were ALL vacuous on `_tiny` before T7a.
//
// Fix round 1: T7a's first cut declared `max_fixtures_per_day` at `count: 3`
// against a division that plays exactly 3 fixtures per entrant — satisfied
// by the live schedule, but pinned at the cap BY THE FIXTURE COUNT ITSELF, so
// no board `_tiny` can actually produce could ever violate it (only a
// hand-added fourth fixture could, which is worth keeping but is not what a
// real defect would look like). `count: 2` fixes that: it forces the third
// `d-tiny` fixture onto a SECOND calendar day on every real run, and now
// `_tiny`'s own three real fixtures placed on ONE day genuinely breach it
// (the "4b" case below). The old blackout (12:00-12:30) sat 90 minutes after
// this pack's schedule ever runs and could never be hit either way; it is
// now 09:30-12:00 on day 1, inside the band the schedule actually occupies.
//
// The clean board below is the EXACT schedule `_tiny.ts`'s own comment
// documents and `_schedule-routes.ts`'s fake scheduler actually produces on a
// default run (verified by hand against all five constraints in both
// places):
//
//   fx-tiny-1  2099-01-01 (Thu)  09:00  c-tiny-1   [the R22 pin: this
//                                                    division's first
//                                                    declared stream is
//                                                    ALWAYS locked to its own
//                                                    startAt/first court
//                                                    before `auto` runs —
//                                                    `resolveScheduleLocks`,
//                                                    `suites/tiny.ts` — which
//                                                    is why the blackout
//                                                    starts at 09:30, not
//                                                    09:00: it must abut this
//                                                    fixture, not swallow it]
//   fx-tiny-2  2099-01-01 (Thu)  09:45  c-tiny-2
//   fx-tiny-3  2099-01-02 (Fri)  09:00  c-tiny-1
//
// Each violation case moves exactly ONE fixture, chosen so it trips the
// named rule alone: `_tiny.ts`'s court hours close an hour before its
// session windows do, specifically so a move can cross one bound without
// the other, and day 3 (2099-01-03) is left off the session-window list on
// purpose so it stays the region that violates 2a.
describe("checkBoard — _tiny's own declared config is live (B04 T7a)", () => {
  const TINY_PACK = buildTinyPack();
  const TINY_DIVISION = TINY_PACK.divisions.find((d) => d.ref === "d-tiny");
  if (TINY_DIVISION === undefined) {
    throw new Error("fixture guard: _tiny must declare a d-tiny division");
  }
  const TINY_CONFIG = TINY_DIVISION.scheduleConfig as Record<string, unknown>;
  const TINY_COURT_HOURS = TINY_PACK.venues?.[0]?.courts.find((c) => c.ref === "c-tiny-1")?.hours ?? [];

  const TINY_COURT_ID_BY_REF = new Map([
    ["c-tiny-1", "crt-1"],
    ["c-tiny-2", "crt-2"],
  ]);

  // `declaresOfficials: false` and `pins: []`: this block is about rules
  // 2a-4 only, so officials and pin integrity are left inert rather than
  // adding findings this board was never built to carry. (The R22 PIN
  // MECHANISM in the real wiring is a fact about how the LIVE schedule is
  // produced, not something `checkBoard` itself needs told — pin integrity
  // and window containment are independent rules over the same board.)
  const TINY_CONSTRAINTS: EncodedConstraints = encodeConstraints({
    divisionRef: "d-tiny",
    scheduleConfig: TINY_CONFIG,
    courtIdByRef: TINY_COURT_ID_BY_REF,
    isRoundRobin: true,
    pins: [],
    declaresOfficials: false,
  });

  // The whole block's premise, asserted once and loudly: if `_tiny` ever
  // regressed to declaring vacuous sentinels again, every case below would
  // either stop compiling against real fixtures or pass for the wrong
  // reason — this is what makes that regression visible immediately.
  it("rests on _tiny's own config actually being non-vacuous", () => {
    expect(TINY_CONSTRAINTS.perEntrantMinRest).toBeGreaterThan(0);
    expect(TINY_CONSTRAINTS.blackouts.length).toBeGreaterThan(0);
    expect(TINY_CONSTRAINTS.sessionWindows.length).toBeGreaterThan(0);
    const dayCapRule = TINY_CONSTRAINTS.hard.find((h) => h.type === "max_fixtures_per_day");
    expect(dayCapRule?.type).toBe("max_fixtures_per_day");
    // Fix round 1's own premise: the cap must be BELOW the fixture count, or
    // it is unreachable by construction again (finding 1 of the fix round).
    expect(dayCapRule?.type === "max_fixtures_per_day" ? dayCapRule.count : undefined).toBeLessThan(3);
    expect(TINY_COURT_HOURS.length).toBeGreaterThan(0);
  });

  const TINY_DIVISION_ID = "div-tiny";
  const TINY_TEMPLATE = [
    { fixtureId: "fx-tiny-1", extKey: "rr-r1-c1", iso: "2099-01-01T09:00:00.000Z", courtId: "crt-1", roundNo: 1 },
    { fixtureId: "fx-tiny-2", extKey: "rr-r2-c1", iso: "2099-01-01T09:45:00.000Z", courtId: "crt-2", roundNo: 2 },
    { fixtureId: "fx-tiny-3", extKey: "rr-r3-c1", iso: "2099-01-02T09:00:00.000Z", courtId: "crt-1", roundNo: 3 },
  ] as const;

  /** One of `_tiny`'s three real `d-tiny` fixtures, at its own live-run slot
   *  unless `iso`/`courtId` says otherwise. Both entrants on every one,
   *  matching `_tiny.ts`'s own streams (`e-alpha`/`e-bravo` play all three). */
  function tinyFixture(
    index: 0 | 1 | 2,
    overrides: { iso?: string; courtId?: string; roundNo?: number } = {},
  ): Board["fixtures"][number] {
    const t = TINY_TEMPLATE[index];
    const start = Date.parse(overrides.iso ?? t.iso);
    return {
      fixtureId: t.fixtureId,
      extKey: t.extKey,
      divisionId: TINY_DIVISION_ID,
      divisionRef: "d-tiny",
      roundNo: overrides.roundNo ?? t.roundNo,
      start,
      end: start + 30 * 60_000,
      courtId: overrides.courtId ?? t.courtId,
      entrantIds: ["e-alpha", "e-bravo"],
      personIds: [],
      officialIds: [],
      locked: false,
    };
  }

  function tinyBoard(fixtures: readonly Board["fixtures"][number][]): Board {
    return {
      divisionId: TINY_DIVISION_ID,
      divisionRef: "d-tiny",
      tz: TINY_PACK.org.timezone,
      fixtures,
      courts: [
        { courtId: "crt-1", name: "Court 1", venueId: "venue-tiny", hours: TINY_COURT_HOURS, exceptions: [] },
        { courtId: "crt-2", name: "Court 2", venueId: "venue-tiny", hours: TINY_COURT_HOURS, exceptions: [] },
      ],
    };
  }

  it("passes the schedule _tiny's own live run actually produces", () => {
    const r = checkBoard(tinyBoard([tinyFixture(0), tinyFixture(1), tinyFixture(2)]), TINY_CONSTRAINTS);
    expect(r.findings).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("2a — flags a fixture moved to a day the session window never names", () => {
    // `sessionWindows` covers day 1 and day 2 only. fx-3 moved from day 2 to
    // day 3 (Saturday, weekday 6 — still inside the court's own declared
    // hours, and outside the single-day blackout) is caught ONLY by the
    // window: rest stays huge, the day cap (2) is not reached on day 1 or
    // day 3, and round order still holds (round 3 later than round 2, day 3
    // after day 1).
    const moved = tinyFixture(2, { iso: "2099-01-03T09:00:00.000Z" });
    const r = checkBoard(tinyBoard([tinyFixture(0), tinyFixture(1), moved]), TINY_CONSTRAINTS);
    expect(kinds(r.findings)).toEqual(["outside_session_windows"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-tiny-3"]);
  });

  it("2b — flags a fixture moved inside the declared blackout", () => {
    // The blackout is c-tiny-1, 09:30-12:00 on day 1. fx-2 moved onto that
    // court at 10:00 (still day 1, so the day cap stays at exactly 2; still
    // 30 minutes clear of fx-1's own 09:00-09:30, so rest is untouched) lands
    // inside it.
    const moved = tinyFixture(1, { iso: "2099-01-01T10:00:00.000Z", courtId: "crt-1" });
    const r = checkBoard(tinyBoard([tinyFixture(0), moved, tinyFixture(2)]), TINY_CONSTRAINTS);
    expect(kinds(r.findings)).toEqual(["inside_blackout"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-tiny-2"]);
  });

  it("2c — flags a fixture moved outside its own court's declared hours", () => {
    // 19:15 is past the court's 19:00 close but still inside the day-1
    // session window's 20:00 close — the asymmetry `_tiny.ts` declares on
    // purpose so this case cannot be satisfied by the window guard instead.
    // Still c-tiny-2, so the blackout (c-tiny-1 only) is not in play.
    const moved = tinyFixture(1, { iso: "2099-01-01T19:15:00.000Z" });
    const r = checkBoard(tinyBoard([tinyFixture(0), moved, tinyFixture(2)]), TINY_CONSTRAINTS);
    expect(kinds(r.findings)).toEqual(["outside_court_hours"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-tiny-2"]);
  });

  it("3 — flags both entrants below the declared rest floor", () => {
    // fx-1 ends 09:30; fx-2 moved to 09:35 leaves 5 minutes against a
    // declared floor of 15. Both entrants play every fixture, so both
    // series breach — matching the abstract rest tests above, grounded in
    // _tiny's own numbers instead. Still c-tiny-2, so the blackout is moot.
    const moved = tinyFixture(1, { iso: "2099-01-01T09:35:00.000Z" });
    const r = checkBoard(tinyBoard([tinyFixture(0), moved, tinyFixture(2)]), TINY_CONSTRAINTS);
    expect(kinds(r.findings)).toEqual(["entrant_below_rest", "entrant_below_rest"]);
    expect(r.findings[0].fixtureIds).toEqual(["fx-tiny-1", "fx-tiny-2"]);
    expect(r.findings[0].measured).toBe(5);
    expect(r.findings[0].required).toBe(15);
  });

  it("4a — flags a hand-added fourth same-day fixture breaching the declared day cap", () => {
    // A board `_tiny` cannot itself produce (it has only three fixtures) —
    // kept because it proves the RULE independently of what the pack can
    // reach, which is a different, still-worthwhile claim from "4b" below.
    // No `roundNo`, so round order (round-robin only) has nothing to compare
    // it against; c-tiny-2 at 15:00 so neither the blackout nor rest is
    // touched.
    const fourth: Board["fixtures"][number] = {
      fixtureId: "fx-tiny-4",
      divisionId: TINY_DIVISION_ID,
      divisionRef: "d-tiny",
      start: Date.parse("2099-01-01T15:00:00.000Z"),
      end: Date.parse("2099-01-01T15:30:00.000Z"),
      courtId: "crt-2",
      entrantIds: ["e-alpha", "e-bravo"],
      personIds: [],
      officialIds: [],
      locked: false,
    };
    const r = checkBoard(
      tinyBoard([tinyFixture(0), tinyFixture(1), tinyFixture(2), fourth]),
      TINY_CONSTRAINTS,
    );
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded", "day_cap_exceeded"]);
    expect(r.findings[0].measured).toBe(3);
    expect(r.findings[0].required).toBe(2);
    // fx-tiny-3 is on day 2, a SEPARATE bucket — only day 1's three fixtures
    // are named.
    expect(r.findings[0].fixtureIds).toEqual(["fx-tiny-1", "fx-tiny-2", "fx-tiny-4"]);
  });

  it("4b — the LIVE cap is violable from _tiny's own shape: three real fixtures, one day", () => {
    // Fix round 1's own point: with `count: 2`, `_tiny`'s OWN three real
    // fixtures — no synthetic fourth — breach the cap the moment a wrong
    // schedule puts all three on one day, which is exactly the shape an
    // actual placement defect would produce. fx-3 moved from its live day 2
    // slot onto day 1, c-tiny-2 (not c-tiny-1, so the blackout stays out of
    // it) at 11:00 — 45 minutes clear of fx-2 (09:45-10:15), so rest is not
    // what catches this.
    const moved = tinyFixture(2, { iso: "2099-01-01T11:00:00.000Z", courtId: "crt-2" });
    const r = checkBoard(tinyBoard([tinyFixture(0), tinyFixture(1), moved]), TINY_CONSTRAINTS);
    expect(kinds(r.findings)).toEqual(["day_cap_exceeded", "day_cap_exceeded"]);
    expect(r.findings[0].measured).toBe(3);
    expect(r.findings[0].required).toBe(2);
    expect(r.findings[0].fixtureIds).toEqual(["fx-tiny-1", "fx-tiny-2", "fx-tiny-3"]);
  });
});

// ---------------------------------------------------------------------------
// T7b — `CheckerReport.unexercised`: which MODELLED rules had nothing to
// judge on this board.
//
// Every case pairs a ZERO-CANDIDATE board (the rule is unexercised) against
// an EXERCISED-AND-CLEAN one (the rule ran, found nothing) — the distinction
// the task brief names explicitly: both produce zero findings for that rule,
// and only the first belongs in `unexercised`. Most "exercised and clean"
// cases are simply the baseline `cleanBoard()`/`cleanConstraints()`, which is
// already clean for every rule but rule 5 (no `not_before`/`not_after` is
// declared there) and rule 6 (no pin is declared there) — both deliberately,
// per `_board-fixtures.ts`'s own header.
// ---------------------------------------------------------------------------

describe("checkBoard — unexercised rules (T7b)", () => {
  const unexercisedRules = (r: { unexercised: readonly { rule: string }[] }): string[] =>
    r.unexercised.map((u) => u.rule);

  // -----------------------------------------------------------------------
  // Rule 1 — court double-booking
  // -----------------------------------------------------------------------

  it("rule 1 — unexercised when no two placed fixtures share a court", () => {
    const b = cleanBoard();
    const board: Board = {
      ...b,
      fixtures: b.fixtures.map((f, i) => (i === 2 ? { ...f, courtId: "court-3" } : f)),
      courts: [...b.courts, { courtId: "court-3", name: "Court 3", venueId: "venue-1", hours: [], exceptions: [] }],
    };
    const r = checkBoard(board, cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 1 — court double-booking");
  });

  it("rule 1 — exercised and clean when two fixtures share a court without overlapping", () => {
    // The baseline board: fx-0 and fx-2 both sit on court-1, at different times.
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 1 — court double-booking");
  });

  // -----------------------------------------------------------------------
  // Rule 2 — its three operands, tracked and reported SEPARATELY
  // -----------------------------------------------------------------------

  it("rule 2a — unexercised when no session window is declared", () => {
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), sessionWindows: [] });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 2a — session windows");
  });

  it("rule 2a — exercised and clean on the baseline board", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 2a — session windows");
  });

  it("rule 2b — unexercised when no blackout is declared", () => {
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), blackouts: [] });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 2b — blackouts");
  });

  it("rule 2b — exercised and clean on the baseline board", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 2b — blackouts");
  });

  // Fix round 1 — the MIDDLE case: a real, non-empty blackout list whose
  // scope never matches any PLACED fixture's court. This is the one that
  // survived unfound the first time, because `blackoutsExercised` was set
  // before the scope-match check rather than after it.
  it("rule 2b — unexercised when the declared blackout is scoped to a court no placed fixture occupies", () => {
    // court-3 is not COURT_1 or COURT_2 — no fixture on `cleanBoard()` is
    // ever placed there, so `applies` is false for every (fixture, blackout)
    // pair regardless of the wide time range below. A checker that counted
    // the loop merely RUNNING (rather than the scope actually matching)
    // would report this exercised.
    const r = checkBoard(cleanBoard(), {
      ...cleanConstraints(),
      blackouts: [{ courtId: "court-3", from: at(MON, "00:00"), to: at(MON, "23:59") }],
    });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 2b — blackouts");
  });

  // The opposite direction of the same fix: a blackout scoped to a court
  // that IS occupied, positioned so the fixture correctly avoids it in time.
  // This is what stops the fix from over-correcting into "only count it when
  // it fires", which would collapse `unexercised` back into `findings`.
  it("rule 2b — exercised and clean when the declared blackout is scoped to an occupied court but the fixture avoids it in time", () => {
    // court-1 is occupied by fx-0 (09:00-09:30) and fx-2 (11:00-11:30); this
    // blackout (13:00-14:00, same court) never overlaps either in TIME, but
    // its SCOPE does match — the case that must still read exercised.
    const r = checkBoard(cleanBoard(), {
      ...cleanConstraints(),
      blackouts: [{ courtId: COURT_1, from: at(MON, "13:00"), to: at(MON, "14:00") }],
    });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 2b — blackouts");
  });

  // The global case (no `courtId`) applies to every court, so it must read
  // exercised against any placed fixture — kept as its own case per the fix
  // brief rather than only inferred from the pre-existing "applies to every
  // court" finding test above.
  it("rule 2b — exercised when the blackout has no courtId (global) and a placed fixture is inside it", () => {
    const r = checkBoard(cleanBoard(), {
      ...cleanConstraints(),
      blackouts: [{ from: at(MON, "09:00"), to: at(MON, "09:30") }],
    });
    expect(kinds(r.findings)).toContain("inside_blackout");
    expect(unexercisedRules(r)).not.toContain("Rule 2b — blackouts");
  });

  it("rule 2c — unexercised when every court declares no hours", () => {
    const b = cleanBoard();
    const board: Board = { ...b, courts: b.courts.map((c) => ({ ...c, hours: [], exceptions: [] })) };
    const r = checkBoard(board, cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 2c — court hours");
  });

  it("rule 2c — exercised and clean on the baseline board", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 2c — court hours");
  });

  it("rule 2's three operands never collapse into one verdict — one vacuous does not silence, or false-report, the other two", () => {
    // Only blackouts emptied. Session windows and court hours are still real
    // and still exercised on this same board — a single "rule 2" flag would
    // report the whole rule exercised (session windows/hours have input) and
    // hide that the blackout operand did not, or the reverse.
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), blackouts: [] });
    const rules = unexercisedRules(r);
    expect(rules).toContain("Rule 2b — blackouts");
    expect(rules).not.toContain("Rule 2a — session windows");
    expect(rules).not.toContain("Rule 2c — court hours");
  });

  it("rule 2's three operands (and every other rule) derive from PLACEMENT, not from static declared config — nothing placed at all", () => {
    // `constraints` is untouched (blackouts, sessionWindows and both courts'
    // hours are all still genuinely declared) — only the BOARD changes, to one
    // where nothing is placed. A table of `.length > 0` predicates read beside
    // the rules would still report every one of these exercised; deriving from
    // the rule's own iteration over PLACED fixtures does not.
    const b = cleanBoard();
    const unplaced: Board = {
      ...b,
      fixtures: b.fixtures.map((f) => ({ ...f, start: undefined, end: undefined })),
    };
    const r = checkBoard(unplaced, cleanConstraints());
    expect(r.clean).toBe(true);
    const rules = unexercisedRules(r);
    expect(rules).toContain("Rule 1 — court double-booking");
    expect(rules).toContain("Rule 2a — session windows");
    expect(rules).toContain("Rule 2b — blackouts");
    expect(rules).toContain("Rule 2c — court hours");
    expect(rules).toContain("Rule 3 — rest minima");
    expect(rules).toContain("Rule 4 — day caps");
    expect(rules).toContain("Rule 7 — officials");
    expect(rules).toContain("Rule 8 — round order");
  });

  // -----------------------------------------------------------------------
  // Rule 3 — rest minima
  // -----------------------------------------------------------------------

  it("rule 3 — unexercised when perEntrantMinRest is 0", () => {
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), perEntrantMinRest: 0 });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 3 — rest minima");
  });

  it("rule 3 — exercised and clean on the baseline board", () => {
    // e-a plays fx-0 and fx-2, 90 minutes apart against a 60-minute floor.
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 3 — rest minima");
  });

  // -----------------------------------------------------------------------
  // Rule 4 — day caps
  // -----------------------------------------------------------------------

  it("rule 4 — unexercised when no max_fixtures_per_day rule is declared", () => {
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), hard: [] });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 4 — day caps");
  });

  it("rule 4 — exercised and clean on the baseline board", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 4 — day caps");
  });

  // -----------------------------------------------------------------------
  // Rule 5 — not_before / not_after
  // -----------------------------------------------------------------------

  it("rule 5 — unexercised when no not_before/not_after rule is declared (the baseline board)", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 5 — not_before / not_after");
  });

  it("rule 5 — exercised and clean when a wall-clock bound matches with no breach", () => {
    const r = checkBoard(cleanBoard(), {
      ...cleanConstraints(),
      hard: [
        ...cleanConstraints().hard,
        { type: "not_before", minutesIntoDay: 0, scope: { kind: "every_entrant" } },
      ],
    });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 5 — not_before / not_after");
  });

  // -----------------------------------------------------------------------
  // Rule 6 — pin integrity
  // -----------------------------------------------------------------------

  it("rule 6 — unexercised when no pin is declared (the baseline board)", () => {
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 6 — pin integrity");
  });

  it("rule 6 — exercised and clean when a held pin matches the board", () => {
    const b = cleanBoard();
    const held = b.fixtures[0];
    const r = checkBoard(b, {
      ...cleanConstraints(),
      pins: [{ fixtureId: held.fixtureId, start: held.start as number, courtId: held.courtId as string }],
    });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 6 — pin integrity");
  });

  // -----------------------------------------------------------------------
  // Rule 7 — officials
  // -----------------------------------------------------------------------

  it("rule 7 — unexercised when the pack does not declare officials", () => {
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), declaresOfficials: false });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 7 — officials");
  });

  it("rule 7 — exercised and clean on the baseline board", () => {
    // The baseline board declares officials AND every fixture carries one.
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 7 — officials");
  });

  // -----------------------------------------------------------------------
  // Rule 8 — round order
  // -----------------------------------------------------------------------

  it("rule 8 — unexercised when isRoundRobin is false", () => {
    const r = checkBoard(cleanBoard(), { ...cleanConstraints(), isRoundRobin: false });
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).toContain("Rule 8 — round order");
  });

  it("rule 8 — exercised and clean on the baseline board", () => {
    // fx-0 (round 1) and fx-2 (round 2) are a comparable, correctly-ordered pair.
    const r = checkBoard(cleanBoard(), cleanConstraints());
    expect(r.clean).toBe(true);
    expect(unexercisedRules(r)).not.toContain("Rule 8 — round order");
  });

  // -----------------------------------------------------------------------
  // Sanity: unexercised never touches `clean`, in either direction.
  // -----------------------------------------------------------------------

  it("does not make a report dirty, and does not launder a real finding into 'merely unexercised'", () => {
    // A genuinely DIRTY board (fx-2 inside the blackout) still names its
    // finding, and still carries whatever else was unexercised on it —
    // the two lists coexist rather than one crowding out the other.
    const r = checkBoard(movedTo(cleanBoard(), 2, MON, "12:00"), cleanConstraints());
    expect(kinds(r.findings)).toEqual(["inside_blackout"]);
    expect(r.clean).toBe(false);
    expect(unexercisedRules(r)).toContain("Rule 5 — not_before / not_after");
    expect(unexercisedRules(r)).toContain("Rule 6 — pin integrity");
  });
});
