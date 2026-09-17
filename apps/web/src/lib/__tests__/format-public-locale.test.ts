// Owner ruling 2026-09-16: a PUBLIC page writes its dates in the org's locale,
// English day-month. `fmtDate`/`fmtTime`/`fmtDateTime` pin `LOCALE = "en-GB"`
// and take no locale, and organiser surfaces (the registration hub, the
// officials panel, `client-time.tsx`) depend on exactly that output — so the
// public pages get their own variants rather than a change to the shared ones.
//
// Every expectation names its zone: a vitest worker ignores a TZ mutation, so a
// formatter that dropped `timeZone` would pass here on a UTC runner if the
// fixture instant did not move days between the zones it uses.
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import {
  fmtDate,
  fmtDateTime,
  fmtPublicDate,
  fmtPublicDateTime,
  fmtPublicTime,
  fmtPublicZoneAbbrev,
  fmtTime,
  fmtZoneAbbrev,
} from "@/lib/format";

/** 13:00Z on Sat 5 September 2026 — 14:00 in London (BST). */
const AT = "2026-09-05T13:00:00.000Z";
const TZ = "Europe/London";
/** 23:30Z on the 5th is already Sunday the 6th in Auckland (NZST, +12). */
const LATE = "2026-09-05T23:30:00.000Z";
const NON_EN = LOCALES.filter((l) => l !== "en");

const intl = (locale: string, tz: string, iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(iso));

describe("fmtPublicDate / fmtPublicDateTime — the page's locale, English day-month", () => {
  it("en reads day-month, never the US month-day bare 'en' gives Intl", () => {
    expect(fmtPublicDate("en", TZ, AT)).toBe("Sat 5 Sept");
    expect(fmtPublicDateTime("en", TZ, AT)).toBe("5 Sept 2026, 14:00");
    expect(fmtPublicDate("en", "UTC", AT, { day: "numeric", month: "long", year: "numeric" })).toBe(
      "5 September 2026",
    );
  });

  it("es, fr and nl are written in their own Intl format — and that differs from en-GB", () => {
    expect(NON_EN.length, "premise: the repo has non-English locales").toBeGreaterThan(0);
    for (const locale of NON_EN) {
      const date = fmtPublicDate(locale, TZ, AT);
      expect(date, locale).toBe(intl(locale, TZ, AT, { weekday: "short", day: "numeric", month: "short" }));
      // The differential: the organiser helper's en-GB string is a DIFFERENT
      // string, so a variant that ignored its locale cannot pass this line.
      expect(date, locale).not.toBe(fmtDate(TZ, AT));

      const dateTime = fmtPublicDateTime(locale, TZ, AT);
      expect(dateTime, locale).toBe(intl(locale, TZ, AT, { dateStyle: "medium", timeStyle: "short" }));
      expect(dateTime, locale).not.toBe(fmtDateTime(TZ, AT));
    }
  });

  it("the zone is the one passed in, never the runner's", () => {
    expect(fmtPublicDate("en", "Pacific/Auckland", LATE)).toBe("Sun 6 Sept");
    expect(fmtPublicDate("en", "UTC", LATE)).toBe("Sat 5 Sept");
    for (const locale of NON_EN)
      expect(fmtPublicDate(locale, "Pacific/Auckland", LATE), locale).not.toBe(fmtPublicDate(locale, "UTC", LATE));
  });

  it("the options passed in replace the default shape", () => {
    expect(fmtPublicDateTime("en", TZ, AT, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })).toBe(
      "5 Sept, 14:00",
    );
  });

  it("an unknown zone falls back to UTC instead of throwing into a render", () => {
    expect(fmtPublicDate("es", "Mars/Phobos", LATE)).toBe(fmtPublicDate("es", "UTC", LATE));
  });

  it("null or unparsable input is an empty string", () => {
    expect(fmtPublicDate("fr", TZ, null)).toBe("");
    expect(fmtPublicDateTime("fr", TZ, "not-a-date")).toBe("");
    expect(fmtPublicTime("fr", TZ, undefined)).toBe("");
  });
});

describe("fmtPublicTime — the clock", () => {
  it("writes the 24-hour venue clock", () => {
    expect(fmtPublicTime("en", TZ, AT)).toBe("14:00");
    expect(fmtPublicTime("en", "Asia/Kolkata", AT)).toBe("18:30");
  });

  // The premise the date table leans on for every call site still on
  // `fmtTime`: the two-digit h23 clock is the same string in every locale this
  // repo ships, so a time-only `fmtTime` is not an English lock in effect. A
  // new locale whose clock differs reds here, and those sites then owe a move.
  it("reads identically in every shipped locale, which is why time-only fmtTime sites need no move", () => {
    for (const locale of LOCALES) expect(fmtPublicTime(locale, TZ, AT), locale).toBe(fmtTime(TZ, AT));
  });
});

describe("fmtPublicZoneAbbrev — the zone label beside a public time", () => {
  // Task 16's sweep: the matches caption read "horarios en BST" on a Spanish
  // page and "horaires en GMT-7" on a French one — `fmtZoneAbbrev` is en-GB,
  // and "BST" is British Summer Time, an English name. Intl writes the zone in
  // the page's locale too ("GMT+1", "UTC+1").
  it("en keeps the en-GB label, including the named DST-free zones", () => {
    expect(fmtPublicZoneAbbrev("en", TZ, AT)).toBe("BST");
    expect(fmtPublicZoneAbbrev("en", "Asia/Kolkata", AT)).toBe("IST");
    expect(fmtPublicZoneAbbrev("en", TZ, "2026-01-15T12:00:00Z")).toBe("GMT");
  });

  it("es, fr and nl write the zone as Intl does in that locale — never the English 'BST'", () => {
    for (const locale of NON_EN) {
      const own = new Intl.DateTimeFormat(locale, { timeZone: TZ, timeZoneName: "short" })
        .formatToParts(new Date(AT))
        .find((p) => p.type === "timeZoneName")?.value;
      expect(fmtPublicZoneAbbrev(locale, TZ, AT), locale).toBe(own);
      // The differential: the organiser label is a different string.
      expect(fmtPublicZoneAbbrev(locale, TZ, AT), locale).not.toBe(fmtZoneAbbrev(TZ, AT));
      // "IST" is an English abbreviation `fmtZoneAbbrev` substitutes; it is
      // not what a Spanish, French or Dutch page is handed.
      expect(fmtPublicZoneAbbrev(locale, "Asia/Kolkata", AT), locale).not.toBe("IST");
    }
  });

  it("an unknown zone falls back to UTC instead of throwing into a render", () => {
    expect(fmtPublicZoneAbbrev("fr", "Mars/Phobos", AT)).toBe(fmtPublicZoneAbbrev("fr", "UTC", AT));
  });
});

describe("the organiser helpers are unchanged", () => {
  it("fmtDate / fmtDateTime still write en-GB", () => {
    expect(fmtDate(TZ, AT)).toBe("Sat 5 Sept");
    expect(fmtDateTime(TZ, AT)).toBe("5 Sept 2026, 14:00");
  });
});
