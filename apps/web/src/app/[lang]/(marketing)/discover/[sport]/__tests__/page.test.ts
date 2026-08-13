import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";

// page.tsx pulls in MarketingShell, which loads next/font/google at module
// scope — unavailable under vitest (same fix ../../__tests__/page.test.tsx
// uses for the parent /discover page). This test only reads the exported
// SPORTS_WITH_COPY constant, so a no-op passthrough is enough. vitest hoists
// vi.mock() above the imports below regardless of this textual position.
vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => children,
}));

import { SPORTS_WITH_COPY } from "../page";
import mktEn from "@/dictionaries/en/marketing.json";
import mktEs from "@/dictionaries/es/marketing.json";
import mktFr from "@/dictionaries/fr/marketing.json";
import mktNl from "@/dictionaries/nl/marketing.json";

const LOCALES = {
  en: mktEn as Record<string, string>,
  es: mktEs as Record<string, string>,
  fr: mktFr as Record<string, string>,
  nl: mktNl as Record<string, string>,
};

// /discover/{sport} (page.tsx's `sportCopy`) falls back to generic marketing
// copy for any sport key NOT in `SPORTS_WITH_COPY` — a stale or misspelled
// member degrades silently to that generic copy, nothing throws or reds, so
// this is a drift test, not a render test (#S13).
//
// SPORTS_WITH_COPY is a seven-key SUBSET of the engine's eleven sports (which
// get bespoke marketing copy is a content decision), not a duplicate of
// scoring-vocab.ts's SportKey union — so this pins membership and dictionary
// coverage, and deliberately does NOT widen the set itself.
describe("discover/[sport] SPORTS_WITH_COPY stays a real, fully-translated subset", () => {
  const engineKeys = new Set(builtinModules.map((m) => m.key));

  it("is non-empty (vacuity guard — the loops below prove nothing over zero members)", () => {
    expect(SPORTS_WITH_COPY.size).toBeGreaterThan(0);
  });

  it("every member is a sport key the engine actually ships", () => {
    for (const key of SPORTS_WITH_COPY) {
      expect(engineKeys, `"${key}" in SPORTS_WITH_COPY is not an engine sport key`).toContain(key);
    }
  });

  it("every member resolves discover.sport.copy.<key>.intro/.detail in all four locales", () => {
    for (const key of SPORTS_WITH_COPY) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(dict, `${locale}: missing discover.sport.copy.${key}.intro`).toHaveProperty(
          `discover.sport.copy.${key}.intro`,
        );
        expect(dict, `${locale}: missing discover.sport.copy.${key}.detail`).toHaveProperty(
          `discover.sport.copy.${key}.detail`,
        );
      }
    }
  });
});
