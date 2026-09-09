// Spectator surface W2, Task 4 — the division format sentence.
//
// Every expectation here is either (a) a value the module's OWN configSchema
// is handed explicitly in the test, so the arithmetic is the assertion, or
// (b) DERIVED from the module's declared defaults, so a change to the source
// of truth moves the test with it instead of leaving it asserting yesterday's
// numbers (_RULES class 19). No table of sport constants is typed in.
//
// The minutes sentence is SPORT-NEUTRAL (`format.minutes`, owner ruling
// 2026-09-09): football, hockey and ice hockey all say the same thing about
// how long a match runs, and a football-named key printed over a hockey match
// is the defect `SHOOTOUT_IS_SKATED` exists to undo.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveLatestModule } from "@/server/engine-db";
import { describeFormat } from "../describe-format";

const mod = (sportKey: string) => resolveLatestModule(sportKey);

/** A module whose config parse is the identity — the ONLY way to reach a
 *  config this file's guards refuse, because every shipped schema either
 *  defaults the field or refuses a non-positive value. Used to pin RULES
 *  ("never 0 minutes", "a missing field says nothing") rather than to describe
 *  data that exists today. */
const permissive = (data: Record<string, unknown>): AnySportModule =>
  ({ configSchema: { safeParse: () => ({ success: true, data }) } }) as unknown as AnySportModule;

// Which sports this module claims to describe, and which it deliberately does
// not. Split out so the drift guard below can prove the two partition the
// engine's ACTUAL shipped list — a twelfth sport must land in one of them.
const OVERS = ["cricket"];
const MINUTES = ["football", "hockey", "icehockey"];
const BEST_OF = ["tennis", "badminton", "tabletennis", "volleyball", "carrom"];
const SILENT = ["generic", "boardgame"];

describe("describeFormat — the sport list is the engine's, not a copy", () => {
  it("every shipped module is classified exactly once", () => {
    // N3: without this, a twelfth sport arrives unwitnessed and silently falls
    // into the `bestOf` default branch.
    const classified = [...OVERS, ...MINUTES, ...BEST_OF, ...SILENT];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(builtinModules.map((m) => m.key).sort());
  });
});

describe("describeFormat — cricket", () => {
  it("overs = ballsPerInnings / ballsPerOver from the PARSED cfg (48/6 = 8)", () => {
    const cricket = mod("cricket");
    const cfg = cricket.configSchema.parse({ ballsPerInnings: 48, playersPerSide: 8 });
    expect(describeFormat("cricket", cricket, cfg)).toEqual({
      key: "format.cricket.overs",
      params: { overs: 8 },
    });
  });

  it("the module's own DEFAULTS describe themselves — derived, never typed", () => {
    const cricket = mod("cricket");
    const cfg = cricket.configSchema.parse({}) as { ballsPerInnings: number; ballsPerOver: number };
    // The expected value comes from the module's declaration, so raising the
    // default innings length moves this assertion rather than reddening it.
    expect(describeFormat("cricket", cricket, {})).toEqual({
      key: "format.cricket.overs",
      params: { overs: cfg.ballsPerInnings / cfg.ballsPerOver },
    });
  });

  it("a non-six over length is honoured (the Hundred's 5-ball over: 100/5 = 20)", () => {
    // The answer DIFFERS from the default's, so the test can witness a
    // hardcoded `/ 6` regression.
    const cricket = mod("cricket");
    const cfg = cricket.configSchema.parse({ ballsPerInnings: 100, ballsPerOver: 5 });
    expect(describeFormat("cricket", cricket, cfg)).toEqual({
      key: "format.cricket.overs",
      params: { overs: 20 },
    });
  });

  it("a TIMELESS innings (ballsPerInnings null) has no over count → null", () => {
    const cricket = mod("cricket");
    const cfg = cricket.configSchema.parse({ ballsPerInnings: null });
    expect(describeFormat("cricket", cricket, cfg)).toBeNull();
  });

  it("a ball count that is not a whole number of overs → null, never '8.5 overs'", () => {
    const cricket = mod("cricket");
    const cfg = cricket.configSchema.parse({ ballsPerInnings: 50, ballsPerOver: 6 });
    expect(describeFormat("cricket", cricket, cfg)).toBeNull();
  });
});

