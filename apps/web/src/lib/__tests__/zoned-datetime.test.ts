// Local date/time INPUT values ⇄ absolute instants, resolved in an EXPLICIT
// zone. The one module the scheduling panels are allowed to convert through.
//
// THE ZONES IN THIS FILE MUST DISAGREE OR THE SUITE IS VACUOUS. A
// `datetime-local` input carries no offset, so `new Date(value)` — the thing
// this module replaces — resolves it through whatever zone the PROCESS is in.
// Every hardcoded vector below pairs `Pacific/Auckland` with
// `America/Los_Angeles`: 19 hours apart in August and on opposite sides of the
// date line, so a browser-zone implementation lands on a different DAY, not
// merely a different hour. Both are passed EXPLICITLY, so those vectors hold on
// any machine.
//
// The handful of assertions that must show what the BROWSER lane does cannot be
// hardcoded, because the process zone is not ours to set:
// **`process.env.TZ = …` inside a vitest worker thread does not move `Date`.**
// It reads back as assigned, and `Intl.DateTimeFormat().resolvedOptions()
// .timeZone` stays on the machine's zone — so a suite that sets it and then
// hardcodes an expectation is silently asserting the machine's own offset. Those
// assertions derive from `PROCESS_TZ` instead, and `guards` at the bottom fails
// loudly if the machine ever agrees with the venue zone.
import { describe, expect, it } from "vitest";
import {
  addYmdDays,
  isoFromZonedDateTime,
  isoFromZonedParts,
  ymdSpanDays,
  zonedDateInput,
  zonedDateTimeInput,
  zonedTimeInput,
} from "@/lib/zoned-datetime";
import { toLocalInput } from "@/lib/schedule-board";

/** The VENUE zone in every case below (#448: the governing clock). */
const AKL = "Pacific/Auckland";
/** The zone the organiser's BROWSER is in — deliberately not the venue's. */
const LA = "America/Los_Angeles";
/** Whatever zone this process actually runs in: the lane `new Date(value)` and
 *  `toLocalInput` take, and the one a test cannot choose. */
const PROCESS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 12:00 in Auckland on 1 Aug 2026 (NZST, UTC+12). In LA that same instant is
 *  17:00 on 31 JULY — a different calendar day. */
const AUG_INSTANT = "2026-08-01T00:00:00.000Z";
const AUG_IN_AKL = "2026-08-01T12:00";
const AUG_IN_LA = "2026-07-31T17:00";

describe("reading an instant back into an input value", () => {
  it("renders a datetime-local value on the VENUE clock, not the process one", () => {
    expect(zonedDateTimeInput(AUG_INSTANT, AKL)).toBe(AUG_IN_AKL);
    // The same instant read in a DIFFERENT explicit zone: different day AND
    // different hour, so the assertion above cannot pass by coincidence.
    expect(zonedDateTimeInput(AUG_INSTANT, LA)).toBe(AUG_IN_LA);
    // `toLocalInput` is the browser lane the panels used to take. It is exactly
    // this module read in the process's own zone — pinned rather than
    // hardcoded, because the process zone is not ours to set.
    expect(toLocalInput(AUG_INSTANT)).toBe(zonedDateTimeInput(AUG_INSTANT, PROCESS_TZ));
    expect(toLocalInput(AUG_INSTANT)).not.toBe(AUG_IN_AKL);
  });

  it("renders the date-only and time-only halves in the same zone", () => {
    expect(zonedDateInput(AUG_INSTANT, AKL)).toBe("2026-08-01");
    expect(zonedTimeInput(AUG_INSTANT, AKL)).toBe("12:00");
    expect(zonedDateInput(AUG_INSTANT, LA)).toBe("2026-07-31");
    expect(zonedTimeInput(AUG_INSTANT, LA)).toBe("17:00");
  });

  it("accepts a Date as readily as an ISO string", () => {
    expect(zonedDateTimeInput(new Date(AUG_INSTANT), AKL)).toBe(AUG_IN_AKL);
  });

  it("yields an empty value for an unparseable instant rather than NaN markup", () => {
    // A stored value the wire schema should have rejected must not become an
    // input showing "NaN-aN-aNTaN:aN" that the organiser cannot clear.
    for (const bad of ["", "not-a-date", "2026-13-45T99:99Z"]) {
      expect(zonedDateTimeInput(bad, AKL), bad).toBe("");
      expect(zonedDateInput(bad, AKL), bad).toBe("");
      expect(zonedTimeInput(bad, AKL), bad).toBe("");
    }
  });
});

