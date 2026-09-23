// The device-link panel's description in every locale names the sport's
// official in THAT locale (scorer sheets T3, fix round 2). Before, the console
// passed the engine's English `officialLabel.scorer` straight in, and French
// read "La personne … en tant que referee".
//
// `useMsg` is bound to a chosen locale (the same mock shape as
// `entrants-panel-row-expanded-i18n.test.tsx`), and the sports are the
// engine's real registered modules, so a new sport is covered the day it
// registers. The negative ("never the English word") runs only where the
// locale's word really differs from English — Dutch chess says "arbiter" too,
// and demanding otherwise would make the test assert a mistranslation.
import { describe, expect, it, vi } from "vitest";
import { registerBuiltins } from "@seazn/engine/sports";
import type { AnySportModule, SportRegistry } from "@seazn/engine/sport";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import { officialLabelKey } from "@/lib/official-label";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const active = vi.hoisted(() => ({ locale: "en" }));

vi.mock("@/components/i18n/dict-provider", async () => {
  const { t: translate } = await import("@/lib/i18n-runtime");
  const dicts: Record<string, unknown> = {
    en: (await import("@/dictionaries/en/ui.json")).default,
    es: (await import("@/dictionaries/es/ui.json")).default,
    fr: (await import("@/dictionaries/fr/ui.json")).default,
    nl: (await import("@/dictionaries/nl/ui.json")).default,
  };
  return {
    useMsg:
      () =>
      (key: string, vars?: Record<string, string | number>): string =>
        translate(dicts[active.locale] as never, key as never, vars),
  };
});
// No link yet: the mount GET finds nothing, so only the description and
// Create render — the description is what this file is about.
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: vi.fn(async () => null) };
});

const MODULES: { key: string; scorer: string }[] = [];
const capture: SportRegistry = {
  register(m: AnySportModule) {
    MODULES.push({ key: m.key, scorer: m.officialLabel.scorer });
  },
  get: () => {
    throw new Error("capture registry: get");
  },
  latest: () => {
    throw new Error("capture registry: latest");
  },
};
registerBuiltins(capture);

const DICTS = { en, es, fr, nl } as unknown as Record<string, Parameters<typeof t>[0]>;
const CASES = Object.keys(DICTS).flatMap((locale) => MODULES.map((m) => ({ locale, ...m })));

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("device-link panel — the official is named in the viewer's locale", () => {
  it("covers the engine's real sports in all four locales", () => {
    expect(MODULES.length).toBeGreaterThan(5);
    expect(CASES.filter((c) => c.locale === "fr").length).toBe(MODULES.length);
    // The negative below skips a locale whose word equals English. For French
    // it must skip NOTHING, or "fr renders no English label" is vacuous.
    const frSameAsEnglish = MODULES.filter(
      (m) => t(DICTS.fr!, officialLabelKey(m.key)).toLowerCase() === m.scorer.toLowerCase(),
    );
    expect(frSameAsEnglish).toEqual([]);
  });

  it.each(CASES)("$locale / $key: the description names the official in $locale", async ({ locale, key, scorer }) => {
    active.locale = locale;
    const dict = DICTS[locale]!;
    const label = t(dict, officialLabelKey(key)).toLowerCase();
    const island = renderIsland(DeviceLinkPanel, { fixtureId: "f1", sportKey: key, viewerPlan: "pro" as const });
    await flush();
    const text = island.text();
    expect(text).toContain(t(dict, "dlink.desc", { scorer: label }));
    if (locale === "en") expect(text.toLowerCase()).toContain(scorer.toLowerCase());
    else if (label !== scorer.toLowerCase()) {
      const english = new RegExp(`\\b${scorer.replace(/\s+/g, "\\s+")}\\b`, "i");
      expect(text, `${locale} must not say the English "${scorer}"`).not.toMatch(english);
    }
  });
});
