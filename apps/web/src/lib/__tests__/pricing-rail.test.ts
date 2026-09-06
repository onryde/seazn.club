// The rail's SET is what stops a new sport being added to the engine and the
// /pricing board going silently stale. The literal in pricing-rail.ts owns
// ORDER (the mockup's editorial order — see its own header comment); this
// test owns MEMBERSHIP, against the catalogue SPORT_KEY is already pinned to
// (scoring-vocab.test.ts: "SPORT_KEY carries exactly the engine's sport
// keys — none missing, none stale").
import { describe, expect, it } from "vitest";
import {
  PRICING_RAIL_SPORTS,
  PRICING_RAIL_FOOTER_KEY,
  pricingRailKey,
} from "@/lib/pricing-rail";
import { SPORT_KEY } from "@/lib/scoring-vocab";
import enMarketing from "@/dictionaries/en/marketing.json";
import esMarketing from "@/dictionaries/es/marketing.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import nlMarketing from "@/dictionaries/nl/marketing.json";

const DICTS: Record<string, Record<string, string>> = {
  en: enMarketing,
  es: esMarketing,
  fr: frMarketing,
  nl: nlMarketing,
};

describe("the pricing rail's sport set", () => {
  it("equals the catalogue's non-generic sports — none missing, none stale", () => {
    const catalogue = Object.keys(SPORT_KEY)
      .filter((k) => k !== "generic")
      .sort();
    expect([...PRICING_RAIL_SPORTS].sort()).toEqual(catalogue);
    // Anti-vacuity: this is a real, non-empty comparison, not two empty arrays
    // agreeing with each other.
    expect(catalogue.length).toBeGreaterThan(0);
  });

  it("never lists generic as a rail sport — it is the board's foot line", () => {
    expect(PRICING_RAIL_SPORTS).not.toContain("generic" as unknown as string);
  });

  it("has no duplicate slot", () => {
    expect(new Set(PRICING_RAIL_SPORTS).size).toBe(PRICING_RAIL_SPORTS.length);
  });

  it("keeps the mockup's editorial order — not alphabetical", () => {
    const sorted = [...PRICING_RAIL_SPORTS].sort();
    expect(PRICING_RAIL_SPORTS).not.toEqual(sorted);
    expect(PRICING_RAIL_SPORTS[0]).toBe("football");
  });
});

describe.each(["en", "es", "fr", "nl"])("the rail's %s dictionary entries", (locale) => {
  const dict = DICTS[locale]!;

  it("has a non-empty translated entry for every rail sport", () => {
    for (const sport of PRICING_RAIL_SPORTS) {
      const value = dict[pricingRailKey(sport)];
      expect(value, `${locale}: ${sport}`).toBeTruthy();
      expect(typeof value).toBe("string");
    }
  });

  it("has a non-empty foot-line entry", () => {
    expect(dict[PRICING_RAIL_FOOTER_KEY]).toBeTruthy();
  });
});
