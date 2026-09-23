// The sport's official ("Umpire" / "Referee" / "Arbiter" / …) as the viewer's
// locale says it (scorer sheets T3, fix round 2). The engine declares the
// label in English on each module (`officialLabel.scorer`, doc 13 §1); the
// device-link panel interpolated that English into every locale's sentence,
// so French read "en tant que referee".
//
// The expected values are DERIVED from the engine's own declarations — every
// module `registerBuiltins` registers — never a table typed here: a new sport
// reds "an explicit key" until it gets one, and a renamed label reds the en
// row instead of leaving the dictionary saying yesterday's word.
import { describe, expect, it } from "vitest";
import { registerBuiltins } from "@seazn/engine/sports";
import type { AnySportModule, SportRegistry } from "@seazn/engine/sport";
import { officialLabelKey } from "@/lib/official-label";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

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

const DICTS = { en, es, fr, nl } as Record<string, Record<string, string>>;

describe("officialLabelKey — every registered sport's official, localised", () => {
  it("the corpus is the engine's real module list (not empty, football among it)", () => {
    expect(MODULES.length).toBeGreaterThan(5);
    expect(MODULES.map((m) => m.key)).toContain("football");
  });

  it.each(MODULES)("$key: an explicit key, and en says what the engine declares ($scorer)", ({ key, scorer }) => {
    const k = officialLabelKey(key);
    expect(k).toBe(`sport.official.${key}`);
    expect(en[k as keyof typeof en]?.toLowerCase()).toBe(scorer.toLowerCase());
  });

  it.each(MODULES)("$key: a label in every locale", ({ key }) => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      expect(dict[officialLabelKey(key)], `${locale} ${key}`).toMatch(/\p{L}/u);
    }
  });

  it.each(MODULES)("$key: French never says the engine's English ($scorer)", ({ key, scorer }) => {
    expect(fr[officialLabelKey(key) as keyof typeof fr]?.toLowerCase()).not.toBe(scorer.toLowerCase());
  });

  it("an unregistered sport gets the generic, localised label — never an English literal", () => {
    expect(officialLabelKey("pickleball")).toBe("sport.official.generic");
    expect(officialLabelKey("toString")).toBe("sport.official.generic");
  });
});
