// Spectator W2, Task 15 (owner ruling 2026-09-16): public dates are written
// day-month in English. Bare "en" is a US format to `Intl` ("Sep 1, 2026"), so
// the one helper maps it to en-GB ("1 Sept 2026"); every other org locale keeps
// its own Intl format. The org home, the public schedule (`schedule.tsx`) and
// the match centre's start time (`match-centre.ts`) all format through it.
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import { formatPublicInstant, intlLocaleFor } from "@/lib/public-date-locale";

const AT = new Date(Date.UTC(2026, 8, 1, 12));
const fmt = (tag: string) =>
  AT.toLocaleDateString(tag, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

describe("intlLocaleFor", () => {
  it("en is written en-GB — and that is not what bare en gives Intl", () => {
    // Premise: the two English renderings really differ for this date.
    expect(fmt("en-GB")).not.toBe(fmt("en-US"));
    expect(fmt("en")).toBe(fmt("en-US"));
    expect(intlLocaleFor("en")).toBe("en-GB");
    expect(fmt(intlLocaleFor("en"))).toBe(fmt("en-GB"));
  });

  it("every other org locale is used as given", () => {
    const others = LOCALES.filter((l) => l !== "en");
    expect(others.length, "premise: the repo has non-English locales").toBeGreaterThan(0);
    for (const locale of others) expect(intlLocaleFor(locale), locale).toBe(locale);
  });
});

describe("formatPublicInstant", () => {
  const ISO = "2030-07-01T10:00:00.000Z";
  const HM = { hour: "2-digit", minute: "2-digit" } as const;

  it("formats in the VENUE zone, never the runtime's", () => {
    expect(formatPublicInstant("en", "Asia/Kolkata", ISO, HM)).toBe("15:30");
    expect(formatPublicInstant("en", "UTC", ISO, HM)).toBe("10:00");
  });

  it("an unknown zone falls back to UTC instead of throwing into a render", () => {
    expect(formatPublicInstant("en", "Not/AZone", ISO, HM)).toBe("10:00");
  });

  it("null and unparseable instants format to null", () => {
    expect(formatPublicInstant("en", "UTC", null, { day: "numeric" })).toBeNull();
    expect(formatPublicInstant("en", "UTC", "not a date", { day: "numeric" })).toBeNull();
  });

  it("English is day-month through intlLocaleFor, not bare en's US order", () => {
    const opts = { day: "numeric", month: "short" } as const;
    const gb = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(Date.parse(ISO));
    const us = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(Date.parse(ISO));
    expect(gb, "premise: the two orders differ").not.toBe(us);
    expect(formatPublicInstant("en", "UTC", ISO, opts)).toBe(gb);
  });
});
