// W2e Task 8c (owner D19; rule row CK-BO-2) - the overs field counts in the over length of the config it edits, not in sixes.
//
// The Hundred ships as a selectable variant (`hundred`: a 100-ball innings of FIVE-ball overs). The field used to write
// `ballsPerInnings = overs x 6` and to read a count only when `balls % 6 === 0`: on a Hundred division, "20 overs" saved 120
// balls (24 overs of five) and a stored 100 balls reopened blank (100 % 6 is 4).
//
// Every expected value here is the ENGINE's own declaration (`cricket.variants`, `configSchema`), never a number typed in
// from the web file under test. Each sweep reports how many items it judged, and judging none fails it.
//
// Single-sport on purpose: overs and a ball-count per over exist only in cricket. The field is also driven through its real
// producers (the three editors) in `components/v2/__tests__/cricket-overs-editors.test.ts`.
import { describe, expect, it } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { CRICKET_RULES } from "../cricket.ts";
import { SPORT_RULES, buildRuleOverride, hydrateRuleValues, ruleContextFor } from "../index.ts";

type Cfg = { ballsPerInnings: number | null; ballsPerOver: number };
const OVERS = CRICKET_RULES.find((f) => f.key === "overs")!;
const parsedVariant = (variant: string): Cfg => cricket.configSchema.parse(cricket.variants[variant]) as Cfg;
const RAW = cricket.variants as Record<string, Record<string, unknown>>;
/** The engine's own default over length: what a config that names none counts in. */
const ENGINE_BALLS_PER_OVER = (cricket.configSchema.parse({}) as Cfg).ballsPerOver;
/** The variants with a limited innings: the ones an "overs" count means something for. */
const LIMITED = Object.keys(cricket.variants).filter((v) => parsedVariant(v).ballsPerInnings !== null);