describe("resolving an input value into an instant", () => {
  it("reads a typed wall clock as the VENUE's, not the process zone's", () => {
    expect(isoFromZonedDateTime(AUG_IN_AKL, AKL)).toBe(AUG_INSTANT);
    // Identical keystrokes, read in a Los Angeles browser, name an instant 19
    // hours later. That gap IS the bug this module exists to close.
    expect(isoFromZonedDateTime(AUG_IN_AKL, LA)).toBe("2026-08-01T19:00:00.000Z");
    // And `new Date(value)` — the call the panels used to make — is this module
    // read in the process's own zone, never the venue's.
    expect(new Date(AUG_IN_AKL).toISOString()).toBe(
      isoFromZonedDateTime(AUG_IN_AKL, PROCESS_TZ),
    );
    expect(new Date(AUG_IN_AKL).toISOString()).not.toBe(AUG_INSTANT);
  });

  it("resolves an explicit date + time pair the same way", () => {
    // The end-date field stores the last minute of the chosen DAY, which is a
    // day boundary on the venue clock and nowhere else.
    expect(isoFromZonedParts("2026-08-01", "23:59", AKL)).toBe("2026-08-01T11:59:00.000Z");
    expect(isoFromZonedParts("2026-08-01", "23:59", LA)).toBe("2026-08-02T06:59:00.000Z");
  });

  it("tolerates seconds on the input value, which some browsers append", () => {
    expect(isoFromZonedDateTime("2026-08-01T12:00:30", AKL)).toBe(AUG_INSTANT);
  });

  it("returns null for a value that is not a complete local date and time", () => {
    for (const bad of ["", "2026-08-01", "12:00", "not-a-date", "2026-08-01 12:00"]) {
      expect(isoFromZonedDateTime(bad, AKL), bad).toBeNull();
    }
    expect(isoFromZonedParts("2026-08-01", "9am", AKL)).toBeNull();
    expect(isoFromZonedParts("01/08/2026", "09:00", AKL)).toBeNull();
  });
});

describe("round trip — type it, store it, read it back", () => {
  // The property the whole change is for: whatever the organiser typed comes
  // back as the SAME wall clock in the venue zone, whichever zone they are in.
  const TYPED = [
    "2026-08-01T12:00",
    "2026-01-15T00:00",
    "2026-12-31T23:59",
    // Straddling both of Auckland's 2026 DST transitions.
    "2026-04-04T09:00",
    "2026-04-06T09:00",
    "2026-09-26T09:00",
    "2026-09-28T09:00",
  ];

  for (const tz of [AKL, LA, "UTC", "Europe/London", "Asia/Kolkata"]) {
    it(`survives input → instant → input in ${tz}`, () => {
      for (const typed of TYPED) {
        const iso = isoFromZonedDateTime(typed, tz);
        expect(iso, typed).not.toBeNull();
        expect(zonedDateTimeInput(iso!, tz), `${tz} / ${typed}`).toBe(typed);
      }
    });
  }

  it("survives instant → input → instant", () => {
    for (const iso of [AUG_INSTANT, "2026-04-04T14:30:00.000Z", "2026-09-26T14:30:00.000Z"]) {
      expect(isoFromZonedDateTime(zonedDateTimeInput(iso, AKL), AKL)).toBe(iso);
    }
  });
});

describe("DST on the venue clock", () => {
  // Auckland shifts twice in 2026: DST ENDS 5 April (a 25-hour day) and STARTS
  // 27 September (a 23-hour day). A conversion built on "add 86_400_000 ms" is
  // correct on every other day of the year and wrong on exactly these two, so
  // nothing but an explicit pair of assertions can see it.
  const hoursBetween = (a: string, b: string) =>
    (Date.parse(isoFromZonedParts(b, "09:00", AKL)!) -
      Date.parse(isoFromZonedParts(a, "09:00", AKL)!)) /
    3_600_000;

  it("keeps 09:00 at 09:00 across the spring-forward day", () => {
    expect(hoursBetween("2026-09-26", "2026-09-27")).toBe(23);
    expect(isoFromZonedParts("2026-09-26", "09:00", AKL)).toBe("2026-09-25T21:00:00.000Z");
    expect(isoFromZonedParts("2026-09-27", "09:00", AKL)).toBe("2026-09-26T20:00:00.000Z");
    for (const ymd of ["2026-09-26", "2026-09-27", "2026-09-28"]) {
      expect(zonedTimeInput(isoFromZonedParts(ymd, "09:00", AKL)!, AKL), ymd).toBe("09:00");
      expect(zonedDateInput(isoFromZonedParts(ymd, "09:00", AKL)!, AKL), ymd).toBe(ymd);
    }
  });

  it("keeps 09:00 at 09:00 across the fall-back day", () => {
    expect(hoursBetween("2026-04-04", "2026-04-05")).toBe(25);
    for (const ymd of ["2026-04-04", "2026-04-05", "2026-04-06"]) {
      expect(zonedTimeInput(isoFromZonedParts(ymd, "09:00", AKL)!, AKL), ymd).toBe("09:00");
      expect(zonedDateInput(isoFromZonedParts(ymd, "09:00", AKL)!, AKL), ymd).toBe(ymd);
    }
  });
});

