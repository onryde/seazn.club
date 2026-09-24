// Per-stage match rules — the public format LINE (brief 2026-09-24, option A).
//
// A fixture played in a stage whose rules differ from its division's printed
// the division's preset name ("Short (11 points)") over a Best-of-1 to 15. The
// describer states the EFFECTIVE rules instead, and one predicate decides WHEN
// it replaces the preset name. Both are pure; the loader and the hub call them.
//
// Every expected number is either handed to the module's own configSchema in
// the test (so the arithmetic is the assertion) or read back from the module's
// declared variants — never a table of sport constants typed in here
// (AGENTS.md 19). Where a case can, its right answer DIFFERS from the constant
// the wrong answer would print (15 vs the short preset's 11).
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveLatestModule } from "@/server/engine-db";
import { configKeysFor, STAGE_RULES_SPORTS } from "@/lib/match-rules";
import { GAME_UNIT_SPORTS } from "@/lib/public-site";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { describeMatchRules, effectiveRulesLine, rulesDifferFromDivision } from "../describe-rules";

const mod = (sportKey: string) => resolveLatestModule(sportKey);

/** A module whose parse is the identity — the only way to reach a config the
 *  guards refuse (every shipped schema defaults or rejects a missing/zero
 *  field). Pins RULES ("never 0", "a missing field says nothing"), not data. */
const permissive = (data: Record<string, unknown>): AnySportModule =>
  ({ configSchema: { safeParse: () => ({ success: true, data }) } }) as unknown as AnySportModule;

/** A variant's config the way a division row carries it: the module's schema
 *  over the variant's own declared overrides. */
function variantCfg(sportKey: string, variantKey: string): Record<string, unknown> {
  const m = mod(sportKey);
  const overrides = m.variants[variantKey];
  if (overrides === undefined) throw new Error(`${sportKey} declares no variant ${variantKey}`);
  return m.configSchema.parse(overrides) as Record<string, unknown>;
}

/** The prod defect's two configs (fixture 4137d495…, 2026-09-24). */
const SWISS_RULES = { bestOf: 1, setTo: 15, cap: 21, finalSetTo: 15, winBy: 2 };

