// Search results cut a title at about 60 characters and a description at about 160. Every product and sport page's
// meta copy fits, in every locale, so nothing a searcher reads ends in an ellipsis.
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const DICTS: Record<string, Record<string, string>> = { en, fr, es, nl };
const TITLE_MAX = 60;
const DESC_MAX = 160;
const DESC_MIN = 70;

describe("product and sport page meta copy", () => {
  it("every title and description fits a search result, in every locale, and none repeats", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const d = DICTS[lang]!;
      const titles = Object.keys(d).filter((k) => /^(product|sport)\.[a-z]+\.meta\.title$/.test(k));
      const descs = Object.keys(d).filter((k) => /^(product|sport)\.[a-z]+\.meta\.description$/.test(k));
      expect(titles.length, lang).toBe(descs.length);
      for (const k of titles) {
        expect(d[k]!.length, `${lang} ${k}: ${d[k]}`).toBeLessThanOrEqual(TITLE_MAX);
        checked++;
      }
      for (const k of descs) {
        expect(d[k]!.length, `${lang} ${k}`).toBeLessThanOrEqual(DESC_MAX);
        expect(d[k]!.length, `${lang} ${k}`).toBeGreaterThanOrEqual(DESC_MIN);
        checked++;
      }
      expect(new Set(titles.map((k) => d[k])).size, `${lang} titles`).toBe(titles.length);
      expect(new Set(descs.map((k) => d[k])).size, `${lang} descriptions`).toBe(descs.length);
    }
    // 16 pages, a title and a description each, four locales.
    expect(checked).toBe(16 * 2 * 4);
  });
});