describe("describeFormat — the sport-neutral minutes sentence", () => {
  it("football: minutes = halfMinutes × halves, from the module's own period config", () => {
    const football = mod("football");
    const cfg = football.configSchema.parse({}) as { halfMinutes: number; halves: number };
    expect(describeFormat("football", football, {})).toEqual({
      key: "format.minutes",
      params: { minutes: cfg.halfMinutes * cfg.halves },
    });
  });

  it("football: mini-soccer's FOUR quarters are counted, not assumed to be two halves", () => {
    // 10 × 4 = 40. A `halfMinutes * 2` implementation answers 20 here and 90
    // for the default, so this row is what separates the two.
    const football = mod("football");
    const cfg = football.configSchema.parse({ halfMinutes: 10, halves: 4 });
    expect(describeFormat("football", football, cfg)).toEqual({
      key: "format.minutes",
      params: { minutes: 40 },
    });
  });

  it.each(["hockey", "icehockey"])(
    "%s: minutes = periods.count × periods.minutes, derived from the module",
    (sportKey) => {
      const module_ = mod(sportKey);
      const cfg = module_.configSchema.parse({}) as { periods: { count: number; minutes: number } };
      expect(describeFormat(sportKey, module_, {})).toEqual({
        key: "format.minutes",
        params: { minutes: cfg.periods.count * cfg.periods.minutes },
      });
    },
  );

  it("hockey counts the PERIODS, not one of them", () => {
    // FIH is 4×15 and IIHF is 3×20, so the two sports disagree on both factors
    // — an implementation that returned `periods.minutes` alone answers 15 and
    // 20 where the right answers are 60 and 60.
    const fih = mod("hockey");
    const iihf = mod("icehockey");
    const a = fih.configSchema.parse({}) as { periods: { count: number; minutes: number } };
    const b = iihf.configSchema.parse({}) as { periods: { count: number; minutes: number } };
    expect(a.periods.minutes).not.toBe(b.periods.minutes);
    expect(describeFormat("hockey", fih, {})).toEqual(describeFormat("icehockey", iihf, {}));
  });

  it("the three sports share ONE key — no football-named sentence over a hockey match", () => {
    const keys = MINUTES.map((s) => describeFormat(s, mod(s), {})?.key);
    expect(new Set(keys)).toEqual(new Set(["format.minutes"]));
    expect(keys).not.toContain("format.football.minutes");
  });
});

describe("describeFormat — a total it cannot state is NULL, never zero", () => {
  // `Number("")` is 0 in this codebase and a chip reading "0 min" is a
  // confident lie — worse than the blank chip that ships when there is nothing
  // to say. No shipped module can produce 0 (football's `halfMinutes` is
  // `positive()`, the period kernel's `count` is `min(1)`), so these use a
  // permissive module double: the rule is about what may EVER reach a
  // spectator, not about data that exists today.
  it.each([
    ["football, halfMinutes MISSING", "football", {}],
    ["football, halves MISSING", "football", { halfMinutes: 45 }],
    ["football, a zero half", "football", { halfMinutes: 0, halves: 2 }],
    ["football, zero halves", "football", { halfMinutes: 45, halves: 0 }],
    ["football, a non-numeric half", "football", { halfMinutes: "", halves: 2 }],
    // NaN and Infinity are both `typeof "number"` and both clear a bare
    // `<= 0` check, so they are the two values a range guard alone lets
    // through — as `{minutes: NaN}` and `{minutes: Infinity}` on the chip.
    ["football, a NaN half", "football", { halfMinutes: Number.NaN, halves: 2 }],
    ["football, an infinite half", "football", { halfMinutes: Number.POSITIVE_INFINITY, halves: 2 }],
    ["football, a negative half", "football", { halfMinutes: -45, halves: 2 }],
    ["hockey, periods MISSING", "hockey", {}],
    ["hockey, count MISSING", "hockey", { periods: { minutes: 15 } }],
    ["hockey, minutes MISSING", "icehockey", { periods: { count: 3 } }],
    ["hockey, a zero count", "hockey", { periods: { count: 0, minutes: 15 } }],
    ["hockey, periods is not an object", "hockey", { periods: 60 }],
  ])("%s → null", (_label, sportKey, cfg) => {
    expect(describeFormat(sportKey, permissive(cfg as Record<string, unknown>), {})).toBeNull();
  });

  it("a real division pinned to a module that never declared the field says nothing", () => {
    // The production shape of the case above: `describeFormat` is handed the
    // division's PINNED module, and an older build's schema may not carry
    // `halfMinutes` at all. Parsed through a schema that does not declare it,
    // the field is absent — and absent must read as "no answer", not as zero.
    expect(describeFormat("football", mod("generic"), { halfMinutes: 45, halves: 2 })).toBeNull();
  });
});

describe("describeFormat — set-based sports", () => {
  it("tennis reports best-of from its cfg, not from its default", () => {
    const tennis = mod("tennis");
    const cfg = tennis.configSchema.parse({ bestOf: 5 });
    expect(describeFormat("tennis", tennis, cfg)).toEqual({
      key: "format.sets.bestOf",
      params: { n: 5 },
    });
  });

  it.each(BEST_OF)("%s describes its declared default best-of", (sportKey) => {
    const module_ = mod(sportKey);
    const cfg = module_.configSchema.parse({}) as { bestOf: number };
    expect(describeFormat(sportKey, module_, {})).toEqual({
      key: "format.sets.bestOf",
      params: { n: cfg.bestOf },
    });
  });
});

describe("describeFormat — the sports with nothing to say", () => {
  it.each(SILENT)(
    "%s has no describable format → null (the renderer falls back to variantKey)",
    (sportKey) => {
      expect(describeFormat(sportKey, mod(sportKey), {})).toBeNull();
    },
  );
});

describe("describeFormat — never throws", () => {
  it.each([
    ["null cfg", null],
    ["a string", "T20"],
    ["a number", 20],
    ["an array", []],
    ["a cfg the schema refuses", { ballsPerOver: -1 }],
  ])("garbage cfg (%s) → null", (_label, cfg) => {
    expect(describeFormat("cricket", mod("cricket"), cfg)).toBeNull();
  });

  it("no module resolved (an unregistered sport) → null", () => {
    expect(describeFormat("cricket", null, { ballsPerInnings: 48 })).toBeNull();
  });
});
