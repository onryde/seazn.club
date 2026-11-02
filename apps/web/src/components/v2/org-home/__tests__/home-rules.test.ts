// Match Day C7: the org Competitions home's three pure rules — which band a competition sits in, the sports line its divisions
// earn it, and the stub a quiet card shows when nothing is scheduled.
//
// The rules under test, from the owner's rulings (2026-11-01, progress.md), not from the code:
//  - a competition with a match TODAY stands out in the today deck, a DRAFT one included; "today" is the competition page's own
//    match-day question (`needsYouHome` of the same count), so the deck and the competition page cannot disagree;
//  - a finished competition (completed or archived) is hidden by default behind "Show finished" — whatever else is true of it;
//  - everything else is a quiet card: under way once it is live or has played a match, not started before that;
//  - sports come from the divisions: one is named, two are named, three or more read "N sports" with the full list kept for
//    title/aria;
//  - a quiet card with no upcoming match shows B's stub: "No fixtures yet" before any fixture exists, else "No match scheduled".
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import uiEn from "@/dictionaries/en/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import { msgFor } from "@/lib/messages-i18n";
import { sportLabel } from "@/lib/scoring-vocab";
import { homeGroupOf, sportsLine, stubOf, HOME_GROUPS } from "../home-rules";

const en = uiEn as Record<string, string>;
const fr = uiFr as Record<string, string>;

describe("homeGroupOf — which band a competition sits in", () => {
  // Every competition status the schema allows (competitions.status check: draft, published, live, completed, archived).
  const STATUSES = ["draft", "published", "live", "completed", "archived"] as const;

  it("the empty case first: no match today, nothing played, a draft — a quiet card that has not started", () => {
    expect(homeGroupOf({ status: "draft", played: 0, fixturesToday: 0 })).toBe("notStarted");
  });

  it("a match today puts every unfinished competition in the deck — a Draft one included (owner, 2026-11-01)", () => {
    let checked = 0;
    for (const status of STATUSES) {
      const finished = status === "completed" || status === "archived";
      for (const played of [0, 3]) {
        expect(homeGroupOf({ status, played, fixturesToday: 1 }), `${status} played=${played}`).toBe(
          finished ? "finished" : "today",
        );
        checked++;
      }
    }
    expect(checked).toBe(STATUSES.length * 2);
  });

  it("no match today: finished is hidden-by-default; live or played is under way; the rest has not started", () => {
    const want: Record<(typeof STATUSES)[number], [string, string]> = {
      // [played = 0, played = 3]
      draft: ["notStarted", "underWay"],
      published: ["notStarted", "underWay"],
      live: ["underWay", "underWay"],
      completed: ["finished", "finished"],
      archived: ["finished", "finished"],
    };
    let checked = 0;
    for (const status of STATUSES) {
      expect(homeGroupOf({ status, played: 0, fixturesToday: 0 }), status).toBe(want[status][0]);
      expect(homeGroupOf({ status, played: 3, fixturesToday: 0 }), status).toBe(want[status][1]);
      checked += 2;
    }
    expect(checked).toBe(10);
  });

  it("refuses a count that is not a whole number — the competition page's own guard, not a silent 'not today'", () => {
    expect(() => homeGroupOf({ status: "live", played: 0, fixturesToday: -1 })).toThrow(RangeError);
    expect(() => homeGroupOf({ status: "live", played: 0, fixturesToday: 0.5 })).toThrow(RangeError);
  });

  it("names the bands in page order: the deck, then under way, not started, finished", () => {
    expect(HOME_GROUPS).toEqual(["today", "underWay", "notStarted", "finished"]);
  });
});

describe("sportsLine — sports come from the divisions", () => {
  const name = (locale: "en" | "fr") => (k: string) => sportLabel(k, (key) => msgFor(locale, key));
  const count = (dict: Record<string, string>) => (n: number) =>
    (n === 1 ? dict["org.home.sports.one"]! : dict["org.home.sports.other"]!).replace("{count}", String(n));
  const line = (keys: string[], locale: "en" | "fr" = "en") =>
    sportsLine(keys, locale, { name: name(locale), count: count(locale === "en" ? en : fr) });

  it("the empty case first: a competition with no division has no sports line", () => {
    expect(line([])).toBeNull();
  });

  it("one sport is named, from the dictionary, for EVERY sport in the registry", () => {
    const keys = [...new Set(builtinModules.map((m) => m.key))];
    let checked = 0;
    for (const k of keys) {
      const want = en[`sport.${k}`];
      expect(want, `sport.${k} is in the en dictionary`).toBeTruthy();
      expect(line([k]), k).toEqual({ text: want, full: want });
      checked++;
    }
    expect(checked).toBe(keys.length);
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("two sports are both named, joined the way each language joins two words", () => {
    expect(line(["badminton", "tennis"])).toEqual({ text: "Badminton and Tennis", full: "Badminton and Tennis" });
    expect(line(["badminton", "tennis"], "fr")).toEqual({
      text: `${fr["sport.badminton"]} et ${fr["sport.tennis"]}`,
      full: `${fr["sport.badminton"]} et ${fr["sport.tennis"]}`,
    });
  });

  it("three or more read 'N sports', with the full list kept for title and aria", () => {
    expect(line(["badminton", "cricket", "tennis"])).toEqual({
      text: "3 sports",
      full: "Badminton, Cricket and Tennis",
    });
    expect(line(["badminton", "cricket", "tennis", "football"])).toEqual({
      text: "4 sports",
      full: "Badminton, Cricket, Tennis and Football",
    });
    expect(line(["badminton", "cricket", "tennis"], "fr")?.text).toBe("3 sports");
  });

  it("a repeated key is one sport — two badminton divisions read 'Badminton', not 'Badminton and Badminton'", () => {
    expect(line(["badminton", "badminton"])).toEqual({ text: "Badminton", full: "Badminton" });
  });
});

describe("stubOf — B's stub on a quiet card", () => {
  const next = { home: "A", away: "B", court_label: null, scheduled_at: null, in_play: false };

  it("the empty case first: no fixtures at all reads 'No fixtures yet'", () => {
    expect(stubOf({ total: 0, next: null })).toBe("no_fixtures");
  });

  it("fixtures but none upcoming reads 'No match scheduled' — after every one is played, too", () => {
    expect(stubOf({ total: 6, next: null })).toBe("no_match");
  });

  it("an upcoming match means no stub", () => {
    expect(stubOf({ total: 6, next })).toBeNull();
  });
});
