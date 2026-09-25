// Per-stage match rules — the public format LINE (brief 2026-09-24, option A).
//
// A fixture played in a stage whose rules differ from its division's printed
// the division's preset name ("Short (11 points)") over a Best-of-1 to 15. The
// describer states the EFFECTIVE rules instead, and one predicate decides WHEN
// it replaces the preset name: whenever the effective RULE KEYS differ from the
// division's (review round 2 — a true-but-vague line beats a false preset
// name). Both are pure; the loader and the hub call them.
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
import { rulesLineText } from "@/lib/rules-line";
import { describeMatchRules, effectiveRulesLine, rulesDifferFromDivision, type RulesLineT } from "../describe-rules";

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

/** The set kernel describes as ONE clause; this unwraps it (and pins that). */
function one(sportKey: string, m: AnySportModule | null, cfg: unknown) {
  const line = describeMatchRules(sportKey, m, cfg);
  if (line === null) return null;
  expect(line, `${sportKey}: the set kernel says its rules in one clause`).toHaveLength(1);
  return line[0];
}

/** The four set-kernel-or-tennis sports split by config SHAPE (tennis nests `set`). */
const SET_KERNEL_SPORTS = [...STAGE_RULES_SPORTS].filter(
  (k) => typeof (mod(k).configSchema.parse({}) as Record<string, unknown>).set !== "object",
);

