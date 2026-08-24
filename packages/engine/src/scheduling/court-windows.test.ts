// P9.5 (D5b.5) — `usableWindows`, the ONE court-availability function.
//
// Every case here is a row of the owner-raised edge matrix in
// `docs/superpowers/specs/bench-product-value/portfolio-prompts/P09-5-window-unification.md`,
// which is itself an acceptance criterion: "a `usableWindows` that does not
// have a test per row is not done". Row numbers are cited per test.
import { describe, expect, it } from "vitest";
import { usableWindows, type CourtCalendar } from "./court-windows.ts";
import { zonedTimeToUtc } from "./tz.ts";

const TZ = "Europe/Amsterdam";

/** 2026-08-24 is a MONDAY (weekday 6 in JS terms is Sat; 1 is Mon — V367's
 *  `court_hours.weekday` is 0=Sunday, matching `weekdayOfYmd`). */
const MON = "2026-08-24";
const MONDAY = 1;

const at = (ymd: string, hhmm: string) => zonedTimeToUtc(ymd, hhmm, TZ);

/** A court open on Mondays for the given minute ranges and nothing else. */
const courtOpen = (...ranges: readonly [string, string][]): CourtCalendar => ({
  courtId: "court-a",
  hours: ranges.map(([from, to]) => ({
    weekday: MONDAY,
    openMin: Number(from.slice(0, 2)) * 60 + Number(from.slice(3)),
    closeMin: Number(to.slice(0, 2)) * 60 + Number(to.slice(3)),
  })),
  exceptions: [],
});

describe("usableWindows — court hours ∩ session windows (edge matrix row 1)", () => {
  it("intersects court hours with the session window rather than taking either side alone", () => {
    const calendar = courtOpen(["15:00", "20:00"]);

    const windows = usableWindows(calendar, { from: MON, to: MON }, {
      tz: TZ,
      sessionWindows: [{ from: at(MON, "09:00"), to: at(MON, "18:00") }],
    });

    expect(windows).toEqual([{ from: at(MON, "15:00"), to: at(MON, "18:00") }]);
  });
});

describe("usableWindows — no calendar declared (edge matrix row 12)", () => {
  it("treats a court with no hours as open all day: calendars strictly SUBTRACT", () => {
    const noCalendar: CourtCalendar = { courtId: "court-a", hours: [], exceptions: [] };

    const windows = usableWindows(noCalendar, { from: MON, to: MON }, { tz: TZ });

    expect(windows).toEqual([{ from: at(MON, "00:00"), to: at("2026-08-25", "00:00") }]);
  });
});

describe("usableWindows — exceptions override weekday hours (edge matrix rows 4, 5)", () => {
  it("row 4: a closed exception makes the court unusable on that DATE only", () => {
    const calendar: CourtCalendar = {
      ...courtOpen(["09:00", "17:00"]),
      exceptions: [{ date: MON, closed: true }],
    };

    // The Monday a week later has the same weekday hours and no exception.
    const nextMon = "2026-08-31";
    const windows = usableWindows(calendar, { from: MON, to: nextMon }, { tz: TZ });

    expect(windows).toEqual([{ from: at(nextMon, "09:00"), to: at(nextMon, "17:00") }]);
  });

  it("row 5: an exception with hours wins OUTRIGHT over the weekday rows — not merged, not intersected", () => {
    const calendar: CourtCalendar = {
      ...courtOpen(["09:00", "17:00"]),
      exceptions: [{ date: MON, closed: false, openMin: 19 * 60, closeMin: 21 * 60 }],
    };

    const windows = usableWindows(calendar, { from: MON, to: MON }, { tz: TZ });

    // 19:00–21:00 lies entirely OUTSIDE the weekday 09:00–17:00 rows, so a
    // merge would yield two windows and an intersection would yield none.
    expect(windows).toEqual([{ from: at(MON, "19:00"), to: at(MON, "21:00") }]);
  });
});

describe("usableWindows — blackouts subtract after the intersection (edge matrix row 8)", () => {
  it("subtracts a court-scoped blackout from this court and splits the window around it", () => {
    const calendar = courtOpen(["09:00", "17:00"]);

    const windows = usableWindows(calendar, { from: MON, to: MON }, {
      tz: TZ,
      blackouts: [{ court: "court-a", from: at(MON, "12:00"), to: at(MON, "13:00") }],
    });

    expect(windows).toEqual([
      { from: at(MON, "09:00"), to: at(MON, "12:00") },
      { from: at(MON, "13:00"), to: at(MON, "17:00") },
    ]);
  });

  it("ignores a blackout scoped to a DIFFERENT court", () => {
    const calendar = courtOpen(["09:00", "17:00"]);

    const windows = usableWindows(calendar, { from: MON, to: MON }, {
      tz: TZ,
      blackouts: [{ court: "court-b", from: at(MON, "12:00"), to: at(MON, "13:00") }],
    });

    expect(windows).toEqual([{ from: at(MON, "09:00"), to: at(MON, "17:00") }]);
  });

  it("applies an UNSCOPED blackout to every court", () => {
    const calendar = courtOpen(["09:00", "17:00"]);

    const windows = usableWindows(calendar, { from: MON, to: MON }, {
      tz: TZ,
      blackouts: [{ from: at(MON, "12:00"), to: at(MON, "13:00") }],
    });

    expect(windows).toEqual([
      { from: at(MON, "09:00"), to: at(MON, "12:00") },
      { from: at(MON, "13:00"), to: at(MON, "17:00") },
    ]);
  });
});
