// P9.5 (D5b.5) — the regression this session exists for.
//
// P8 shipped `court_hours`/`court_exceptions` (V367) and a calendar editor, and
// NOTHING in scheduling read them: the scheduler would place at 09:00 on a
// court that does not open until 15:00. Closing that is only half the job. The
// other half is that the LATTICE and `/validate` must give the same answer, or
// we have rebuilt P9's `court_tag_mismatch` bug one constraint over — a board
// the placer would never produce sails through the verifier when a human drags
// a card there by hand.
//
// So every case below asserts BOTH sides on the same configuration: the slot is
// absent from the lattice, and an assignment sitting in it is a conflict.
import { describe, expect, it } from "vitest";
import { buildGrid } from "./build-grid.ts";
import { validateAssignments, type Assignment, type SlotConfig } from "./calendar.ts";
import type { CourtCalendar } from "./court-windows.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const SAT = Date.UTC(2026, 7, 8, 0, 0); // Sat 08 Aug 2026 00:00Z
const SATURDAY = 6;

const OPENS_AT_3PM: CourtCalendar = {
  courtId: "C1",
  hours: [{ weekday: SATURDAY, openMin: 15 * 60, closeMin: 20 * 60 }],
  exceptions: [],
};

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: SAT,
  matchMinutes: 60,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  tz: "UTC",
  window: { from: SAT, to: SAT + DAY },
  ...over,
});

const at = (hour: number): Assignment => ({
  fixtureId: "f1",
  court: "C1",
  startAt: SAT + hour * 60 * MIN,
  endAt: SAT + (hour + 1) * 60 * MIN,
  entrants: ["e1", "e2"],
  people: [],
});

const courtHourConflicts = (a: Assignment, config: SlotConfig & { courts: string[] }) =>
  validateAssignments([a], config).filter((c) => c.details?.kind === "outside_court_hours");

describe("court hours: the lattice and /validate agree", () => {
  it("offers no 09:00 slot on a court that opens at 15:00, and flags a card dragged there", () => {
    const config = cfg({ courtCalendars: [OPENS_AT_3PM] });

    const lattice = (buildGrid({ config }).byCourt.get("C1") ?? []).map(
      (i) => buildGrid({ config }).slots[i]!.startAt,
    );
    expect(lattice).not.toContain(SAT + 9 * 60 * MIN);

    expect(courtHourConflicts(at(9), config)).toHaveLength(1);
  });

  it("accepts a 16:00 card the lattice does offer", () => {
    const config = cfg({ courtCalendars: [OPENS_AT_3PM] });

    const g = buildGrid({ config });
    const starts = (g.byCourt.get("C1") ?? []).map((i) => g.slots[i]!.startAt);
    expect(starts).toContain(SAT + 16 * 60 * MIN);

    expect(courtHourConflicts(at(16), config)).toEqual([]);
  });

  it("flags a card that STARTS inside the window but runs past close (row 7)", () => {
    // 19:30 + 60min = 20:30 against a 20:00 close. A "starts in the window"
    // check passes this; a "fits the window" check does not, and both sides
    // must make the same choice.
    const config = cfg({ courtCalendars: [OPENS_AT_3PM] });
    const spillsOver: Assignment = {
      ...at(19),
      startAt: SAT + 19 * 60 * MIN + 30 * MIN,
      endAt: SAT + 20 * 60 * MIN + 30 * MIN,
    };

    const g = buildGrid({ config });
    const starts = (g.byCourt.get("C1") ?? []).map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(spillsOver.startAt);

    expect(courtHourConflicts(spillsOver, config)).toHaveLength(1);
  });

  it("says nothing about a court with no calendar — calendars strictly SUBTRACT", () => {
    const config = cfg({ courtCalendars: [OPENS_AT_3PM] });
    const onC2: Assignment = { ...at(9), court: "C2" };

    const g = buildGrid({ config });
    expect((g.byCourt.get("C2") ?? []).length).toBe(24);

    expect(courtHourConflicts(onC2, config)).toEqual([]);
  });

  it("honours a closed exception on both sides", () => {
    const config = cfg({
      courtCalendars: [{ ...OPENS_AT_3PM, exceptions: [{ date: "2026-08-08", closed: true }] }],
    });

    expect(buildGrid({ config }).byCourt.get("C1") ?? []).toEqual([]);
    expect(courtHourConflicts(at(16), config)).toHaveLength(1);
  });

  it("skips court hours on BOTH sides when no tz is configured", () => {
    // Asymmetry here would be the fork in miniature: the lattice bucketing a
    // weekday in UTC while the verifier skips it, or vice versa.
    const config = cfg({ tz: undefined, courtCalendars: [OPENS_AT_3PM] });

    expect((buildGrid({ config }).byCourt.get("C1") ?? []).length).toBe(24);
    expect(courtHourConflicts(at(9), config)).toEqual([]);
  });

  it("leaves a no-calendar org's lattice byte-identical — the pure-refactor proof", () => {
    // The acceptance criterion P9.5 owes: an org that has declared no court
    // calendars must get EXACTLY the lattice it got before this feature existed.
    // Enumerated analytically rather than snapshotted, because a snapshot taken
    // after the change can only prove the change is stable, never that it was
    // inert — and "inert for existing orgs" is the whole claim.
    //
    // 24 hourly starts per court, minus the two a 12:00-13:00 global blackout
    // eats on both courts, minus the one more a C1-scoped 09:00-10:00 blackout
    // eats. Sessions and blackouts only; no courtCalendars key at all.
    const config = cfg({
      blackouts: [
        { from: SAT + 12 * 60 * MIN, to: SAT + 13 * 60 * MIN },
        { court: "C1", from: SAT + 9 * 60 * MIN, to: SAT + 10 * 60 * MIN },
      ],
    });
    const hours = (...skip: number[]) =>
      Array.from({ length: 24 }, (_, h) => h)
        .filter((h) => !skip.includes(h))
        .map((h) => SAT + h * 60 * MIN);

    const g = buildGrid({ config });

    expect((g.byCourt.get("C1") ?? []).map((i) => g.slots[i]!.startAt)).toEqual(hours(9, 12));
    expect((g.byCourt.get("C2") ?? []).map((i) => g.slots[i]!.startAt)).toEqual(hours(12));
    // And declaring the key EMPTY must be indistinguishable from omitting it —
    // a caller that loads calendars and finds none must not get a different
    // board from one that never asked.
    const withEmpty = buildGrid({ config: { ...config, courtCalendars: [] } });
    expect(withEmpty.slots).toEqual(g.slots);
  });

  it("leaves an ARCHIVED court's existing card clean, per P9's A10 split", () => {
    // "The court violates a declared constraint" is this conflict. "The court is
    // gone" is the stranded-fixture case P10 owes (A6) and must stay clean here
    // — the same split P9 drew for court_tag_mismatch versus archival.
    const config = cfg({ courts: ["C2"], courtCalendars: [] });

    expect(courtHourConflicts(at(9), config)).toEqual([]);
  });
});