describe("describeMatchRules — option A wording, from the parsed config", () => {
  it("badminton Best-of-1 to 15 capped at 21 reads as ONE game with its points and cap", () => {
    const badminton = mod("badminton");
    const cfg = { ...variantCfg("badminton", "short"), ...SWISS_RULES };
    expect(one("badminton", badminton, cfg)).toEqual({
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
    expect(one("badminton", badminton, cfg)).toEqual({
      key: "format.rules.bestOfPointsCap",
      params: { n: cfg.bestOf, points: cfg.setTo, cap: cfg.cap },
    });
  });

  it("a cap EQUAL to the target is no cap at all — the clause is omitted", () => {
    const badminton = mod("badminton");
    const cfg = badminton.configSchema.parse({ bestOf: 3, setTo: 21, finalSetTo: 21, cap: 21 });
    expect(one("badminton", badminton, cfg)).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 21 },
    });
  });

  it("an uncapped sport (cap null) says points only", () => {
    const volleyball = mod("volleyball");
    const cfg = volleyball.configSchema.parse({ bestOf: 1 }) as { finalSetTo: number; cap: unknown };
    expect(cfg.cap, "volleyball ships uncapped — the case this test is about").toBeNull();
    expect(one("volleyball", volleyball, cfg)).toEqual({
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
    expect(one("volleyball", volleyball, v)?.params?.points).toBe(v.finalSetTo);
    // Badminton with the two apart, capped above both: the cap reads against
    // the target the game is actually played to.
    const badminton = mod("badminton");
    const b = badminton.configSchema.parse({ bestOf: 1, setTo: 21, finalSetTo: 11, cap: 30 });
    expect(one("badminton", badminton, b)).toEqual({
      key: "format.rules.oneGamePointsCap",
      params: { points: 11, cap: 30 },
    });
  });

  it("a decider played to a DIFFERENT target is said: volleyball indoor reads '…, decider 15' — every number off the variant", () => {
    const volleyball = mod("volleyball");
    const cfg = variantCfg("volleyball", "indoor") as { bestOf: number; setTo: number; finalSetTo: number };
    expect(cfg.finalSetTo, "indoor's decider must differ from its sets").not.toBe(cfg.setTo);
    expect(one("volleyball", volleyball, cfg)).toEqual({
      key: "format.rules.bestOfPointsDecider",
      params: { n: cfg.bestOf, points: cfg.setTo, decider: cfg.finalSetTo },
    });
  });

  it("the decider clause rides after the cap clause, and is omitted when the decider plays to the same target", () => {
    const badminton = mod("badminton");
    const decider = badminton.configSchema.parse({ bestOf: 3, setTo: 21, finalSetTo: 15, cap: 30 });
    expect(one("badminton", badminton, decider)).toEqual({
      key: "format.rules.bestOfPointsCapDecider",
      params: { n: 3, points: 21, cap: 30, decider: 15 },
    });
    // bwf: the third game is to 21 like the first two — no clause.
    const bwf = variantCfg("badminton", "bwf") as { setTo: number; finalSetTo: number };
    expect(bwf.finalSetTo).toBe(bwf.setTo);
    expect(one("badminton", badminton, bwf)?.key).toBe("format.rules.bestOfPointsCap");
    // A missing or zero decider says nothing about itself.
    expect(one("badminton", permissive({ bestOf: 3, setTo: 21, finalSetTo: 0 }), {})).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 21 },
    });
  });

  it("the ONE-unit noun is the sport's own: game for badminton/table tennis, set for volleyball", () => {
    // Derived from the existing authority (`GAME_UNIT_SPORTS`), so the two
    // public surfaces that name the unit cannot disagree. Tennis says its set
    // with its games ("1 set, first to 6 games") — below.
    expect(SET_KERNEL_SPORTS.sort()).toEqual(["badminton", "tabletennis", "volleyball"]);
    for (const sportKey of SET_KERNEL_SPORTS) {
      const m = mod(sportKey);
      const line = one(sportKey, m, m.configSchema.parse({ bestOf: 1 }));
      const noun = GAME_UNIT_SPORTS.has(sportKey) ? "oneGame" : "oneSet";
      expect(line?.key.startsWith(`format.rules.${noun}`), `${sportKey} → ${line?.key}`).toBe(true);
    }
  });

  it("missing or non-positive fields say NOTHING about themselves — never 0, never invented", () => {
    expect(one("badminton", permissive({ bestOf: 3 }), {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(one("badminton", permissive({ bestOf: 1 }), {})).toEqual({
      key: "format.rules.oneGame",
    });
    expect(one("badminton", permissive({ bestOf: 3, setTo: 0, cap: 21 }), {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(one("badminton", permissive({ bestOf: 3, setTo: Number.NaN }), {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: 3 },
    });
    expect(one("badminton", permissive({ bestOf: 3, setTo: 11, cap: 0 }), {})).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 11 },
    });
    // A cap BELOW the target is a contradiction, not a clause.
    expect(one("badminton", permissive({ bestOf: 3, setTo: 11, cap: 9 }), {})).toEqual({
      key: "format.rules.bestOfPoints",
      params: { n: 3, points: 11 },
    });
    // No best-of at all: nothing honest to say.
    expect(one("badminton", permissive({ setTo: 11 }), {})).toBeNull();
    expect(one("badminton", permissive({ bestOf: 0, setTo: 11 }), {})).toBeNull();
    expect(one("badminton", permissive({ bestOf: "3" }), {})).toBeNull();
  });

  it("a refused config, a missing module, or a sport with no per-stage rules → null", () => {
    const badminton = mod("badminton");
    expect(one("badminton", badminton, { bestOf: 2 }), "bestOf must be odd").toBeNull();
    expect(one("badminton", null, SWISS_RULES)).toBeNull();
    // Carrom declares `bestOf` but is not a stage-rules sport, and its unit is
    // neither a game of points nor a set — the line stays with the preset.
    expect(STAGE_RULES_SPORTS.has("carrom")).toBe(false);
    expect(one("carrom", mod("carrom"), mod("carrom").configSchema.parse({}))).toBeNull();
    expect(one("football", mod("football"), mod("football").configSchema.parse({}))).toBeNull();
  });
});

describe("describeMatchRules — tennis says its set shape, deciding set, no-ad and tie-break margin (review round 2)", () => {
  // Every number is read off the tennis module's own variants, so the line a
  // spectator reads is the config's, never a table typed here. The four
  // shipped variants cover the four editor fields (`SPORT_RULES.tennis`).
  const tennis = mod("tennis");
  type TennisCfg = {
    bestOf: number;
    set: { gamesTo: number; tiebreakAt: number | null };
    finalSet: "same" | { matchTiebreakTo?: number; tiebreakTo?: number };
  };
  const cfg = (variant: string) => variantCfg("tennis", variant) as unknown as TennisCfg;

  it("Tour: best-of and games per set — nothing it does not have", () => {
    const tour = cfg("tour");
    expect(describeMatchRules("tennis", tennis, tour)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: tour.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: tour.set.gamesTo } },
    ]);
  });

  it("Fast4: sets to 4 and no-ad — the two things that make it Fast4, and never the word 'Tour'", () => {
    const fast4 = cfg("fast4");
    expect(fast4.set.gamesTo).not.toBe(cfg("tour").set.gamesTo);
    expect(describeMatchRules("tennis", tennis, fast4)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: fast4.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: fast4.set.gamesTo } },
      { key: "format.rules.tennis.noAd" },
    ]);
  });

  it("Doubles: a deciding MATCH tie-break, with its points, and no-ad", () => {
    const doubles = cfg("doubles-noad-mtb10");
    const finalSet = doubles.finalSet as { matchTiebreakTo: number };
    expect(describeMatchRules("tennis", tennis, doubles)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: doubles.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: doubles.set.gamesTo } },
      { key: "format.rules.tennis.matchTiebreak", params: { n: finalSet.matchTiebreakTo } },
      { key: "format.rules.tennis.noAd" },
    ]);
  });

  it("Grand slam: best of 5 with a final-set tie-break to its own target", () => {
    const slam = cfg("grand-slam");
    const finalSet = slam.finalSet as { tiebreakTo: number };
    expect(describeMatchRules("tennis", tennis, slam)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: slam.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: slam.set.gamesTo } },
      { key: "format.rules.tennis.finalSetTiebreak", params: { n: finalSet.tiebreakTo } },
    ]);
  });

  // Advantage sets (`tiebreakAt: null`) play NO tie-break — and the engine's
  // `rulesFor` (engine `sports/nested/kernel.ts`) keeps `tiebreakAt: null` in
  // the deciding set too, so a final-set tie-break target never comes into
  // play. The per-stage editor offers set type and deciding set as separate
  // selects, so an organiser can reach these combinations (review round 3).
  const advantageSet = { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 };
  const tiebreakSet = { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 };

  it("advantage sets are named, and win-by-two goes unsaid", () => {
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ set: advantageSet }))).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
      { key: "format.rules.tennis.advantageSetsTo", params: { games: 6 } },
    ]);
  });

  it("a final-set tie-break is stated only when sets HAVE tie-breaks — never over advantage sets, where none is played", () => {
    const finalSet = { tiebreakTo: 10 };
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ set: advantageSet, finalSet }))).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
      { key: "format.rules.tennis.advantageSetsTo", params: { games: 6 } },
    ]);
    // The positive pair: the same deciding set over tie-break sets is named.
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ set: tiebreakSet, finalSet }))).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
      { key: "format.rules.tennis.setsTo", params: { games: 6 } },
      { key: "format.rules.tennis.finalSetTiebreak", params: { n: 10 } },
    ]);
  });

  it("sudden-death tie-breaks are stated only when a tie-break is played: tie-break sets or a match tie-break", () => {
    const tiebreak = { winBy: 1 };
    // Tie-break sets — named.
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ set: tiebreakSet, tiebreak }))).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
      { key: "format.rules.tennis.setsTo", params: { games: 6 } },
      { key: "format.rules.tennis.suddenDeathTiebreaks" },
    ]);
    // Advantage sets, no match tie-break — no tie-break exists, so no clause.
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ set: advantageSet, tiebreak }))).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
      { key: "format.rules.tennis.advantageSetsTo", params: { games: 6 } },
    ]);
    // Advantage sets decided by a MATCH tie-break — that one tie-break is
    // played to the tie-break margin (the kernel's `tiebreak.winBy`), so named.
    expect(
      describeMatchRules(
        "tennis",
        tennis,
        tennis.configSchema.parse({ set: advantageSet, finalSet: { matchTiebreakTo: 10 }, tiebreak }),
      ),
    ).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: 3 } },
      { key: "format.rules.tennis.advantageSetsTo", params: { games: 6 } },
      { key: "format.rules.tennis.matchTiebreak", params: { n: 10 } },
      { key: "format.rules.tennis.suddenDeathTiebreaks" },
    ]);
  });

  it("a best-of-1 folds its set into the head; with a match tie-break as the decider it IS that tie-break", () => {
    expect(describeMatchRules("tennis", tennis, tennis.configSchema.parse({ bestOf: 1 }))).toEqual([
      { key: "format.rules.tennis.oneSetTo", params: { games: 6 } },
    ]);
    const adv = tennis.configSchema.parse({ bestOf: 1, set: { gamesTo: 8, winBy: 2, tiebreakAt: null, tiebreakTo: 7 } });
    expect(describeMatchRules("tennis", tennis, adv)).toEqual([
      { key: "format.rules.tennis.oneAdvantageSetTo", params: { games: 8 } },
    ]);
    // The nested kernel's deciding set is the one played at ⌈bestOf/2⌉−1 sets
    // all — for a best-of-1, the first — and a match tie-break REPLACES it.
    const mtb = tennis.configSchema.parse({ bestOf: 1, finalSet: { matchTiebreakTo: 10 } });
    expect(describeMatchRules("tennis", tennis, mtb)).toEqual([
      { key: "format.rules.tennis.oneMatchTiebreak", params: { n: 10 } },
    ]);
  });
});

