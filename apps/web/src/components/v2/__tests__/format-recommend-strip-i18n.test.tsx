// The console's recommendation strip words every pick from the page's dictionary (start-wizard redesign, plan 2026-11-13
// Task 4, P6 / review-t4 I1). It used to print `recommendFormats`' English `title` and `reason` in every language.
// Rendered through the real DictProvider with each locale's `ui` catalog from disk. Expected words are the dictionary
// files; the counts are `recommendFormats`' numbers. No sport is involved: the strip takes no sport (a single-sport reason
// does not apply).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { FORMAT_NAME_KEY, FORMAT_TAGLINE_KEY, recommendFormats } from "@/lib/format-recommend";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { FormatRecommendStrip } from "../format-recommend-strip";

const ui = (locale: Locale): Record<string, string> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
const html = (locale: Locale) =>
  renderToStaticMarkup(
    <DictProvider dict={ui(locale) as unknown as Dict} locale={locale}>
      <FormatRecommendStrip initialEntrants={16} />
    </DictProvider>,
  );
/** The markup's text: tags dropped, the entities React writes for dictionary copy read back. */
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), s);
const plural = (d: Record<string, string>, locale: Locale, key: string, count: number, vars: Record<string, string | number> = {}) =>
  fill(d[`${key}.${new Intl.PluralRules(locale).select(count)}`] ?? d[`${key}.other`]!, { count, ...vars });

/** What the strip printed before it read the dictionary: `recommendFormats`' own English. */
const OLD_ENGLISH = [
  "League (round robin)",
  "Groups + knockout",
  "everyone plays everyone",
  "guaranteed group matches for all",
  "fixed rounds, nobody eliminated",
  "a second life for everyone",
  "fastest to a champion",
  " matches ≈ ",
];

describe("the recommendation strip, in every locale", () => {
  it("each pick is its template's name, its count and day in the locale's words, and its tagline — never the English", () => {
    const picks = recommendFormats({ entrants: 16, courts: 2, hours: 4 });
    expect(picks.length, "premise: the strip has picks to word").toBeGreaterThan(0);
    let checked = 0;
    for (const locale of LOCALES) {
      const d = ui(locale);
      const en = ui("en");
      const text = textOf(html(locale));
      for (const p of picks) {
        const hours = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(p.estHours);
        const wanted = [
          d[FORMAT_NAME_KEY[p.slug]]!,
          plural(d, locale, "recommend.matches", p.matches),
          plural(d, locale, "recommend.time", 2, { hours }),
          d[FORMAT_TAGLINE_KEY[p.slug]]!,
        ];
        for (const words of wanted) expect(text, `${locale} ${p.slug}`).toContain(words);
        // The English of each line is absent wherever the locale's own words differ.
        if (locale !== "en") {
          for (const key of [FORMAT_NAME_KEY[p.slug], FORMAT_TAGLINE_KEY[p.slug]]) {
            if (d[key] !== en[key]) expect(text, `${locale}: English ${key}`).not.toContain(en[key]!);
          }
        }
        checked++;
      }
      for (const old of OLD_ENGLISH) expect(text, `${locale}: the old English "${old}"`).not.toContain(old);
    }
    expect(checked).toBe(LOCALES.length * picks.length);
  });

  it("recommendFormats carries numbers and a slug only: no prose for a strip to print untranslated", () => {
    const picks = recommendFormats({ entrants: 16, courts: 2, hours: 4 });
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) expect(Object.keys(p).sort()).toEqual(["estHours", "matches", "perEntrant", "slug"]);
  });
});
