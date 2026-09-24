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
import { describeMatchRules, effectiveRulesLine } from "../describe-rules";

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

  it("the short preset itself describes as Best of N, points (cap) — every number read off the variant", () => {
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
    const cfg = volleyball.configSchema.parse({ bestOf: 1 }) as { finalSetTo: number; cap: unknown };
    expect(cfg.cap, "volleyball ships uncapped — the case this test is about").toBeNull();
    expect(describeMatchRules("volleyball", volleyball, cfg)).toEqual({
      key: "format.rules.oneSetPoints",
      params: { points: cfg.finalSetTo },
    });
  });

  it("a ONE-unit match is its own decider, so it plays to `finalSetTo` — never `setTo` (kernel `setTarget`)", () => {
    // The set kernel plays set index bestOf−1 to `finalSetTo`; with bestOf 1
    // that is the only set. Volleyball's defaults are the sharp case: 25 per
    // set, 15 in the decider — a Bo1 volleyball match is to 15, not 25.
    const volleyball = mod("volleyball");
    const v = volleyball.configSchema.parse({ bestOf: 1 }) as { setTo: number; finalSetTo: number };
    expect(v.finalSetTo, "the witness needs the two targets apart").not.toBe(v.setTo);
    expect(describeMatchRules("volleyball", volleyball, v)?.params?.points).toBe(v.finalSetTo);
    // Badminton with the two apart, capped above both: the cap reads against
    // the target the game is actually played to.
    const badminton = mod("badminton");
    const b = badminton.configSchema.parse({ bestOf: 1, setTo: 21, finalSetTo: 11, cap: 30 });
    expect(describeMatchRules("badminton", badminton, b)).toEqual({
      key: "format.rules.oneGamePointsCap",
      params: { points: 11, cap: 30 },
    });
  });

  it("a decider played to a DIFFERENT target is said: volleyball indoor reads '…, decider 15' — every number off the variant", () => {
    const volleyball = mod("volleyball");
    const cfg = variantCfg("volleyball", "indoor") as { bestOf: number; setTo: number; finalSetTo: number };
    expect(cfg.finalSetTo, "indoor's decider must differ from its sets").not.toBe(cfg.setTo);
    expect(describeMatchRules("volleyball", volleyball, cfg)).toEqual({
      key: "format.rules.bestOfPointsDecider",
      params: { n: cfg.bestOf, points: cfg.setTo, decider: cfg.finalSetTo },
    });
  });

  it("the decider clause rides after the cap clause, and is omitted when the decider plays to the same target", () => {
    const badminton = mod("badminton");
    const decider = badminton.configSchema.parse({ bestOf: 3, setTo: 21, finalSetTo: 15, cap: 30 });
    expect(describeMatchRules("badminton", badminton, decider)).toEqual({
      key: "format.rules.bestOfPointsCapDecider",
      params: { n: 3, points: 21, cap: 30, decider: 15 },
    });
    // bwf: the third game is to 21 like the first two — no clause.
    const bwf = variantCfg("badminton", "bwf") as { setTo: number; finalSetTo: number };
    expect(bwf.finalSetTo).toBe(bwf.setTo);
    expect(describeMatchRules("badminton", badminton, bwf)?.key).toBe("format.rules.bestOfPointsCap");
    // A missing or zero decider says nothing about itself.
    expect(describeMatchRules("badminton", permissive({ bestOf: 3, setTo: 21, finalSetTo: 0 }), {})).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 21 },
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

describe("effectiveRulesLine — WHEN the described line replaces the preset name: only when its WORDS differ", () => {
  // The line replaces the division's preset name only when it would SAY
  // something different from what the same describer says of the division.
  // A difference it cannot express (tennis `finalSet`/`set`, badminton
  // `winBy`) keeps the preset — otherwise the page swaps the preset for words
  // identical to the division's own (review round 1, finding 1).
  const badminton = mod("badminton");
  const division = variantCfg("badminton", "short");
  const line = (sportKey: string, effective: unknown, div: unknown) =>
    effectiveRulesLine(sportKey, mod(sportKey), effective, div);

  it("the prod case: a Swiss stage at Bo1/15/21 over a short division names ITS rules — 15, not the preset's 11", () => {
    expect(line("badminton", { ...division, ...SWISS_RULES }, division)).toEqual({
      key: "format.rules.oneGamePointsCap",
      params: { points: 15, cap: 21 },
    });
    expect((division as { setTo: number }).setTo).not.toBe(15);
  });

  it("EMPTY FIRST: identical rules → null, so the caller keeps its preset name", () => {
    expect(line("badminton", division, division)).toBeNull();
  });

  it("an override that restates the division's own values → null (a stage `rules: {bestOf: 3}` over bestOf 3)", () => {
    const division3 = badminton.configSchema.parse({ bestOf: 3 }) as Record<string, unknown>;
    expect(line("badminton", { ...division3, bestOf: 3 }, division3)).toBeNull();
  });

  it("both sides are PARSED: a raw `{}` division and its own defaults filled in are the same rules", () => {
    // A frozen snapshot is the RAW resolved cfg; a division row may omit keys
    // its schema defaults. Unparsed, a defaulted `cap` would read as a change.
    expect(line("badminton", badminton.configSchema.parse({}), {})).toBeNull();
  });

  it("standings points or a decider KEY (shootout) moving is not a format change → null", () => {
    expect(line("badminton", { ...division, pointsMap: { "2-0": [3, 0] } }, division)).toBeNull();
    expect(line("badminton", { ...division, shootout: { attempts: 5 } }, division)).toBeNull();
  });

  it("each rule the line can SAY, moved on its own, is named: bestOf, setTo, cap, finalSetTo", () => {
    const d = division as { bestOf: number; setTo: number; finalSetTo: number; cap: number };
    expect(line("badminton", { ...d, bestOf: 5 }, d)).toEqual({
      key: "format.rules.bestOfPointsCap",
      params: { n: 5, points: d.setTo, cap: d.cap },
    });
    // setTo and finalSetTo move TOGETHER for a best-of-3 (the decider keeps
    // up), inside the division's cap — only the points number changes.
    expect(line("badminton", { ...d, setTo: 13, finalSetTo: 13 }, d)).toEqual({
      key: "format.rules.bestOfPointsCap",
      params: { n: d.bestOf, points: 13, cap: d.cap },
    });
    expect(line("badminton", { ...d, cap: 17 }, d)).toEqual({
      key: "format.rules.bestOfPointsCap",
      params: { n: d.bestOf, points: d.setTo, cap: 17 },
    });
    // finalSetTo ALONE: the decider clause is what makes it sayable.
    expect(line("badminton", { ...d, finalSetTo: d.cap }, d)).toEqual({
      key: "format.rules.bestOfPointsCapDecider",
      params: { n: d.bestOf, points: d.setTo, cap: d.cap, decider: d.cap },
    });
  });

  it("volleyball: a stage that plays its decider to 25 like every other set names that — the division's line has a decider clause, the stage's has none", () => {
    const indoor = variantCfg("volleyball", "indoor") as { bestOf: number; setTo: number };
    expect(line("volleyball", { ...indoor, finalSetTo: indoor.setTo }, indoor)).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: indoor.bestOf, points: indoor.setTo },
    });
  });

  it("a difference the describer CANNOT say → null: badminton `winBy` alone", () => {
    const d = division as { winBy: number };
    expect(configKeysFor("badminton").has("winBy"), "winBy is a rule key — the case this is about").toBe(true);
    expect(line("badminton", { ...division, winBy: d.winBy - 1 }, division)).toBeNull();
  });

  it("a difference the describer CANNOT say → null: tennis `finalSet` alone (grand-slam's) and `set` alone (fast4's)", () => {
    const tour = variantCfg("tennis", "tour");
    const grandSlam = variantCfg("tennis", "grand-slam") as Record<string, unknown>;
    const fast4 = variantCfg("tennis", "fast4") as Record<string, unknown>;
    expect(grandSlam.finalSet, "the premise: grand-slam's final set differs").not.toEqual(tour.finalSet);
    expect(line("tennis", { ...tour, finalSet: grandSlam.finalSet }, tour)).toBeNull();
    expect(line("tennis", { ...tour, set: fast4.set }, tour)).toBeNull();
    // The positive pair: a best-of it CAN say is named.
    expect(line("tennis", { ...tour, bestOf: 5 }, tour)).toEqual({ key: "format.sets.bestOf", params: { n: 5 } });
  });

  it("no module, a refused config, or a sport with no per-stage rules → null (the preset stays; nothing invented)", () => {
    expect(effectiveRulesLine("badminton", null, { ...division, ...SWISS_RULES }, division)).toBeNull();
    expect(line("badminton", { ...division, bestOf: 2 }, division), "bestOf must be odd").toBeNull();
    expect(line("carrom", { bestOf: 1 }, { bestOf: 3 })).toBeNull();
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
      for (const extra of [
        {},
        { setTo: 11 },
        { setTo: 11, cap: 15 },
        { setTo: 11, finalSetTo: 15 },
        { setTo: 11, cap: 21, finalSetTo: 15 },
      ]) {
        const line = describeMatchRules(sportKey, permissive({ bestOf, ...extra }), {});
        if (line) emitted.set(line.key, Object.keys(line.params ?? {}).sort());
      }
    }
  }
  const dicts = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as Record<string, Record<string, string>>;
  const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

  it("the drive reaches all eleven shapes (so the loop below is not vacuous)", () => {
    expect(emitted.size).toBe(11);
  });

  for (const [locale, dict] of Object.entries(dicts)) {
    it(`${locale}: each emitted key exists and interpolates exactly the params passed`, () => {
      for (const [key, params] of emitted) {
        expect(Object.hasOwn(dict, key), `${locale} ${key}`).toBe(true);
        expect(placeholders(dict[key]!), `${locale} ${key}`).toEqual(params);
        // The match header joins its facts with " · " (`match-centre.ts`), so
        // a line that used it too would read as several separate facts
        // ("1 game · 15 points · Court 2"). Its clauses join with commas.
        expect(dict[key], `${locale} ${key} must not use the header's joiner`).not.toContain("·");
      }
    });
  }
});