describe("CK-BO-2 the overs field counts in the config's own over length", () => {
  it("CK-BO-2 premises: the engine declares a variant with a different over length, and a limited innings of whole overs", () => {
    expect(LIMITED.length, "limited-innings variants").toBeGreaterThanOrEqual(3);
    const lengths = new Set(LIMITED.map((v) => parsedVariant(v).ballsPerOver));
    expect(lengths.size, "the variants disagree on the over length (else a hard-coded six could pass)").toBeGreaterThan(1);
    expect(lengths.has(ENGINE_BALLS_PER_OVER)).toBe(true);
    for (const v of LIMITED) {
      const { ballsPerInnings, ballsPerOver } = parsedVariant(v);
      expect(ballsPerInnings! % ballsPerOver, `${v}: an innings of whole overs`).toBe(0);
    }
  });

  it("CK-BO-2 every limited variant: its parsed config reads as balls / ballsPerOver overs, and that many overs builds the balls back", () => {
    let judged = 0;
    for (const v of LIMITED) {
      const cfg = parsedVariant(v);
      const overs = String(cfg.ballsPerInnings! / cfg.ballsPerOver);
      expect(OVERS.read!(cfg as unknown as Record<string, unknown>), `${v}: read`).toBe(overs);
      // The stored division config carries its over length (the server stores `{...variant, ...overrides}`).
      expect(OVERS.build(overs, {}, cfg as unknown as Record<string, unknown>), `${v}: build over the parsed config`).toEqual({ ballsPerInnings: cfg.ballsPerInnings });
      // The builder knows only the variant's preset, which names an over length only where it differs from the engine's.
      expect(OVERS.build(overs, {}, RAW[v]!), `${v}: build over the raw preset`).toEqual({ ballsPerInnings: cfg.ballsPerInnings });
      judged++;
    }
    expect(judged, "variants judged").toBe(LIMITED.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("CK-BO-2 The Hundred: 20 overs is 100 balls, 100 balls reads back 20, and the six-ball answers (120 / blank) are the wrong ones", () => {
    const hundred = parsedVariant("hundred");
    expect(hundred.ballsPerOver, "premise: five-ball overs").not.toBe(ENGINE_BALLS_PER_OVER);
    expect(OVERS.build("20", {}, hundred as unknown as Record<string, unknown>)).toEqual({ ballsPerInnings: hundred.ballsPerInnings });
    expect(OVERS.build("20", {}, hundred as unknown as Record<string, unknown>)).not.toEqual({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER });
    expect(OVERS.read!({ ballsPerInnings: hundred.ballsPerInnings, ballsPerOver: hundred.ballsPerOver })).toBe("20");
    // the same 20 overs on a six-ball variant is a different number of balls
    const t20 = parsedVariant("t20");
    expect(t20.ballsPerInnings, "premise: 20 overs of six is not 100 balls").not.toBe(hundred.ballsPerInnings);
    expect(OVERS.build("20", {}, t20 as unknown as Record<string, unknown>)).toEqual({ ballsPerInnings: t20.ballsPerInnings });
  });

  it("CK-BO-2 with no context at all the field counts in the engine's default over length (the pre-existing behaviour)", () => {
    expect(OVERS.build("20", {})).toEqual({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER });
    expect(OVERS.read!({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER })).toBe("20");
    expect(OVERS.build("20", {}, {})).toEqual({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER });
  });

  it("CK-BO-2 whole overs only: balls that are not a whole number of overs read blank, at every over length the engine declares", () => {
    let judged = 0;
    for (const bpo of new Set(LIMITED.map((v) => parsedVariant(v).ballsPerOver))) {
      expect(OVERS.read!({ ballsPerInnings: bpo * 4 + 1, ballsPerOver: bpo }), `${bpo}-ball overs, ${bpo * 4 + 1} balls`).toBeUndefined();
      expect(OVERS.read!({ ballsPerInnings: bpo * 4, ballsPerOver: bpo }), `${bpo}-ball overs, ${bpo * 4} balls`).toBe("4");
      judged++;
    }
    expect(judged).toBeGreaterThan(1);
    // 100 balls is no whole number of six-ball overs
    expect(OVERS.read!({ ballsPerInnings: 100 })).toBeUndefined();
  });

  it("CK-BO-2 the config's own over length beats the one it falls back to; a junk own value falls through to it, and a junk fallback to the default", () => {
    const hundred = parsedVariant("hundred");
    // own wins
    expect(OVERS.read!({ ballsPerInnings: hundred.ballsPerInnings, ballsPerOver: hundred.ballsPerOver }, { ballsPerOver: ENGINE_BALLS_PER_OVER })).toBe("20");
    let junk = 0;
    for (const bad of [0, -5, 2.5, "5", null, undefined, NaN]) {
      // a junk own value reads the fallback (the Hundred's)
      expect(OVERS.read!({ ballsPerInnings: 100, ballsPerOver: bad }, { ballsPerOver: hundred.ballsPerOver }), `own ${String(bad)}`).toBe("20");
      // a junk fallback reads the engine default
      expect(OVERS.read!({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER }, { ballsPerOver: bad }), `fallback ${String(bad)}`).toBe("20");
      expect(OVERS.build("20", {}, { ballsPerOver: bad }), `build, fallback ${String(bad)}`).toEqual({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER });
      junk++;
    }
    expect(junk).toBe(7);
  });

  it("CK-BO-2 a stage's fragment reads only what it carries: the over length comes from the division, but an absent innings stays blank", () => {
    const hundred = parsedVariant("hundred") as unknown as Record<string, unknown>;
    // 60 balls in a Hundred stage is 12 overs of five; read in sixes it would be 10.
    expect(OVERS.read!({ ballsPerInnings: 60 }, hundred)).toBe("12");
    expect(OVERS.read!({ ballsPerInnings: 60 })).toBe("10");
    // the division's own innings is NOT borrowed for a fragment that names none (a defaulting read pins the division format)
    expect(OVERS.read!({}, hundred)).toBeUndefined();
    expect(OVERS.read!({ ballsPerInnings: null }, hundred)).toBeUndefined();
  });

  it("CK-BO-2 round trip at every over length: read(build(n)) is n, and build(read(cfg)) is the cfg's innings", () => {
    let judged = 0;
    for (const v of LIMITED) {
      const cfg = parsedVariant(v) as unknown as Record<string, unknown>;
      for (const n of ["1", "7", "100"]) {
        const built = OVERS.build(n, {}, cfg);
        expect(OVERS.read!({ ...built }, cfg), `${v} ${n}`).toBe(n);
        judged++;
      }
      expect(OVERS.build(OVERS.read!(cfg)!, {}, cfg), `${v}: the stored innings round-trips`).toEqual({ ballsPerInnings: parsedVariant(v).ballsPerInnings });
    }
    expect(judged).toBe(LIMITED.length * 3);
  });
});

describe("CK-BO-2 the registry entry points hand the field its context", () => {
  it("CK-BO-2 buildRuleOverride and hydrateRuleValues pass `inherited` to the field (the producers' own door)", () => {
    const hundred = parsedVariant("hundred") as unknown as Record<string, unknown>;
    expect(buildRuleOverride("cricket", { overs: "20" }, hundred)).toEqual({ ballsPerInnings: parsedVariant("hundred").ballsPerInnings });
    expect(buildRuleOverride("cricket", { overs: "20" })).toEqual({ ballsPerInnings: 20 * ENGINE_BALLS_PER_OVER });
    // a stage fragment: the over length comes from the division it falls back to
    expect(hydrateRuleValues("cricket", { ballsPerInnings: 60 }, hundred)).toEqual({ overs: "12" });
    expect(hydrateRuleValues("cricket", { ballsPerInnings: 60 })).toEqual({ overs: "10" });
    // the division's own saved config carries its over length
    expect(hydrateRuleValues("cricket", hundred).overs).toBe("20");
  });

  it("CK-BO-2 ruleContextFor hands over exactly the keys a field declares it converts by, and nothing a placeholder or best-of reads", () => {
    const hundred = RAW.hundred!;
    expect(hundred.ballsPerOver, "premise: the Hundred's preset names its over length").toBe(parsedVariant("hundred").ballsPerOver);
    expect(ruleContextFor("cricket", hundred)).toEqual({ ballsPerOver: hundred.ballsPerOver });
    // a preset that names none contributes nothing: the field falls to the engine default
    expect(ruleContextFor("cricket", RAW.t20!)).toEqual({});
    // nothing else of the preset crosses (a best-of or a field key would change what the builder shows)
    expect(ruleContextFor("cricket", { ...hundred, bestOf: 1, overs: 9, ballsPerInnings: 100 })).toEqual({ ballsPerOver: hundred.ballsPerOver });
    expect(ruleContextFor("cricket", undefined)).toEqual({});
  });

  it("CK-BO-2 every declared context key is a real cfg key of its sport, and no other sport asks for one (swept over the registry)", () => {
    const sports = Object.keys(SPORT_RULES);
    expect(sports.length, "sports swept").toBeGreaterThan(5);
    let declaring = 0;
    for (const sport of sports) {
      for (const field of SPORT_RULES[sport]!) {
        if (field.context === undefined) continue;
        declaring++;
        expect(sport, `${sport}.${field.key} declares a context key`).toBe("cricket");
        for (const key of field.context) expect(Object.keys(cricket.configSchema.parse({})), `${field.key}: ${key}`).toContain(key);
      }
    }
    expect(declaring, "fields declaring a context").toBe(1);
    for (const sport of sports.filter((s) => s !== "cricket")) expect(ruleContextFor(sport, { ballsPerOver: 5 }), sport).toEqual({});
  });
});
