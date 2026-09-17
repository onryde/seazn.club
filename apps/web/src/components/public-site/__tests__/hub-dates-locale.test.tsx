// Owner ruling 2026-09-16: every date a spectator reads on the competition hub
// is in the ORG's locale, and English is day-month. The hub's tabs formatted
// through `lib/format.ts`'s `fmtDate`/`fmtDateTime`, which pin en-GB in all
// four locales — so a Spanish club's hub read "Sunday 6 September" under
// "horarios en BST". Each surface is rendered in all four locales:
//
//   - en is a LITERAL day-month string, so a regression to bare "en" (US
//     month-day) reds;
//   - es/fr/nl are DERIVED from `Intl` with the zone the surface uses, and each
//     is paired with a "not the en-GB string" line, so a regression to the
//     en-GB lock reds too.
//
// Every expected string names its zone: a vitest worker ignores a TZ mutation
// (`process.env.TZ` does not reach ICU inside the pool), so a formatter that
// dropped its `timeZone` could only be caught by the zone in the expectation.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { competitionDateLine, InfoTab } from "../matches-hub/info-tab";
import { OverviewTab } from "../matches-hub/overview-tab";
import { MatchesTab } from "../matches-hub/matches-tab";
import { MatchCard } from "../matches-hub/match-card";
import { division, hubDoc, info, m } from "./hub-fixtures";

const DICTS: Record<Locale, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const NON_EN = LOCALES.filter((l) => l !== "en");
const NOW = Date.parse("2026-09-05T12:00:00.000Z");
/** hub-fixtures' venue zone. */
const TZ = "Europe/London";

const intl = (locale: string, tz: string, iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(iso));

const LONG_DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };

describe("competitionDateLine — calendar days, in UTC, in the page's locale", () => {
  it("an English org reads day-month", () => {
    expect(competitionDateLine({ startsOn: "2026-09-01", endsOn: "2026-09-20" }, "en")).toBe(
      "1 September 2026 – 20 September 2026",
    );
  });

  for (const locale of NON_EN) {
    it(`a ${locale} org reads its own Intl format, not en-GB`, () => {
      const own = `${intl(locale, "UTC", "2026-09-01", LONG_DAY)} – ${intl(locale, "UTC", "2026-09-20", LONG_DAY)}`;
      expect(own).not.toBe("1 September 2026 – 20 September 2026");
      expect(competitionDateLine({ startsOn: "2026-09-01", endsOn: "2026-09-20" }, locale)).toBe(own);
    });
  }
});

describe("InfoTab — the Dates row", () => {
  for (const locale of LOCALES) {
    it(`${locale}: the Dates row is the locale's date line`, () => {
      const doc = hubDoc({
        divisions: [division("premier")],
        info: info({ startsOn: "2026-09-01", endsOn: "2026-09-20" }),
      });
      const h = renderToStaticMarkup(<InfoTab doc={doc} dict={DICTS[locale]} locale={locale} />);
      const at = h.indexOf(`data-testid="mh-info-dates"`);
      expect(at, "the Dates row renders").toBeGreaterThan(-1);
      const row = h.slice(at, h.indexOf("</div>", at));
      expect(row).toContain(
        locale === "en"
          ? "1 September 2026 – 20 September 2026"
          : `${intl(locale, "UTC", "2026-09-01", LONG_DAY)} – ${intl(locale, "UTC", "2026-09-20", LONG_DAY)}`,
      );
    });
  }
});

describe("OverviewTab — the status line's dates", () => {
  const render = (doc: Parameters<typeof OverviewTab>[0]["doc"], locale: Locale) =>
    renderToStaticMarkup(<OverviewTab doc={doc} dict={DICTS[locale]} locale={locale} now={NOW} />);

  const upcoming = hubDoc({ matches: [m("u1", "upcoming", "2026-09-05T13:00:00.000Z", "premier")] });
  const preseason = hubDoc({
    divisions: [division("premier", { tz: "America/Los_Angeles" })],
    info: info({ startsOn: "2026-09-01", endsOn: "2026-09-20" }),
  });

  it("an English org: 'Next: Sat 5 Sept 14:00' and '1 September 2026 – 20 September 2026'", () => {
    expect(render(upcoming, "en")).toContain("Next: Sat 5 Sept 14:00");
    expect(render(preseason, "en")).toContain("1 September 2026 – 20 September 2026");
  });

  for (const locale of NON_EN) {
    it(`a ${locale} org: the next kick-off and the competition dates in its own Intl format`, () => {
      const nextDay = intl(locale, TZ, "2026-09-05T13:00:00.000Z", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
      expect(nextDay).not.toBe("Sat 5 Sept");
      expect(render(upcoming, locale)).toContain(`${nextDay} 14:00`);

      const from = intl(locale, "UTC", "2026-09-01", LONG_DAY);
      expect(from).not.toBe("1 September 2026");
      const h = render(preseason, locale);
      expect(h).toContain(from);
      expect(h).toContain(intl(locale, "UTC", "2026-09-20", LONG_DAY));
      expect(h).not.toContain("1 September 2026");
    });
  }
});

describe("MatchesTab — the venue-day heading", () => {
  const doc = hubDoc({ matches: [m("u1", "upcoming", "2026-09-06T13:00:00Z", "t8")] });
  const heading = (locale: Locale) => {
    const h = renderToStaticMarkup(
      <MatchesTab doc={doc} dict={DICTS[locale]} locale={locale} now={NOW} initialFilter="upcoming" />,
    );
    const at = h.indexOf(`data-testid="mh-day-2026-09-06"`);
    expect(at, "the day group renders").toBeGreaterThan(-1);
    const open = h.indexOf("<h2", at);
    return h.slice(h.indexOf(">", open) + 1, h.indexOf("</h2>", open));
  };

  it("an English org reads 'Sunday 6 September'", () => {
    expect(heading("en")).toBe("Sunday 6 September");
  });

  for (const locale of NON_EN) {
    it(`a ${locale} org reads its own Intl format`, () => {
      const own = intl(locale, TZ, "2026-09-06T13:00:00Z", { weekday: "long", day: "numeric", month: "long" });
      expect(own).not.toBe("Sunday 6 September");
      expect(heading(locale)).toBe(own);
    });
  }
});

describe("MatchCard — the date beyond 24 hours", () => {
  const far = m("u1", "upcoming", "2026-09-12T14:00:00Z", "t8");
  const starts = (locale: Locale) => {
    const h = renderToStaticMarkup(<MatchCard match={far} dict={DICTS[locale]} locale={locale} now={NOW} />);
    const at = h.indexOf(`data-testid="mh-match-starts"`);
    expect(at, "the starts line renders").toBeGreaterThan(-1);
    return h.slice(h.indexOf(">", at) + 1, h.indexOf("<", at));
  };

  it("an English org reads 'Sat 12 Sept'", () => {
    expect(starts("en")).toBe("Sat 12 Sept");
  });

  for (const locale of NON_EN) {
    it(`a ${locale} org reads its own Intl format`, () => {
      const own = intl(locale, TZ, "2026-09-12T14:00:00Z", { weekday: "short", day: "numeric", month: "short" });
      expect(own).not.toBe("Sat 12 Sept");
      expect(starts(locale)).toBe(own);
    });
  }
});