describe("describeMatchRules — option A wording, from the parsed config", () => {
  it("badminton Best-of-1 to 15 capped at 21 reads as ONE game with its points and cap", () => {
    const badminton = mod("badminton");
    const cfg = { ...variantCfg("badminton", "short"), ...SWISS_RULES };
    expect(describeMatchRules("badminton", badminton, cfg)).toEqual({
      key: "format.rules.oneGamePointsCap",
      params: { points: 15, cap: 21 },
    });
  });

  it("the short preset itself describes as Best of N · points (cap) — every number read off the variant", () => {
    const badminton = mod("badminton");
    const cfg = variantCfg("badminton", "short") as { bestOf: number; setTo: number; cap: number };
    // The load-bearing property: the preset HAS a cap above its target, or the
    // cap clause below would be vacuous.
    expect(cfg.cap).toBeGreaterThan(cfg.setTo);
    expect(describeMatchRules("badminton", badminton, cfg)).toEqual({
      key: "format.rules.bestOfPointsCap",
      params: { n: cfg.bestOf, points: cfg.setTo, cap: cfg.cap },
    });
  });

  it("a cap EQUAL to the target is no cap at all — the clause is omitted", () => {
    const badminton = mod("badminton");
    const cfg = badminton.configSchema.parse({ bestOf: 3, setTo: 21, finalSetTo: 21, cap: 21 });
    expect(describeMatchRules("badminton", badminton, cfg)).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 21 },
    });
  });

  it("an uncapped sport (cap null) says points only", () => {
    const volleyball = mod("volleyball");
    const cfg = volleyball.configSchema.parse({ bestOf: 1 }) as { setTo: number; cap: unknown };
    expect(cfg.cap, "volleyball ships uncapped — the case this test is about").toBeNull();
    expect(describeMatchRules("volleyball", volleyball, cfg)).toEqual({
      key: "format.rules.oneSetPoints",
      params: { points: cfg.setTo },
    });
  });

  it("the ONE-unit noun is the sport's own: game for badminton/table tennis, set for volleyball/tennis", () => {
    // Derived from the existing authority (`GAME_UNIT_SPORTS`), so the two
    // public surfaces that name the unit cannot disagree.
    for (const sportKey of STAGE_RULES_SPORTS) {
      const m = mod(sportKey);
      const line = describeMatchRules(sportKey, m, m.configSchema.parse({ bestOf: 1 }));
      const noun = GAME_UNIT_SPORTS.has(sportKey) ? "oneGame" : "oneSet";
      expect(line?.key.startsWith(`format.rules.${noun}`), `${sportKey} → ${line?.key}`).toBe(true);
    }
  });

  it("tennis counts games, not points: only the best-of is stated (never a points number it does not have)", () => {
    const tennis = mod("tennis");
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ bestOf: 3 }))).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ bestOf: 1 }))).toEqual({
      key: "format.rules.oneSet",
    });
  });

  it("missing or non-positive fields say NOTHING about themselves — never 0, never invented", () => {
    expect(describeMatchRules("badminton", permissive({ bestOf: 3 }), {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(describeMatchRules("badminton", permissive({ bestOf: 1 }), {})).toEqual({
      key: "format.rules.oneGame",
    });
    expect(describeMatchRules("badminton", permissive({ bestOf: 3, setTo: 0, cap: 21 }), {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(describeMatchRules("badminton", permissive({ bestOf: 3, setTo: Number.NaN }), {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(describeMatchRules("badminton", permissive({ bestOf: 3, setTo: 11, cap: 0 }), {})).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 11 },
    });
    // A cap BELOW the target is a contradiction, not a clause.
    expect(describeMatchRules("badminton", permissive({ bestOf: 3, setTo: 11, cap: 9 }), {})).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 11 },
    });
    // No best-of at all: nothing honest to say.
    expect(describeMatchRules("badminton", permissive({ setTo: 11 }), {})).toBeNull();
    expect(describeMatchRules("badminton", permissive({ bestOf: 0, setTo: 11 }), {})).toBeNull();
    expect(describeMatchRules("badminton", permissive({ bestOf: "3" }), {})).toBeNull();
  });

  it("a refused config, a missing module, or a sport with no per-stage rules → null", () => {
    const badminton = mod("badminton");
    expect(describeMatchRules("badminton", badminton, { bestOf: 2 }), "bestOf must be odd").toBeNull();
    expect(describeMatchRules("badminton", null, SWISS_RULES)).toBeNull();
    // Carrom declares `bestOf` but is not a stage-rules sport, and its unit is
    // neither a game of points nor a set — the line stays with the preset.
    expect(STAGE_RULES_SPORTS.has("carrom")).toBe(false);
    expect(describeMatchRules("carrom", mod("carrom"), mod("carrom").configSchema.parse({}))).toBeNull();
    expect(describeMatchRules("football", mod("football"), mod("football").configSchema.parse({}))).toBeNull();
  });
});

describe("rulesDifferFromDivision — WHEN the described line replaces the preset name", () => {
  const badminton = mod("badminton");
  const division = variantCfg("badminton", "short");

  it("the prod case: a Swiss stage at Bo1/15/21 over a short division differs", () => {
    expect(rulesDifferFromDivision("badminton", badminton, { ...division, ...SWISS_RULES }, division)).toBe(true);
  });

  it("no override: identical configs do not differ", () => {
    expect(rulesDifferFromDivision("badminton", badminton, division, division)).toBe(false);
  });

  it("an override that restates the division's own values is NOT a difference (a stage `rules: {bestOf: 3}` over bestOf 3)", () => {
    const division3 = badminton.configSchema.parse({ bestOf: 3 }) as Record<string, unknown>;
    expect(rulesDifferFromDivision("badminton", badminton, { ...division3, bestOf: 3 }, division3)).toBe(false);
  });

  it("compares PARSED configs: a raw `{}` division and its own defaults filled in are the same rules", () => {
    // A frozen snapshot is the RAW resolved cfg; a division row may omit keys
    // its schema defaults. Comparing raw would call a defaulted `cap` a change.
    const filled = badminton.configSchema.parse({});
    expect(rulesDifferFromDivision("badminton", badminton, filled, {})).toBe(false);
  });

  it("ONLY the sport's rule keys count — points or a decider key moving is not a format change", () => {
    const keys = configKeysFor("badminton");
    expect(keys.has("pointsMap")).toBe(false);
    expect(
      rulesDifferFromDivision("badminton", badminton, { ...division, pointsMap: { "2-0": [3, 0] } }, division),
    ).toBe(false);
    expect(
      rulesDifferFromDivision("badminton", badminton, { ...division, shootout: { attempts: 5 } }, division),
    ).toBe(false);
  });

  it("each rule key, on its own, is a difference", () => {
    // Per KEY, not per test: a predicate reading only `bestOf` would pass the
    // prod case above and miss a cap-only override.
    const parsed = division as Record<string, number>;
    for (const key of configKeysFor("badminton")) {
      const moved = { ...division, [key]: key === "bestOf" ? parsed.bestOf! + 2 : parsed[key]! + 1 };
      expect(rulesDifferFromDivision("badminton", badminton, moved, division), key).toBe(true);
    }
  });

  it("tennis's NESTED rule keys compare by value, not by reference or key order", () => {
    const tennis = mod("tennis");
    const base = tennis.configSchema.parse({}) as Record<string, unknown>;
    const set = base.set as Record<string, unknown>;
    // Same value, keys in a different order — not a difference.
    const reordered = Object.fromEntries(Object.entries(set).reverse());
    expect(rulesDifferFromDivision("tennis", tennis, { ...base, set: reordered }, base)).toBe(false);
    // Fast4's set shape — a difference.
    const fast4 = { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 };
    expect(rulesDifferFromDivision("tennis", tennis, { ...base, set: fast4 }, base)).toBe(true);
  });

  it("with no module (or a refused parse) the raw configs are compared", () => {
    expect(rulesDifferFromDivision("badminton", null, { bestOf: 1 }, { bestOf: 3 })).toBe(true);
    expect(rulesDifferFromDivision("badminton", null, { bestOf: 3 }, { bestOf: 3 })).toBe(false);
    // `bestOf: 2` is refused by the schema — raw comparison still sees it.
    expect(rulesDifferFromDivision("badminton", badminton, { ...division, bestOf: 2 }, division)).toBe(true);
  });

  it("a RAW comparison is blind to nested key order (jsonb and a spread can order one object differently)", () => {
    // Only the raw path can see this — two parsed configs come out of one
    // schema in one key order — so it is pinned with no module.
    const a = { bestOf: 3, set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 } };
    const b = { bestOf: 3, set: { tiebreakTo: 7, tiebreakAt: 6, winBy: 2, gamesTo: 6 } };
    expect(rulesDifferFromDivision("tennis", null, a, b)).toBe(false);
    expect(rulesDifferFromDivision("tennis", null, a, { ...b, set: { ...b.set, gamesTo: 4 } })).toBe(true);
  });
});

