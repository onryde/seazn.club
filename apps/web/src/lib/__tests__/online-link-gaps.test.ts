// The online-switch warning's pure half (owner ruling 2026-10-25: warn, never block; fix round 1: two sentences, one for
// players with no Lichess link and one for players who must reconnect): the summary the division page hands to Settings,
// and the sentences Settings prints, in each of the four locales. Expected sentences are built from each locale's own
// dictionary template and Intl (plural rules, list format) - never from the helper under test.
import { describe, expect, it } from "vitest";
import { hasLinkGaps, linkGapSentence, summariseLinkGaps, type LinkGapKind } from "@/lib/online-link-gaps";
import { plural } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const row = (n: number) => ({ name: `Player ${n}` });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));

describe("summariseLinkGaps", () => {
  it("empty case first: nobody in either list -> zero counts, no names, and nothing to say", () => {
    const s = summariseLinkGaps({ unlinked: [], reconnect: [] });
    expect(s).toEqual({ unlinked: { count: 0, names: [] }, reconnect: { count: 0, names: [] } });
    expect(hasLinkGaps(s)).toBe(false);
  });

  it("each list is summarised on its own: a short one is named in full, in the order given", () => {
    const s = summariseLinkGaps({ unlinked: rows(3), reconnect: [{ name: "Re Connect" }] });
    expect(s.unlinked).toEqual({ count: 3, names: ["Player 1", "Player 2", "Player 3"] });
    expect(s.reconnect).toEqual({ count: 1, names: ["Re Connect"] });
  });

  it("there is something to say when EITHER list has someone, and when only one does", () => {
    const only = (kind: LinkGapKind) => summariseLinkGaps({ unlinked: [], reconnect: [], [kind]: rows(1) });
    expect(hasLinkGaps(only("unlinked"))).toBe(true);
    expect(hasLinkGaps(only("reconnect"))).toBe(true);
  });

  it("a long list keeps the TRUE count and names only the first five (5 -> all, 6 -> five, 40 -> five), for both lists", () => {
    // The cap is five: a sentence prints five names and folds the rest.
    const cases: { total: number; shown: number }[] = [
      { total: 5, shown: 5 },
      { total: 6, shown: 5 },
      { total: 40, shown: 5 },
    ];
    let checked = 0;
    for (const kind of ["unlinked", "reconnect"] as const) {
      for (const { total, shown } of cases) {
        const s = summariseLinkGaps({ unlinked: [], reconnect: [], [kind]: rows(total) })[kind];
        expect(s.count, `${kind} ${total}`).toBe(total);
        expect(s.names, `${kind} ${total}`).toEqual(rows(shown).map((p) => p.name));
        checked++;
      }
    }
    expect(checked).toBe(6);
  });
});

describe("linkGapSentence - the sentences, per locale", () => {
  const DICTS = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as unknown as Record<Locale, Dict>;
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const KINDS = ["unlinked", "reconnect"] as const;
  const render = (kind: LinkGapKind, locale: Locale, count: number, names: string[]) =>
    linkGapSentence(kind, { count, names }, locale, (key, n, vars) => plural(DICTS[locale], key, n, locale, vars));
  const template = (locale: Locale, key: string, n: number) =>
    String((DICTS[locale] as Record<string, unknown>)[`${key}.${new Intl.PluralRules(locale).select(n)}`]);
  const list = (locale: Locale, items: string[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  const fill = (t: string, vars: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

  it("every locale prints its own plural form and its own list join, for one, two, and a truncated many, for BOTH sentences", () => {
    let checked = 0;
    for (const kind of KINDS) {
      const key = `divset.onlinePlay.${kind}`;
      for (const locale of LOCALES) {
        // one player: the .one form of this locale (Intl decides it).
        expect(render(kind, locale, 1, ["Ana"]), `${kind} ${locale} x1`).toBe(
          fill(template(locale, key, 1), { count: 1, names: "Ana" }),
        );
        // two players: "A and B" in the locale's own conjunction.
        expect(render(kind, locale, 2, ["Ana", "Ben"]), `${kind} ${locale} x2`).toBe(
          fill(template(locale, key, 2), { count: 2, names: list(locale, ["Ana", "Ben"]) }),
        );
        // eight, five named: the three unnamed fold into the locale's "N more", as the list's last item.
        const five = ["Ana", "Ben", "Cy", "Dee", "Eli"];
        const more = fill(template(locale, "divset.onlinePlay.gapMore", 3), { count: 3 });
        const got = render(kind, locale, 8, five);
        expect(got, `${kind} ${locale} x8`).toBe(fill(template(locale, key, 8), { count: 8, names: list(locale, [...five, more]) }));
        expect(got, `${kind} ${locale} x8 carries the unnamed count`).toContain(more);
        expect(got, `${kind} ${locale} leaves no placeholder`).not.toMatch(/[{}]/);
        checked += 3;
      }
    }
    expect(checked, "anti-vacuity: 2 sentences x 4 locales x 3 sentences").toBe(24);
  });

  it("the singular and plural forms really differ in English (a witness: the wrong form has a different constant)", () => {
    expect(render("unlinked", "en", 1, ["Ana"])).toContain("1 player has");
    expect(render("unlinked", "en", 2, ["Ana", "Ben"])).toContain("2 players have");
    expect(render("reconnect", "en", 1, ["Ana"])).toContain("1 player needs to reconnect Lichess");
    expect(render("reconnect", "en", 2, ["Ana", "Ben"])).toContain("2 players need to reconnect Lichess");
  });

  it("the two sentences are different sentences in every locale (not one text under two keys)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const n of [1, 2]) {
        const names = n === 1 ? ["Ana"] : ["Ana", "Ben"];
        expect(render("reconnect", locale, n, names), `${locale} x${n}`).not.toBe(render("unlinked", locale, n, names));
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("a list that names everyone folds nothing; one that names nobody (count only) still prints the count", () => {
    expect(render("unlinked", "en", 2, ["Ana", "Ben"])).not.toContain("more");
    expect(render("reconnect", "en", 2, ["Ana", "Ben"])).not.toContain("more");
    // Defensive: a list with a count but no names (never built by summariseLinkGaps) is still a sentence.
    expect(render("reconnect", "en", 3, [])).toContain("3 players need to reconnect");
  });
});