describe("rulesDifferFromDivision — the RULE KEYS decide whether the preset name stays", () => {
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

describe("effectiveRulesLine — the preset name ONLY when the rule keys are equal; otherwise ALWAYS a line (review round 2)", () => {
  // Round 1 kept the preset whenever the describer's WORDS matched the
  // division's. That said "Tour" for a Fast4 stage while the describer could
  // not say games per set. The rule now: rule keys equal → the preset stays
  // (null); rule keys differ → a described line, never the preset. A
  // true-but-vague line beats a false name.
  const badminton = mod("badminton");
  const division = variantCfg("badminton", "short");
  const line = (sportKey: string, effective: unknown, div: unknown) =>
    effectiveRulesLine(sportKey, mod(sportKey), effective, div);
  const text = (l: RulesLineT | null) => (l === null ? null : rulesLineText(enPublic, l));

  it("the prod case: a Swiss stage at Bo1/15/21 over a short division names ITS rules — 15, not the preset's 11", () => {
    expect(line("badminton", { ...division, ...SWISS_RULES }, division)).toEqual([
      { key: "format.rules.oneGamePointsCap", params: { points: 15, cap: 21 } },
    ]);
    expect((division as { setTo: number }).setTo).not.toBe(15);
  });

  it("EMPTY FIRST: identical rules → null, so the caller keeps its preset name", () => {
    expect(line("badminton", division, division)).toBeNull();
    expect(line("tennis", variantCfg("tennis", "fast4"), variantCfg("tennis", "fast4"))).toBeNull();
  });

  it("restated-identical rules → the preset (a stage `rules: {bestOf: 3}` over bestOf 3; a tennis set restated in another key order)", () => {
    const division3 = badminton.configSchema.parse({ bestOf: 3 }) as Record<string, unknown>;
    expect(line("badminton", { ...division3, bestOf: 3 }, division3)).toBeNull();
    const tour = variantCfg("tennis", "tour") as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(tour.set as Record<string, unknown>).reverse());
    expect(line("tennis", { ...tour, set: reordered }, tour)).toBeNull();
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
    expect(line("badminton", { ...d, bestOf: 5 }, d)).toEqual([
      { key: "format.rules.bestOfPointsCap", params: { n: 5, points: d.setTo, cap: d.cap } },
    ]);
    // setTo and finalSetTo move TOGETHER for a best-of-3 (the decider keeps
    // up), inside the division's cap — only the points number changes.
    expect(line("badminton", { ...d, setTo: 13, finalSetTo: 13 }, d)).toEqual([
      { key: "format.rules.bestOfPointsCap", params: { n: d.bestOf, points: 13, cap: d.cap } },
    ]);
    expect(line("badminton", { ...d, cap: 17 }, d)).toEqual([
      { key: "format.rules.bestOfPointsCap", params: { n: d.bestOf, points: d.setTo, cap: 17 } },
    ]);
    // finalSetTo ALONE: the decider clause is what makes it sayable.
    expect(line("badminton", { ...d, finalSetTo: d.cap }, d)).toEqual([
      {
        key: "format.rules.bestOfPointsCapDecider",
        params: { n: d.bestOf, points: d.setTo, cap: d.cap, decider: d.cap },
      },
    ]);
  });

  it("volleyball: a stage that plays its decider to 25 like every other set names that — the division's line has a decider clause, the stage's has none", () => {
    const indoor = variantCfg("volleyball", "indoor") as { bestOf: number; setTo: number };
    expect(line("volleyball", { ...indoor, finalSetTo: indoor.setTo }, indoor)).toEqual([
      { key: "format.rules.bestOfPoints", params: { n: indoor.bestOf, points: indoor.setTo } },
    ]);
  });

  it("badminton `winBy` alone → a LINE (vague, since win-by has no words, but never the preset name)", () => {
    const d = division as { bestOf: number; setTo: number; cap: number; winBy: number };
    expect(configKeysFor("badminton").has("winBy"), "winBy is a rule key — the case this is about").toBe(true);
    expect(line("badminton", { ...division, winBy: d.winBy - 1 }, division)).toEqual([
      { key: "format.rules.bestOfPointsCap", params: { n: d.bestOf, points: d.setTo, cap: d.cap } },
    ]);
  });

  it("a Tour division with a Fast4 stage → a line that names Fast4's first to 4 games and no-ad scoring, never 'Tour'", () => {
    const tour = variantCfg("tennis", "tour");
    const fast4 = variantCfg("tennis", "fast4") as { bestOf: number; set: { gamesTo: number } };
    const l = line("tennis", fast4, tour);
    expect(l).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: fast4.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: fast4.set.gamesTo } },
      { key: "format.rules.tennis.noAd" },
    ]);
    expect(text(l)).toBe(`Best of ${fast4.bestOf} sets, first to ${fast4.set.gamesTo} games, no-ad scoring`);
    expect(text(l)).not.toMatch(/tour/i);
    // The set shape ALONE (games stay advantage) is named too.
    expect(line("tennis", { ...tour, set: fast4.set }, tour)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: fast4.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: fast4.set.gamesTo } },
    ]);
  });

  it("the spectator reads tennis in words (owner copy 2026-09-25): sets, games and no-ad SCORING — and no other sport's best-of grows a 'sets'", () => {
    // The owner's approved sentence, typed as the owner wrote it: "Best of 3,
    // sets to 4, no-ad" was accurate but unclear to a spectator.
    const fast4Stage = line("tennis", variantCfg("tennis", "fast4"), variantCfg("tennis", "tour"));
    expect(text(fast4Stage)).toBe("Best of 3 sets, first to 4 games, no-ad scoring");
    // The tennis head is tennis's OWN key: the shared `format.sets.bestOf`
    // ("Best of {n}") also heads the set kernel and the hub division's
    // `formatLine`, where "sets" would be wrong (badminton plays games).
    expect(enPublic["format.sets.bestOf"]).toBe("Best of {n}");
    for (const sportKey of SET_KERNEL_SPORTS) {
      const m = mod(sportKey);
      // The bare head (no target) and the sport's own defaults at best of 3.
      const bare = describeMatchRules(sportKey, permissive({ bestOf: 3 }), {});
      const full = describeMatchRules(sportKey, m, m.configSchema.parse({ bestOf: 3 }));
      expect(bare, sportKey).toEqual([{ key: "format.sets.bestOf", params: { n: 3 } }]);
      for (const l of [bare, full]) {
        const words = rulesLineText(enPublic, l ?? []);
        expect(words, `${sportKey}: "${words}"`).toMatch(/^Best of 3(,|$)/);
        expect(words, `${sportKey}: "${words}"`).not.toMatch(/\bsets?\b|\bgames?\b|scoring/);
      }
    }
  });

  it("the reverse: a Fast4 division with a Tour-shaped stage → sets to 6 and NO no-ad clause (advantage games)", () => {
    const tour = variantCfg("tennis", "tour") as { bestOf: number; set: { gamesTo: number } };
    const fast4 = variantCfg("tennis", "fast4");
    expect(line("tennis", tour, fast4)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: tour.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: tour.set.gamesTo } },
    ]);
  });

  it("a no-ad-only change is named; switching no-ad OFF under a no-ad division drops it (not null)", () => {
    const tour = variantCfg("tennis", "tour") as Record<string, unknown> & { bestOf: number; set: { gamesTo: number } };
    const game = tour.game as Record<string, unknown>;
    expect(game.noAd, "premise: tour plays advantage games").toBe(false);
    expect(line("tennis", { ...tour, game: { ...game, noAd: true } }, tour)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: tour.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: tour.set.gamesTo } },
      { key: "format.rules.tennis.noAd" },
    ]);
    const doubles = variantCfg("tennis", "doubles-noad-mtb10") as Record<string, unknown> & {
      bestOf: number;
      set: { gamesTo: number };
      finalSet: { matchTiebreakTo: number };
    };
    expect(line("tennis", { ...doubles, game: { ...(doubles.game as object), noAd: false } }, doubles)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: doubles.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: doubles.set.gamesTo } },
      { key: "format.rules.tennis.matchTiebreak", params: { n: doubles.finalSet.matchTiebreakTo } },
    ]);
  });

  it("a deciding-set-only change (grand slam's final-set tie-break on a Tour stage) is named", () => {
    const tour = variantCfg("tennis", "tour") as Record<string, unknown> & { bestOf: number; set: { gamesTo: number } };
    const grandSlam = variantCfg("tennis", "grand-slam") as { finalSet: { tiebreakTo: number } };
    expect(line("tennis", { ...tour, finalSet: grandSlam.finalSet }, tour)).toEqual([
      { key: "format.rules.tennis.bestOfSets", params: { n: tour.bestOf } },
      { key: "format.rules.tennis.setsTo", params: { games: tour.set.gamesTo } },
      { key: "format.rules.tennis.finalSetTiebreak", params: { n: grandSlam.finalSet.tiebreakTo } },
    ]);
  });

  it("no module, a refused config, or a sport with no per-stage rules → null (the preset stays; nothing invented)", () => {
    expect(effectiveRulesLine("badminton", null, { ...division, ...SWISS_RULES }, division)).toBeNull();
    expect(line("badminton", { ...division, bestOf: 2 }, division), "bestOf must be odd").toBeNull();
    expect(line("carrom", { bestOf: 1 }, { bestOf: 3 })).toBeNull();
  });
});