describe("every line the describer can PRODUCE is in all four public dictionaries, with exactly its params", () => {
  // A key is owed by what can emit it (hub-dictionary.test.ts's header), so the
  // set is DRIVEN out of the describer over every shape it branches on — one
  // unit per sport, with/without points, with/without a cap, best-of 1 and 3 —
  // rather than listed by hand, where a new branch could not fail.
  const emitted = new Map<string, string[]>();
  for (const sportKey of STAGE_RULES_SPORTS) {
    for (const bestOf of [1, 3]) {
      for (const extra of [{}, { setTo: 11 }, { setTo: 11, cap: 15 }]) {
        const line = describeMatchRules(sportKey, permissive({ bestOf, ...extra }), {});
        if (line) emitted.set(line.key, Object.keys(line.params ?? {}).sort());
      }
    }
  }
  const dicts = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as Record<string, Record<string, string>>;
  const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

  it("the drive reaches all nine shapes (so the loop below is not vacuous)", () => {
    expect(emitted.size).toBe(9);
  });

  for (const [locale, dict] of Object.entries(dicts)) {
    it(`${locale}: each emitted key exists and interpolates exactly the params passed`, () => {
      for (const [key, params] of emitted) {
        expect(Object.hasOwn(dict, key), `${locale} ${key}`).toBe(true);
        expect(placeholders(dict[key]!), `${locale} ${key}`).toEqual(params);
      }
    });
  }
});

describe("effectiveRulesLine — the two together", () => {
  const badminton = mod("badminton");
  const division = variantCfg("badminton", "short");

  it("differs → the described EFFECTIVE rules, whose number is NOT the preset's", () => {
    const line = effectiveRulesLine("badminton", badminton, { ...division, ...SWISS_RULES }, division);
    expect(line).toEqual({ key: "format.rules.oneGamePointsCap", params: { points: 15, cap: 21 } });
    // The regression's own witness: the wrong answer's number is 11.
    expect((division as { setTo: number }).setTo).not.toBe(15);
  });

  it("same rules → null, so the caller keeps its preset name", () => {
    expect(effectiveRulesLine("badminton", badminton, division, division)).toBeNull();
  });

  it("differs but cannot be described → null (the preset name stays; nothing is invented)", () => {
    expect(effectiveRulesLine("carrom", mod("carrom"), { bestOf: 1 }, { bestOf: 3 })).toBeNull();
  });
});
