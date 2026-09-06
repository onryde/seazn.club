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
  PRICING_RAIL_COVERAGE,
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
  it("has exactly nine slots — carrom folded into board games, 3x3 clean", () => {
    expect(PRICING_RAIL_SPORTS.length).toBe(9);
    expect(PRICING_RAIL_SPORTS as readonly string[]).not.toContain("carrom");
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

// A rail slot is a DEVICE, not a 1:1 sport list any more — carrom folds into
// "Board games" (owner: carrom is covered by that slot, so it does not need
// its own). Equality against the catalogue would break the day a sport is
// deliberately folded, so the guard is a COVERAGE MAP asserted in both
// directions: every catalogue sport is covered by some rail entry, and every
// rail entry is reachable from at least one catalogue sport. Neither a new
// sport nor a dead rail slot can hide behind the other.
describe("the pricing rail's sport coverage map", () => {
  const catalogue = Object.keys(SPORT_KEY)
    .filter((k) => k !== "generic")
    .sort();

  it("covers every catalogue sport — none missing, none stale", () => {
    expect(Object.keys(PRICING_RAIL_COVERAGE).sort()).toEqual(catalogue);
    // Anti-vacuity: a real, non-empty comparison.
    expect(catalogue.length).toBeGreaterThan(0);
  });

  it("maps every covered sport to a rail entry that actually exists", () => {
    for (const [sport, rail] of Object.entries(PRICING_RAIL_COVERAGE)) {
      expect(PRICING_RAIL_SPORTS as readonly string[], sport).toContain(rail);
    }
  });

  it("makes every rail entry reachable from at least one catalogue sport", () => {
    const reached = new Set(Object.values(PRICING_RAIL_COVERAGE));
    for (const rail of PRICING_RAIL_SPORTS) {
      expect(reached.has(rail), `${rail} has no sport pointing at it`).toBe(true);
    }
  });

  it("folds carrom into board games, not its own slot", () => {
    expect(PRICING_RAIL_COVERAGE.carrom).toBe("boardgame");
  });

  it("maps every other sport to itself", () => {
    for (const sport of catalogue.filter((s) => s !== "carrom")) {
      expect(PRICING_RAIL_COVERAGE[sport as keyof typeof PRICING_RAIL_COVERAGE], sport).toBe(
        sport,
      );
    }
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
