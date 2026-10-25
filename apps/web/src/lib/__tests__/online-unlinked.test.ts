// The online-switch warning's pure half (owner ruling 2026-10-25: warn, never block): the summary the division page hands to
// Settings, and the sentence Settings prints, in each of the four locales. Expected sentences are built from each locale's own
// dictionary template and Intl (plural rules, list format) - never from the helper under test.
import { describe, expect, it } from "vitest";
import { summariseUnlinkedLichess, unlinkedLichessWarning } from "@/lib/online-unlinked";
import { plural } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const player = (n: number) => ({ full_name: `Player ${n}` });
const players = (n: number) => Array.from({ length: n }, (_, i) => player(i + 1));

describe("summariseUnlinkedLichess", () => {
  it("empty case first: nobody -> a zero count and no names", () => {
    expect(summariseUnlinkedLichess([])).toEqual({ count: 0, names: [] });
  });

  it("a short list is named in full, in the order given", () => {
    expect(summariseUnlinkedLichess(players(3))).toEqual({ count: 3, names: ["Player 1", "Player 2", "Player 3"] });
  });

  it("a long list keeps the TRUE count and names only the first five (5 -> all, 6 -> five, 40 -> five)", () => {
    // The cap is five: the warning prints five names and folds the rest.
    const cases: { total: number; shown: number }[] = [
      { total: 5, shown: 5 },
      { total: 6, shown: 5 },
      { total: 40, shown: 5 },
    ];
    let checked = 0;
    for (const { total, shown } of cases) {
      const s = summariseUnlinkedLichess(players(total));
      expect(s.count, `${total} players`).toBe(total);
      expect(s.names, `${total} players`).toEqual(players(shown).map((p) => p.full_name));
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("unlinkedLichessWarning - the sentence, per locale", () => {
  const DICTS = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as unknown as Record<Locale, Dict>;
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const render = (locale: Locale, count: number, names: string[]) =>
    unlinkedLichessWarning({ count, names }, locale, (key, n, vars) => plural(DICTS[locale], key, n, locale, vars));
  const template = (locale: Locale, key: string, n: number) =>
    String((DICTS[locale] as Record<string, unknown>)[`${key}.${new Intl.PluralRules(locale).select(n)}`]);
  const list = (locale: Locale, items: string[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  const fill = (t: string, vars: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

  it("every locale prints its own plural form and its own list join, for one, two, and a truncated many", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      // one player: the .one form of this locale (Intl decides it).
      expect(render(locale, 1, ["Ana"]), `${locale} x1`).toBe(
        fill(template(locale, "divset.onlinePlay.unlinked", 1), { count: 1, names: "Ana" }),
      );
      // two players: "A and B" in the locale's own conjunction.
      expect(render(locale, 2, ["Ana", "Ben"]), `${locale} x2`).toBe(
        fill(template(locale, "divset.onlinePlay.unlinked", 2), { count: 2, names: list(locale, ["Ana", "Ben"]) }),
      );
      // eight, five named: the three unnamed fold into the locale's "N more", as the list's last item.
      const five = ["Ana", "Ben", "Cy", "Dee", "Eli"];
      const more = fill(template(locale, "divset.onlinePlay.unlinkedMore", 3), { count: 3 });
      const got = render(locale, 8, five);
      expect(got, `${locale} x8`).toBe(
        fill(template(locale, "divset.onlinePlay.unlinked", 8), { count: 8, names: list(locale, [...five, more]) }),
      );
      expect(got, `${locale} x8 carries the unnamed count`).toContain(more);
      expect(got, `${locale} leaves no placeholder`).not.toMatch(/[{}]/);
      checked += 3;
    }
    expect(checked, "anti-vacuity: 4 locales x 3 sentences").toBe(12);
  });

  it("the singular and plural forms really differ in English (a witness: the wrong form has a different constant)", () => {
    expect(render("en", 1, ["Ana"])).toContain("1 player has");
    expect(render("en", 2, ["Ana", "Ben"])).toContain("2 players have");
  });

  it("a summary that names everyone folds nothing; one that names nobody (count only) still prints the count", () => {
    expect(render("en", 2, ["Ana", "Ben"])).not.toContain("more");
    // Defensive: a summary with a count but no names (never built by summariseUnlinkedLichess) is still a sentence.
    expect(render("en", 3, [])).toContain("3 players have");
  });
});
