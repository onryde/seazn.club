// P10 (A6, 2026-08-24 stranded-fixtures-and-capacity design, Ruling 1). A
// stranded fixture is an unplayed fixture assigned to a court that is
// archived or absent from `courts` entirely — NOT a court that merely has no
// calendar rows. The engine holds no database handle, so the server resolves
// the set (`strandedCourtIdsForDivision`) and passes it through
// `VerifyConfig.strandedCourtIds`, mirroring how `courtCalendars` already
// arrives. Reported, never blocking — same precedent `outside_court_hours`
// set one wave earlier (calendar.ts's `isBlockingConflict`).
import { describe, expect, it } from "vitest";
import { isBlockingConflict, validateAssignments, type Assignment, type VerifyConfig } from "./calendar.ts";

const base: VerifyConfig = {
  perEntrantMinRest: 0,
  gapMinutes: 0,
  blackouts: [],
  sessionWindows: [],
  matchMinutes: 60,
  tz: "Europe/Amsterdam",
};

const assignment = (court: string): Assignment => ({
  fixtureId: `f-${court}`,
  court,
  startAt: Date.UTC(2026, 7, 24, 9, 0), // Mon 24 Aug 2026 09:00Z
  endAt: Date.UTC(2026, 7, 24, 10, 0),
  entrants: [],
  people: [],
});

const strandedFor = (conflicts: ReturnType<typeof validateAssignments>) =>
  conflicts.filter((c) => c.details?.kind === "stranded_fixture");

describe("stranded_fixture", () => {
  it("reports a fixture whose court the server flagged stranded", () => {
    const conflicts = validateAssignments([assignment("court-archived")], {
      ...base,
      strandedCourtIds: ["court-archived"],
    });
    const stranded = strandedFor(conflicts);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({
      fixtureId: "f-court-archived",
      reason: "court",
      details: { kind: "stranded_fixture", court: "court-archived" },
    });
  });

  it("stays silent for an org with no calendars and no stranded set", () => {
    expect(strandedFor(validateAssignments([assignment("court-live")], base))).toEqual([]);
  });

  it("stays silent for a court that merely has no calendar rows", () => {
    const conflicts = validateAssignments([assignment("court-uncalendared")], {
      ...base,
      courtCalendars: [{ courtId: "court-other", hours: [], exceptions: [] }],
      strandedCourtIds: [],
    });
    expect(strandedFor(conflicts)).toEqual([]);
  });

  it("reports stranded independently of court hours, without duplicating outside_court_hours", () => {
    // Mon 24 Aug 2026 is weekday 1 (V367 convention: 0 = Sunday). Hours cover
    // the whole day, so the fixture fits and outside_court_hours must not
    // ALSO fire — one cause, one conflict, same reasoning the courtHourWindows
    // build comment gives for not double-subtracting blackouts.
    const conflicts = validateAssignments([assignment("court-archived")], {
      ...base,
      courtCalendars: [
        { courtId: "court-archived", hours: [{ weekday: 1, openMin: 0, closeMin: 1440 }], exceptions: [] },
      ],
      strandedCourtIds: ["court-archived"],
    });
    expect(strandedFor(conflicts)).toHaveLength(1);
    expect(conflicts.filter((c) => c.details?.kind === "outside_court_hours")).toEqual([]);
  });

  it("is reported but never blocking", () => {
    const conflicts = validateAssignments([assignment("court-archived")], {
      ...base,
      strandedCourtIds: ["court-archived"],
    });
    // Assert the REPORT first. Without this line the test passes trivially if
    // the push block is deleted while the carve-out survives: no conflicts at
    // all also filters to an empty blocking list.
    expect(conflicts.filter((c) => c.details?.kind === "stranded_fixture")).toHaveLength(1);
    expect(conflicts.filter(isBlockingConflict)).toEqual([]);
  });
});