describe("calendar arithmetic on bare dates", () => {
  it("adds days without a zone, because a YMD has none", () => {
    expect(addYmdDays("2026-09-26", 1)).toBe("2026-09-27");
    // The 23-hour day is still ONE day on the calendar — this is deliberately
    // zone-free, and the zone only re-enters at `isoFromZonedParts`.
    expect(addYmdDays("2026-09-27", 1)).toBe("2026-09-28");
    expect(addYmdDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addYmdDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts an inclusive span, and never fewer than one day", () => {
    expect(ymdSpanDays("2026-09-15", "2026-09-17")).toBe(3);
    expect(ymdSpanDays("2026-09-15", "2026-09-15")).toBe(1);
    expect(ymdSpanDays("2026-09-17", "2026-09-15")).toBe(1);
    // Spans the spring-forward day, whose 23 hours would round a naive
    // millisecond division down to 2.
    expect(ymdSpanDays("2026-09-26", "2026-09-28")).toBe(3);
  });
});

describe("a missing zone is refused, never resolved against the host", () => {
  // The whole module is pointless if forgetting the argument silently restores
  // the browser lane — and `Intl.DateTimeFormat(…, { timeZone: undefined })`
  // does exactly that, resolving to the host zone without complaint. `tsc`
  // rejects the omission; this is what happens if anything gets past it.
  const missing = [undefined, null, "", "   "] as unknown as string[];

  it("throws rather than falling back on every entry point", () => {
    for (const tz of missing) {
      expect(() => zonedDateTimeInput(AUG_INSTANT, tz), String(tz)).toThrow(/timezone is required/);
      expect(() => zonedDateInput(AUG_INSTANT, tz), String(tz)).toThrow(/timezone is required/);
      expect(() => zonedTimeInput(AUG_INSTANT, tz), String(tz)).toThrow(/timezone is required/);
      expect(() => isoFromZonedParts("2026-08-01", "12:00", tz), String(tz)).toThrow(
        /timezone is required/,
      );
      expect(() => isoFromZonedDateTime(AUG_IN_AKL, tz), String(tz)).toThrow(
        /timezone is required/,
      );
    }
  });

  it("throws even when the VALUE is the thing that would have short-circuited", () => {
    // An unparseable instant returns "" and a malformed input returns null, both
    // before any zone math runs. Neither may swallow a missing zone.
    expect(() => zonedDateTimeInput("not-a-date", undefined as unknown as string)).toThrow(
      /timezone is required/,
    );
    expect(() => isoFromZonedDateTime("", undefined as unknown as string)).toThrow(
      /timezone is required/,
    );
  });
});

describe("guards — the premise these assertions rest on", () => {
  it("runs in a process zone that disagrees with the venue zone", () => {
    // If this ever fails, the browser-lane comparisons above became vacuous:
    // the machine agrees with the venue and a browser-zone implementation would
    // pass every one of them. Fix the machine, not the assertion.
    expect(PROCESS_TZ).not.toBe(AKL);
    expect(zonedDateTimeInput(AUG_INSTANT, PROCESS_TZ)).not.toBe(AUG_IN_AKL);
    expect(new Date(AUG_INSTANT).getHours()).not.toBe(12);
  });

  it("pairs two non-UTC zones that disagree on the calendar DAY, not just the hour", () => {
    expect(zonedDateInput(AUG_INSTANT, AKL)).not.toBe(zonedDateInput(AUG_INSTANT, LA));
    for (const tz of [AKL, LA]) {
      expect(zonedDateTimeInput(AUG_INSTANT, tz), tz).not.toBe(
        zonedDateTimeInput(AUG_INSTANT, "UTC"),
      );
    }
  });
});