describe("every line the describer can PRODUCE is in all four public dictionaries, with exactly its params", () => {
  // A key is owed by what can emit it (hub-dictionary.test.ts's header), so the
  // set is DRIVEN out of the describer over every shape it branches on — the
  // set kernel's one unit per sport, with/without points, with/without a cap,
  // best-of 1 and 3; tennis's set shape, deciding set, no-ad and tie-break
  // margin — rather than listed by hand, where a new branch could not fail.
  const emitted = new Map<string, string[]>();
  const collect = (l: RulesLineT | null) => {
    for (const clause of l ?? []) emitted.set(clause.key, Object.keys(clause.params ?? {}).sort());
  };
  for (const sportKey of SET_KERNEL_SPORTS) {
    for (const bestOf of [1, 3]) {
      for (const extra of [
        {},
        { setTo: 11 },
        { setTo: 11, cap: 15 },
        { setTo: 11, finalSetTo: 15 },
        { setTo: 11, cap: 21, finalSetTo: 15 },
      ]) {
        collect(describeMatchRules(sportKey, permissive({ bestOf, ...extra }), {}));
      }
    }
  }
  const tennis = mod("tennis");
  for (const bestOf of [1, 3]) {
    for (const tiebreakAt of [6, null]) {
      for (const finalSet of ["same", { matchTiebreakTo: 10 }, { tiebreakTo: 10 }]) {
        for (const noAd of [false, true]) {
          for (const winBy of [1, 2]) {
            collect(
              describeMatchRules(
                "tennis",
                tennis,
                tennis.configSchema.parse({
                  bestOf,
                  set: { gamesTo: 6, winBy: 2, tiebreakAt, tiebreakTo: 7 },
                  finalSet,
                  game: { noAd },
                  tiebreak: { winBy },
                }),
              ),
            );
          }
        }
      }
    }
  }
  const dicts = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as Record<string, Record<string, string>>;
  const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

  it("the drive reaches every shape — eleven set-kernel keys, ten tennis clause keys (so the loop below is not vacuous)", () => {
    expect([...emitted.keys()].filter((k) => !k.startsWith("format.rules.tennis.")).length).toBe(11);
    expect([...emitted.keys()].filter((k) => k.startsWith("format.rules.tennis.")).sort()).toEqual([
      "format.rules.tennis.advantageSetsTo",
      "format.rules.tennis.bestOfSets",
      "format.rules.tennis.finalSetTiebreak",
      "format.rules.tennis.matchTiebreak",
      "format.rules.tennis.noAd",
      "format.rules.tennis.oneAdvantageSetTo",
      "format.rules.tennis.oneMatchTiebreak",
      "format.rules.tennis.oneSetTo",
      "format.rules.tennis.setsTo",
      "format.rules.tennis.suddenDeathTiebreaks",
    ]);
  });

  for (const [locale, dict] of Object.entries(dicts)) {
    it(`${locale}: each emitted key exists and interpolates exactly the params passed`, () => {
      for (const [key, params] of emitted) {
        expect(Object.hasOwn(dict, key), `${locale} ${key}`).toBe(true);
        expect(placeholders(dict[key]!), `${locale} ${key}`).toEqual(params);
        // The match header joins its facts with " · " (`match-centre.ts`), so
        // a clause that used it too would read as several separate facts
        // ("1 game · 15 points · Court 2"). Clauses join with commas.
        expect(dict[key], `${locale} ${key} must not use the header's joiner`).not.toContain("·");
      }
    });
  }
});
