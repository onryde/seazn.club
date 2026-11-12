// The code sheet's Day hint: what the day means, in the organisation's zone, as the field's accessible description.
// Rendered to static markup (the suite is node-only); the expected copy is read from each dictionary file, with the
// zone swapped in by hand, never through the sheet's own `t`.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { MatchDayCodeSheet } from "../match-day-code-sheet";

const DICTS = { en, es, fr, nl } as unknown as Record<Locale, Dict>;
const ZONE = "Europe/London";

function sheet(locale: Locale): string {
  return renderToStaticMarkup(
    <MatchDayCodeSheet competitionId="c1" dict={DICTS[locale]} locale={locale} today="2026-11-12" zone={ZONE} courts={[]} venuesToday={[]} onClose={() => {}} />,
  );
}

describe("Match Day code sheet: Day hint", () => {
  it("every locale shows the hint with the zone, and the Day input is described by it (counted)", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(DICTS) as [Locale, Record<string, string>][]) {
      const raw = d["matchDay.code.dayHint"]!;
      expect(raw, locale).toContain("{zone}");
      const html = sheet(locale);
      const hint = raw.replace("{zone}", ZONE);
      expect(html, locale).toMatch(new RegExp(`<span id="md-code-day-hint"[^>]*>${hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`));
      expect(html, locale).toMatch(/<input[^>]*data-testid="md-code-day"[^>]*aria-describedby="md-code-day-hint"/);
      expect(html, locale).not.toMatch(/matchDay\.code\.dayHint|\{zone\}/);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the English copy is the owner's sentence", () => {
    expect((en as Record<string, string>)["matchDay.code.dayHint"]).toBe(
      "The code works from 00:00 to 24:00 on this day ({zone}) and lists the matches scheduled that day.",
    );
  });
});
