// The code sheet's "can call" power (Task 8e): a checkbox, unticked by default, labelled in every locale.
// Rendered to static markup (the suite is node-only); the expected label is read from each dictionary file,
// never through the sheet's own `t`.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { MatchDayCodeSheet } from "../match-day-code-sheet";

const DICTS = { en, es, fr, nl } as unknown as Record<Locale, Dict>;

function sheet(locale: Locale): string {
  return renderToStaticMarkup(
    <MatchDayCodeSheet competitionId="c1" dict={DICTS[locale]} locale={locale} today="2026-11-12" zone="Europe/London" courts={[]} venuesToday={[]} onClose={() => {}} />,
  );
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
}

describe("Match Day code sheet: can call", () => {
  it("every locale shows one unticked checkbox, labelled with the dictionary's words (counted)", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(DICTS) as [Locale, Record<string, string>][]) {
      const label = d["matchDay.code.call"]!;
      expect(label, locale).toBeTruthy();
      const html = sheet(locale);
      const box = html.match(/<input[^>]*data-testid="md-code-call"[^>]*\/?>/g) ?? [];
      expect(box, locale).toHaveLength(1);
      expect(box[0], locale).toMatch(/type="checkbox"/);
      expect(box[0], locale).not.toMatch(/checked/);
      expect(html, locale).toMatch(new RegExp(`<label[^>]*>${escape(box[0]!)}<span>${escape(label)}</span></label>`));
      expect(html, locale).not.toMatch(/matchDay\.code\.call/);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
