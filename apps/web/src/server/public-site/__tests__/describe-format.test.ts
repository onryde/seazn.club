// Spectator surface W2, Task 4 — the division format sentence.
//
// Every expectation here is either (a) a value the module's OWN configSchema
// is handed explicitly in the test, so the arithmetic is the assertion, or
// (b) DERIVED from the module's declared defaults, so a change to the source
// of truth moves the test with it instead of leaving it asserting yesterday's
// numbers (_RULES class 19). No table of sport constants is typed in.
import { describe, expect, it } from "vitest";
import { resolveLatestModule } from "@/server/engine-db";
import { describeFormat } from "../describe-format";

const mod = (sportKey: string) => resolveLatestModule(sportKey);

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

describe("describeFormat — football", () => {
  it("minutes = halfMinutes × halves, from the module's own period config", () => {
    const football = mod("football");
    const cfg = football.configSchema.parse({}) as { halfMinutes: number; halves: number };
    expect(describeFormat("football", football, {})).toEqual({
      key: "format.football.minutes",
      params: { minutes: cfg.halfMinutes * cfg.halves },
    });
  });

  it("mini-soccer's FOUR quarters are counted, not assumed to be two halves", () => {
    // 10 × 4 = 40. A `halfMinutes * 2` implementation answers 20 here and 90
    // for the default, so this row is what separates the two.
    const football = mod("football");
    const cfg = football.configSchema.parse({ halfMinutes: 10, halves: 4 });
    expect(describeFormat("football", football, cfg)).toEqual({
      key: "format.football.minutes",
      params: { minutes: 40 },
    });
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

  it.each(["badminton", "tabletennis", "volleyball", "carrom"])(
    "%s describes its declared default best-of",
    (sportKey) => {
      const module_ = mod(sportKey);
      const cfg = module_.configSchema.parse({}) as { bestOf: number };
      expect(describeFormat(sportKey, module_, {})).toEqual({
        key: "format.sets.bestOf",
        params: { n: cfg.bestOf },
      });
    },
  );
});

describe("describeFormat — the sports with nothing to say", () => {
  it.each(["generic", "boardgame", "hockey", "icehockey"])(
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
