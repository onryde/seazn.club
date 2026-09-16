// M1 k2 — the document carries the fixture page's subheading facts, and its
// start time is the SAME string the court card prints.
//
// The live rain-delay test found the fixture page showing two times at once:
// the court card (live document) moved to the new kick-off, the subheading
// paragraph under the title did not, because the page formatted
// `fixture.scheduled_at` itself, once, on the server. It also formatted it
// differently — `new Date(iso).toLocaleString(locale, { weekday: "long", … })`
// with NO `timeZone`, so it printed the rendering server's zone rather than
// the venue's, in a long style the card does not use.
//
// The fix is one formatter (`startTimeText`) feeding both, carried on the
// document so the line can re-render from a poll. These tests hold that: the
// two strings are IDENTICAL by construction, the venue zone and the locale
// both really reach it, and the field exists independently of whether the
// status line happens to be a time at all.
import { describe, expect, it } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { buildMatchCentre, startTimeText, type MatchCentreInput } from "../match-centre";
import { LOCALES } from "@/lib/i18n-constants";
import type { PublicFixture } from "../data";
import type { PublicPerson } from "../public-lineups";
import type { SideT } from "../match-centre-schema";

const AT = "2026-07-20T13:30:00.000Z"; // 14:30 in Europe/London, 06:30 in Los Angeles

const F = (over: Partial<PublicFixture> = {}): PublicFixture => ({
  id: "fx1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "home",
  away_entrant_id: "away",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: AT,
  venue: "Stale Building",
  court_label: "Stale Court",
  venue_name: "Riverside Sports Hall",
  court_name: "Court 3",
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const SIDES: [SideT, SideT] = [
  { entrantId: "home", name: "Home Blazers", short: "HOM", colour: null, badgeUrl: null },
  { entrantId: "away", name: "Southend Queens", short: "SEQ", colour: null, badgeUrl: null },
];

const lineups: Record<string, PublicPerson[]> = { home: [], away: [] };

function input(over: Partial<MatchCentreInput> = {}): MatchCentreInput {
  return {
    fixture: F(),
    sportKey: "cricket",
    cfg: cricket.configSchema.parse({}),
    events: [],
    lineups,
    sides: SIDES,
    venueTz: "Europe/London",
    locale: "en",
    now: new Date("2026-07-20T10:00:00.000Z"),
    hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
    stage: null,
    moduleVersion: null,
    formatLabel: null,
    ...over,
  };
}

describe("startTime — one formatter for the court card and the page's subheading", () => {
  it("is the EXACT string the court card's 'Starts …' sentence renders", () => {
    const doc = buildMatchCentre(input());
    // The card resolves `matchCentre.status.startsAt` with this param; the
    // subheading renders `startTime` verbatim. Identical, or the page shows
    // one kick-off twice in two wordings.
    expect(doc.header.statusLine?.key).toBe("matchCentre.status.startsAt");
    expect(doc.startTime).toBe(doc.header.statusLine?.params?.time);
    expect(typeof doc.startTime).toBe("string");
  });

  it("is formatted in the VENUE's timezone, not the rendering server's", () => {
    // The page's old `toLocaleString` passed no `timeZone` at all. Two
    // documents that differ only by venue zone must therefore differ here —
    // and one of them must carry the venue-local clock reading.
    const london = buildMatchCentre(input({ venueTz: "Europe/London" }));
    const losAngeles = buildMatchCentre(input({ venueTz: "America/Los_Angeles" }));
    expect(london.startTime).not.toBe(losAngeles.startTime);
    expect(london.startTime).toContain("14:30");
    expect(losAngeles.startTime).toContain("06:30");
  });

  it("writes an `en` org's date en-GB, not the US form bare 'en' gives Intl", () => {
    // The whole public surface is en-GB (`lib/format.ts:10`, `intlLocaleFor`
    // in `lib/public-date-locale.ts`); bare "en" made this one line read "Jul 20, 2026, 2:30 PM"
    // beside neighbours reading "20 Jul 2026, 14:30".
    const doc = buildMatchCentre(input({ locale: "en" }));
    expect(doc.startTime).toBe("20 Jul 2026, 14:30");
    expect(doc.startTime).not.toContain("PM");
  });

  it("is formatted in the document's locale", () => {
    const en = buildMatchCentre(input({ locale: "en" }));
    const fr = buildMatchCentre(input({ locale: "fr" }));
    expect(en.startTime).not.toBe(fr.startTime);
    // Derived from the same Intl the builder uses, so a format change moves
    // this with it rather than leaving a literal here asserting yesterday's.
    expect(fr.startTime).toBe(startTimeText(AT, "fr", "Europe/London"));
  });

  it("is null when the fixture has no scheduled time", () => {
    const doc = buildMatchCentre(input({ fixture: F({ scheduled_at: null }) }));
    expect(doc.startTime).toBeNull();
    // …and the card says nothing rather than "Starts null".
    expect(doc.header.statusLine).toBeNull();
  });

  it("survives a status whose status line is NOT a time — a decided or postponed match still knows when it was due", () => {
    // The subheading shows the kick-off whatever the status; a `startTime`
    // that were merely a copy of the scheduled-branch status line would be
    // null here and the line would fall back to "Time not recorded".
    for (const status of ["decided", "postponed", "in_play"]) {
      const doc = buildMatchCentre(input({ fixture: F({ status }) }));
      expect(doc.startTime, `${status} keeps its start time`).toBe(
        startTimeText(AT, "en", "Europe/London"),
      );
      expect(doc.header.statusLine?.key, `${status} does not say "Starts …"`).not.toBe(
        "matchCentre.status.startsAt",
      );
    }
  });
});

// Owner ruling 2026-09-16: every public date is in the org's locale and English
// is day-month. The Info tab's "Start" row ran its own `Intl.DateTimeFormat`
// with the raw locale, so an English org read "Monday, July 20, 2026 at 2:30
// PM" a tab away from a card that already read "20 Jul 2026, 14:30".
describe("Info tab 'Start' row — the org's locale, English day-month", () => {
  const startRow = (locale: string) => {
    const doc = buildMatchCentre(input({ locale }));
    const row = doc.info.rows.find((r) => r.label.key === "matchCentre.info.start");
    return row?.value.params?.when;
  };

  it("an English org reads day-month in the venue's 24-hour clock", () => {
    expect(startRow("en")).toBe("Monday, 20 July 2026 at 14:30");
  });

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`a ${locale} org reads its own Intl format in the venue's zone`, () => {
      const own = new Intl.DateTimeFormat(locale, {
        timeZone: "Europe/London",
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date(AT));
      expect(startRow(locale)).toBe(own);
    });
  }
});

describe("venueName / courtName — the subheading's other two facts", () => {
  it("carry the DERIVED join-backed names, never the frozen venue/court_label columns", () => {
    const doc = buildMatchCentre(input());
    expect(doc.venueName).toBe("Riverside Sports Hall");
    expect(doc.courtName).toBe("Court 3");
    expect(doc.venueName).not.toBe("Stale Building");
    expect(doc.courtName).not.toBe("Stale Court");
  });

  it("are null — not empty strings — when the fixture has neither", () => {
    const doc = buildMatchCentre(input({ fixture: F({ venue_name: null, court_name: null }) }));
    expect(doc.venueName).toBeNull();
    expect(doc.courtName).toBeNull();
  });
});
