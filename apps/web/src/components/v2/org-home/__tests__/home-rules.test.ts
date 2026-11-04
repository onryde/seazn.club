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
import { competitionChipState } from "@/components/ui/status-chip";
import { homeGroupOf, sportsLine, stubOf, HOME_GROUPS } from "../home-rules";

const en = uiEn as Record<string, string>;
const fr = uiFr as Record<string, string>;

describe("homeGroupOf — which band a competition sits in", () => {
  // Every competition status the schema allows (competitions.status check: draft, published, live, completed, archived).
  const STATUSES = ["draft", "published", "live", "completed", "archived"] as const;
  /** A competition with no division: the empty case of the divisions' signals (UI5 fix round 1, m5). */
  const band = (c: { status: string; played: number; fixturesToday: number }) => homeGroupOf({ ...c, divisions: 0, divisionsCompleted: 0 });

  it("the empty case first: no match today, nothing played, a draft — a quiet card that has not started", () => {
    expect(band({ status: "draft", played: 0, fixturesToday: 0 })).toBe("notStarted");
  });

  it("a match today puts every unfinished competition in the deck — a Draft one included (owner, 2026-11-01)", () => {
    let checked = 0;
    for (const status of STATUSES) {
      const finished = status === "completed" || status === "archived";
      for (const played of [0, 3]) {
        expect(band({ status, played, fixturesToday: 1 }), `${status} played=${played}`).toBe(
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
      expect(band({ status, played: 0, fixturesToday: 0 }), status).toBe(want[status][0]);
      expect(band({ status, played: 3, fixturesToday: 0 }), status).toBe(want[status][1]);
      checked += 2;
    }
    expect(checked).toBe(10);
  });

  it("refuses a count that is not a whole number — the competition page's own guard, not a silent 'not today'", () => {
    expect(() => band({ status: "live", played: 0, fixturesToday: -1 })).toThrow(RangeError);
    expect(() => band({ status: "live", played: 0, fixturesToday: 0.5 })).toThrow(RangeError);
  });

  // UI5 fix round 1 (review m5): starting a division makes the competition `live` and nothing completes it, so a competition
  // whose every division had finished read Completed on its chip (item 6: read off the divisions) and sat in "Under way".
  it("UI5 fix round 1 (m5): every division completed is Finished, whatever the competition's status; one still going is not", () => {
    expect(homeGroupOf({ status: "live", played: 3, fixturesToday: 0, divisions: 2, divisionsCompleted: 2 })).toBe("finished");
    expect(homeGroupOf({ status: "live", played: 3, fixturesToday: 0, divisions: 2, divisionsCompleted: 1 })).toBe("underWay");
    // The empty case: no division is no division finished (the chip's own `divisions > 0` guard).
    expect(homeGroupOf({ status: "live", played: 0, fixturesToday: 0, divisions: 0, divisionsCompleted: 0 })).toBe("underWay");
  });

  it("UI5 fix round 1 (m5): the band agrees with the card's chip — Finished exactly when the chip says Completed or Archived (counted)", () => {
    let checked = 0;
    let finished = 0;
    for (const status of STATUSES) {
      for (const divisions of [0, 1, 2]) {
        for (let divisionsCompleted = 0; divisionsCompleted <= divisions; divisionsCompleted++) {
          for (const played of [0, 3]) {
            // No match in play and no window open: the two rungs that outrank Completed on the chip say nothing of finishing.
            const chip = competitionChipState(status, { inPlay: 0, registrationOpen: false, divisions, divisionsActive: 0, divisionsCompleted, played });
            const group = homeGroupOf({ status, played, fixturesToday: 0, divisions, divisionsCompleted });
            const over = chip === "completed" || chip === "archived";
            expect(group === "finished", `${status} ${divisionsCompleted}/${divisions} played=${played}: chip ${chip}, band ${group}`).toBe(over);
            if (over) finished++;
            checked++;
          }
        }
      }
    }
    console.info(`m5: ${checked} (status, divisions, played) cases, ${finished} finished`);
    expect(checked, "anti-vacuity").toBe(STATUSES.length * 6 * 2);
    expect(finished, "both sides of the rule were reached").toBeGreaterThan(0);
    expect(finished).toBeLessThan(checked);
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
