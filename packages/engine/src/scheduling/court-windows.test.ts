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

describe("usableWindows — the court leaves the day entirely (edge matrix row 2)", () => {
  it("yields NO window for a day whose court hours and session window do not overlap", () => {
    const calendar = courtOpen(["15:00", "20:00"]);

    const windows = usableWindows(calendar, { from: MON, to: MON }, {
      tz: TZ,
      sessionWindows: [{ from: at(MON, "09:00"), to: at(MON, "13:00") }],
    });

    expect(windows).toEqual([]);
  });
});

describe("usableWindows — multi-range days (edge matrix rows 6, 7)", () => {
  it("row 6: a lunch gap between two ranges is not usable and the ranges do not merge", () => {
    const calendar = courtOpen(["09:00", "12:00"], ["14:00", "18:00"]);

    const windows = usableWindows(calendar, { from: MON, to: MON }, { tz: TZ });

    expect(windows).toEqual([
      { from: at(MON, "09:00"), to: at(MON, "12:00") },
      { from: at(MON, "14:00"), to: at(MON, "18:00") },
    ]);
  });

  it("row 7: the window ends exactly at close, leaving the caller to decide what FITS in it", () => {
    // usableWindows reports availability, not fit: a 60-minute match starting
    // 17:30 against an 18:00 close is the LATTICE's rejection to make, and it
    // can only make it because this window's `to` is exact.
    const calendar = courtOpen(["09:00", "18:00"]);

    const [only] = usableWindows(calendar, { from: MON, to: MON }, { tz: TZ });

    expect(only?.to).toBe(at(MON, "18:00"));
  });

  it("resolves close_min = 1440 as midnight ENDING the day, not midnight starting it", () => {
    const calendar: CourtCalendar = {
      courtId: "court-a",
      hours: [{ weekday: MONDAY, openMin: 20 * 60, closeMin: 1440 }],
      exceptions: [],
    };

    const windows = usableWindows(calendar, { from: MON, to: MON }, { tz: TZ });

    expect(windows).toEqual([{ from: at(MON, "20:00"), to: at("2026-08-25", "00:00") }]);
  });
});

describe("usableWindows — a declared calendar that omits a weekday", () => {
  it("closes the court on a weekday it has no hours for, rather than falling back to the full day", () => {
    // Distinct from row 12: this court HAS a calendar, and that calendar says
    // "Mondays only". Treating an absent weekday as unrestricted would make a
    // declared calendar mean the opposite of what it says.
    const mondaysOnly = courtOpen(["09:00", "17:00"]);
    const tue = "2026-08-25";

    const windows = usableWindows(mondaysOnly, { from: tue, to: tue }, { tz: TZ });

    expect(windows).toEqual([]);
  });
});

describe("usableWindows — DST days use civil local time (edge matrix row 9)", () => {
  const HOUR = 3_600_000;
  const noCalendar: CourtCalendar = { courtId: "court-a", hours: [], exceptions: [] };

  it("a spring-forward date is a 23-hour day", () => {
    const springForward = "2026-03-29"; // Europe/Amsterdam loses an hour

    const [only] = usableWindows(noCalendar, { from: springForward, to: springForward }, { tz: TZ });

    expect((only!.to - only!.from) / HOUR).toBe(23);
  });

  it("a fall-back date is a 25-hour day", () => {
    const fallBack = "2026-10-25"; // Europe/Amsterdam gains an hour

    const [only] = usableWindows(noCalendar, { from: fallBack, to: fallBack }, { tz: TZ });

    expect((only!.to - only!.from) / HOUR).toBe(25);
  });

  it("keeps declared hours at their CIVIL time across a DST boundary", () => {
    const sundayOpen: CourtCalendar = {
      courtId: "court-a",
      hours: [{ weekday: 0, openMin: 9 * 60, closeMin: 17 * 60 }],
      exceptions: [],
    };
    const before = "2026-10-18";
    const fallBack = "2026-10-25";

    const windows = usableWindows(sundayOpen, { from: before, to: fallBack }, { tz: TZ });

    // Same wall-clock hours both weeks; the UTC instants differ by the offset
    // change, which is exactly what "no UTC arithmetic" buys.
    expect(windows).toEqual([
      { from: at(before, "09:00"), to: at(before, "17:00") },
      { from: at(fallBack, "09:00"), to: at(fallBack, "17:00") },
    ]);
  });
});

describe("usableWindows — per court, never per division (edge matrix row 10)", () => {
  it("does not leak one venue's hours onto another venue's court", () => {
    const earlyCourt = courtOpen(["08:00", "12:00"]);
    const lateCourt: CourtCalendar = { ...courtOpen(["18:00", "22:00"]), courtId: "court-b" };
    const range = { from: MON, to: MON };

    expect(usableWindows(earlyCourt, range, { tz: TZ })).toEqual([
      { from: at(MON, "08:00"), to: at(MON, "12:00") },
    ]);
    expect(usableWindows(lateCourt, range, { tz: TZ })).toEqual([
      { from: at(MON, "18:00"), to: at(MON, "22:00") },
    ]);
  });
});

describe("usableWindows — a multi-day run resolves per date (edge matrix row 11)", () => {
  it("applies each date's own weekday hours across a Mon–Sat span", () => {
    const calendar: CourtCalendar = {
      courtId: "court-a",
      hours: [
        { weekday: 1, openMin: 9 * 60, closeMin: 12 * 60 }, // Monday
        { weekday: 3, openMin: 14 * 60, closeMin: 20 * 60 }, // Wednesday
        { weekday: 6, openMin: 10 * 60, closeMin: 18 * 60 }, // Saturday
      ],
      exceptions: [],
    };

    const windows = usableWindows(calendar, { from: MON, to: "2026-08-29" }, { tz: TZ });

    expect(windows).toEqual([
      { from: at(MON, "09:00"), to: at(MON, "12:00") },
      { from: at("2026-08-26", "14:00"), to: at("2026-08-26", "20:00") },
      { from: at("2026-08-29", "10:00"), to: at("2026-08-29", "18:00") },
    ]);
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
