// The per-sport engine-epoch FLOOR OVERRIDE (engine-split spec §5.6, review 1f lens 3; owner ruling 2026-10-15): a default-off
// emergency lever that lets the server admit writes from clients one or more epochs BEHIND a sport's `FOLD_EPOCH`, without a Fly
// rollback, until they have updated. `ENGINE_EPOCH_FLOOR_OVERRIDE=football=2,hockey=1`.
//
// What is proved here, and what is not:
//  - the parser, the verdict function, the cached accessor and the boot report, all without a database. Every sport-shaped
//    expectation is swept over the engine's own `FOLD_EPOCH` keys (the declaration), and every sweep reports how many items it
//    checked: zero is a failure;
//  - `register()` in instrumentation.ts, driven for real, so a report that nothing calls is caught (the inert-seam class);
//  - the GATE itself (`assertEngineEpoch` in scoring.ts) is driven through `scoreEvent` in scoring-engine-epoch.test.ts, which has
//    the database and the `foldEpochOf` bump.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const sentryMock = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureRequestError: () => {}, init: () => {}, ...sentryMock }));
vi.mock("../../../../sentry.server.config", () => ({}));
vi.mock("../../../../sentry.edge.config", () => ({}));
// The other boot checks register() runs are not the subject here; their own tests drive them.
vi.mock("@/server/relay/config", () => ({ relayDriverMode: vi.fn() }));
vi.mock("@/server/public-site/error-no-store", () => ({ installPublicErrorNoStore: vi.fn() }));

import { FOLD_EPOCH, foldEpochOf } from "@seazn/engine/sport";
import {
  ENGINE_EPOCH_FLOOR_OVERRIDE_ENV,
  epochFloorOverride,
  judgeEngineEpoch,
  parseEpochFloorOverride,
  reportEpochFloorOverrides,
} from "../engine-epoch-override";

const SPORTS = Object.keys(FOLD_EPOCH);

beforeEach(() => {
  for (const m of [logMock.error, logMock.warn, logMock.info, logMock.debug, sentryMock.captureMessage, sentryMock.captureException]) m.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

/** The `log.warn` calls that carry one of this lever's codes: [fields, message]. */
const leverWarnings = () =>
  logMock.warn.mock.calls.filter(([f]) => typeof (f as { code?: unknown })?.code === "string" && (f as { code: string }).code.startsWith("ENGINE_EPOCH_FLOOR_OVERRIDE")) as [
    Record<string, unknown>,
    string,
  ][];

describe("premises", () => {
  it("the engine declares sports, the variable has its documented name, and the table is not empty", () => {
    expect(SPORTS.length).toBeGreaterThan(0);
    expect(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV).toBe("ENGINE_EPOCH_FLOOR_OVERRIDE");
  });
});

describe("parseEpochFloorOverride — OFF (the empty case, stated first)", () => {
  it("undefined, empty and whitespace-only are off: an empty map, so nothing is lowered", () => {
    let checked = 0;
    for (const raw of [undefined, "", " ", "   ", "\t", "\n", " \t\n "]) {
      const m = parseEpochFloorOverride(raw);
      expect(m, JSON.stringify(raw)).toBeInstanceOf(Map);
      expect(m.size, JSON.stringify(raw)).toBe(0);
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("parseEpochFloorOverride — accepted shapes", () => {
  const [A, B] = SPORTS as [string, string];

  it("one pair, two pairs, and whitespace around any token", () => {
    expect([...parseEpochFloorOverride(`${A}=2`)]).toEqual([[A, 2]]);
    expect([...parseEpochFloorOverride(`${A}=2,${B}=1`)]).toEqual([[A, 2], [B, 1]]);
    expect([...parseEpochFloorOverride(`  ${A} = 2 ,\t${B}\t=\n1  `)]).toEqual([[A, 2], [B, 1]]);
    // A multi-digit epoch is read as a number, not as its first digit.
    expect(parseEpochFloorOverride(`${A}=12`).get(A)).toBe(12);
  });

  it("every sport in FOLD_EPOCH is accepted as `<sport>=1` (swept; a sport the engine declares is never 'unknown')", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const m = parseEpochFloorOverride(`${sport}=1`);
      expect([...m], sport).toEqual([[sport, 1]]);
      checked++;
    }
    expect(checked, "every FOLD_EPOCH key was visited").toBe(SPORTS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("all sports together, one value each, round-trip into a map of the same size", () => {
    const raw = SPORTS.map((s, i) => `${s}=${i + 1}`).join(",");
    const m = parseEpochFloorOverride(raw);
    expect(m.size).toBe(SPORTS.length);
    expect([...m]).toEqual(SPORTS.map((s, i) => [s, i + 1]));
  });

  it("the parser does not judge a value against the table: at, above and below the sport's own epoch all parse (inertness is the boot report's call)", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const own = FOLD_EPOCH[sport as keyof typeof FOLD_EPOCH];
      for (const v of [1, own, own + 1, own + 100]) {
        expect(parseEpochFloorOverride(`${sport}=${v}`).get(sport), `${sport}=${v}`).toBe(v);
        checked++;
      }
    }
    expect(checked).toBe(SPORTS.length * 4);
  });
});

describe("parseEpochFloorOverride — FAILS CLOSED: every malformed value throws, naming the bad token", () => {
  const [A, B] = SPORTS as [string, string];
  // [raw value, the token the message must name]. A typo must never become "no override", nor a wrong floor.
  const BAD: [string, string, string][] = [
    // unknown sport (an own-key check: Object.prototype names are NOT sports)
    ["unknown sport", "footbal=2", "footbal"],
    ["unknown sport, second pair", `${A}=2,quidditch=1`, "quidditch"],
    ["case matters", "Football=2", "Football"],
    ["empty sport name", "=2", "=2"],
    ["constructor is not a sport", "constructor=1", "constructor"],
    ["toString is not a sport", "toString=1", "toString"],
    ["__proto__ is not a sport", "__proto__=1", "__proto__"],
    ["hasOwnProperty is not a sport", "hasOwnProperty=1", "hasOwnProperty"],
    // the epoch is an integer >= 1
    ["zero", `${A}=0`, "0"],
    ["negative", `${A}=-1`, "-1"],
    ["fraction", `${A}=1.5`, "1.5"],
    ["whole number written as a decimal", `${A}=2.0`, "2.0"],
    ["words", `${A}=abc`, "abc"],
    ["exponent", `${A}=1e1`, "1e1"],
    ["hex", `${A}=0x2`, "0x2"],
    ["explicit plus", `${A}=+2`, "+2"],
    ["two numbers", `${A}=2 3`, "2 3"],
    ["a second =", `${A}=2=3`, "2=3"],
    ["leading zero", `${A}=02`, "02"],
    ["Infinity", `${A}=Infinity`, "Infinity"],
    ["NaN", `${A}=NaN`, "NaN"],
    ["beyond the safe integers", `${A}=9007199254740993`, "9007199254740993"],
    ["nothing after =", `${A}=`, `${A}=`],
    ["the second pair's epoch", `${A}=2,${B}=x`, "x"],
    // duplicates
    ["same sport twice", `${A}=2,${A}=1`, A],
    ["same sport twice, same value, spaced", `${A}=2 , ${A} = 2`, A],
    // empty pairs
    ["trailing comma", `${A}=2,`, "empty"],
    ["leading comma", `,${A}=2`, "empty"],
    ["double comma", `${A}=2,,${B}=1`, "empty"],
    ["only a comma", ",", "empty"],
    ["comma and spaces", " , ", "empty"],
    // missing =
    ["no =", A, A],
    ["no =, second pair", `${A}=2,${B}`, B],
  ];

  it("each case throws an Error whose message names the variable and the bad token", () => {
    let checked = 0;
    for (const [what, raw, token] of BAD) {
      let thrown: unknown;
      try {
        parseEpochFloorOverride(raw);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${what}: ${JSON.stringify(raw)} must throw`).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message, `${what}: names the variable`).toContain(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV);
      expect(message, `${what}: names ${JSON.stringify(token)}`).toContain(token);
      checked++;
    }
    expect(checked, "every bad value was thrown on").toBe(BAD.length);
    expect(checked).toBeGreaterThan(25);
  });

  it("each KIND of failure reads differently to the person on call", () => {
    const msg = (raw: string) => {
      try {
        parseEpochFloorOverride(raw);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`${raw} did not throw`);
    };
    const kinds = [msg("footbal=2"), msg(`${A}=0`), msg(`${A}=2,${A}=1`), msg(`${A}=2,`), msg(A)];
    expect(new Set(kinds).size, "unknown sport / bad epoch / duplicate / empty pair / missing = are five different messages").toBe(5);
    expect(kinds[0], "the unknown-sport message lists what IS known").toContain(A);
  });

  it("a second call after a throw still throws (no half-built state is kept), and a good value after it still parses", () => {
    expect(() => parseEpochFloorOverride(`${A}=2,${B}=x`)).toThrow();
    expect(() => parseEpochFloorOverride(`${A}=2,${B}=x`)).toThrow();
    expect([...parseEpochFloorOverride(`${A}=2`)]).toEqual([[A, 2]]);
  });
});

describe("judgeEngineEpoch — the verdict, over (client epoch × server epoch × override)", () => {
  // The rule as the owner stated it: the override can only LOWER the floor. A write is admitted when the client is at or above
  // the sport's epoch, OR at or above the override. It is "via the override" exactly when only the second holds. Written as an
  // either/or here, where the code states it as a `min`, so the two are independent formulations of one rule.
  it("admitted <=> got >= declared || got >= override; viaOverride <=> admitted only by the override; the floor never rises", () => {
    let checked = 0;
    for (const declared of [1, 2, 3, 5]) {
      for (const override of [undefined, 1, 2, 3, 5, 9]) {
        for (let got = 1; got <= 7; got++) {
          const v = judgeEngineEpoch(got, declared, override);
          const byOverride = override !== undefined && got >= override;
          const admitted = got >= declared || byOverride;
          const label = `got=${got} declared=${declared} override=${override}`;
          expect(v.admitted, label).toBe(admitted);
          expect(v.viaOverride, label).toBe(got < declared && byOverride);
          expect(v.declared, label).toBe(declared);
          expect(v.floor, label).toBe(override !== undefined && override < declared ? override : declared);
          expect(v.floor, `${label}: never above the sport's own epoch`).toBeLessThanOrEqual(declared);
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 6 * 7);
  });

  it("the case that tells `min` from the override itself: override ABOVE the sport's epoch must not raise the floor", () => {
    const v = judgeEngineEpoch(2, 2, 9);
    expect(v).toEqual({ declared: 2, floor: 2, admitted: true, viaOverride: false });
    const w = judgeEngineEpoch(1, 2, 9);
    expect(w).toEqual({ declared: 2, floor: 2, admitted: false, viaOverride: false });
  });
});

describe("epochFloorOverride — the cached accessor the gate reads", () => {
  it("unset and blank are an empty map", () => {
    expect(epochFloorOverride({}).size).toBe(0);
    expect(epochFloorOverride({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "" }).size).toBe(0);
    expect(epochFloorOverride({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "  " }).size).toBe(0);
  });

  it("reads process.env by default, so a test (or an operator) injects the value with the environment", () => {
    const [A] = SPORTS as [string];
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${A}=1`);
    expect([...epochFloorOverride()]).toEqual([[A, 1]]);
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, undefined);
    expect(epochFloorOverride().size, "after the value is removed the lever is off again").toBe(0);
  });

  it("parses ONCE per value: repeated reads hand back the same map instance, not a re-parse per request", () => {
    const [A] = SPORTS as [string];
    const env = { [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=1` };
    const first = epochFloorOverride(env);
    expect(epochFloorOverride(env)).toBe(first);
    expect(epochFloorOverride({ ...env })).toBe(first);
    const other = epochFloorOverride({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=2` });
    expect(other).not.toBe(first);
    expect(other.get(A)).toBe(2);
    expect(epochFloorOverride(env).get(A), "going back to the first value is still the first value").toBe(1);
  });

  it("a malformed value throws on EVERY read: a failure is never cached as 'no override'", () => {
    const env = { [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "footbal=2" };
    expect(() => epochFloorOverride(env)).toThrow(/footbal/);
    expect(() => epochFloorOverride(env)).toThrow(/footbal/);
    expect(epochFloorOverride({}).size, "a good read after the failures is unaffected").toBe(0);
  });
});

describe("reportEpochFloorOverrides — the boot report", () => {
  // A table in which every sport sits at 3, so "below", "at" and "above" are all reachable for every sport (the real table has
  // sports at 1, where nothing can be below). The real table is exercised in its own test.
  const AT_THREE = () => 3;

  it("unset, blank and whitespace log NOTHING and report nothing (zero behaviour change)", () => {
    for (const raw of [undefined, "", "   "]) {
      const r = reportEpochFloorOverrides(raw === undefined ? {} : { [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: raw }, AT_THREE);
      expect(r).toEqual({ active: [], inert: [] });
    }
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.info).not.toHaveBeenCalled();
  });

  it("every sport: a floor BELOW its epoch logs one ACTIVE warning naming the sport, the floor and the epoch it replaces", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      logMock.warn.mockClear();
      const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=2` }, AT_THREE);
      expect(r, sport).toEqual({ active: [sport], inert: [] });
      const calls = leverWarnings();
      expect(calls, `${sport}: exactly one warning`).toHaveLength(1);
      expect(calls[0]![0], sport).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport, floor: 2, required: 3 });
      expect(calls[0]![1], `${sport}: loud, and says what it does`).toMatch(/ACTIVE|lowered/i);
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every sport: a floor AT or ABOVE its epoch is INERT - logged as having no effect, never thrown, never ACTIVE", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      for (const v of [3, 4, 99]) {
        logMock.warn.mockClear();
        const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=${v}` }, AT_THREE);
        expect(r, `${sport}=${v}`).toEqual({ active: [], inert: [sport] });
        const calls = leverWarnings();
        expect(calls, `${sport}=${v}: exactly one warning`).toHaveLength(1);
        expect(calls[0]![0], `${sport}=${v}`).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_INERT", sport, floor: v, required: 3 });
        expect(calls[0]![1]).toMatch(/no effect/i);
        checked++;
      }
    }
    expect(checked).toBe(SPORTS.length * 3);
  });

  it("two sports: one warning EACH, in the order given, one active and one inert", () => {
    const [A, B] = SPORTS as [string, string];
    const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=1,${B}=3` }, AT_THREE);
    expect(r).toEqual({ active: [A], inert: [B] });
    expect(leverWarnings().map(([f]) => [f.code, f.sport])).toEqual([
      ["ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", A],
      ["ENGINE_EPOCH_FLOOR_OVERRIDE_INERT", B],
    ]);
  });

  it("junk THROWS (fail closed) and logs nothing: no partial report of a value that is not understood", () => {
    const [A] = SPORTS as [string];
    expect(() => reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=2,quidditch=1` }, AT_THREE)).toThrow(/quidditch/);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("against the REAL table: a floor one below each sport's own epoch is ACTIVE with `required` = the engine's declaration", () => {
    const movable = SPORTS.filter((s) => FOLD_EPOCH[s as keyof typeof FOLD_EPOCH] > 1);
    expect(movable.length, "premise: at least one sport has moved off epoch 1, so a lower floor exists").toBeGreaterThan(0);
    let checked = 0;
    for (const sport of movable) {
      logMock.warn.mockClear();
      const own = foldEpochOf(sport);
      const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=${own - 1}` });
      expect(r, sport).toEqual({ active: [sport], inert: [] });
      expect(leverWarnings()[0]![0], sport).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport, floor: own - 1, required: own });
      checked++;
    }
    expect(checked).toBe(movable.length);
  });

  it("against the REAL table: a floor equal to each sport's own epoch is INERT (a stale override after a later bump must not crash prod)", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      logMock.warn.mockClear();
      const own = foldEpochOf(sport);
      const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=${own}` });
      expect(r, sport).toEqual({ active: [], inert: [sport] });
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
  });
});

describe("register() (instrumentation.ts) applies the lever at boot", () => {
  async function boot() {
    const { register } = await import("../../../../instrumentation");
    return register();
  }
  // A sport that has moved past epoch 1 (so a floor below it exists), and its engine-declared epoch.
  const MOVED = SPORTS.find((s) => FOLD_EPOCH[s as keyof typeof FOLD_EPOCH] > 1);

  it("premise: the real table has a moved sport to point the override at", () => {
    expect(MOVED).toBeDefined();
  });

  it("nodejs, a junk value: register() REJECTS, naming the variable and the token (the process must not boot on a typo)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, "footbal=2");
    await expect(boot()).rejects.toThrow(new RegExp(`${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV}.*footbal|footbal.*${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV}`));
    expect(leverWarnings(), "nothing is logged as active for a value that was refused").toHaveLength(0);
  });

  it("nodejs, a valid value: boots, and logs ONE ACTIVE warning for the sport", async () => {
    const own = foldEpochOf(MOVED!);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${MOVED}=${own - 1}`);
    await expect(boot()).resolves.toBeUndefined();
    const calls = leverWarnings();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport: MOVED, floor: own - 1, required: own });
  });

  it("nodejs, an inert value (equal to the sport's epoch): boots and logs INERT, not ACTIVE", async () => {
    const own = foldEpochOf(MOVED!);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${MOVED}=${own}`);
    await expect(boot()).resolves.toBeUndefined();
    expect(leverWarnings().map(([f]) => f.code)).toEqual(["ENGINE_EPOCH_FLOOR_OVERRIDE_INERT"]);
  });

  it("nodejs, unset or blank: boots and logs nothing from this lever", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    for (const v of [undefined, "", "  "]) {
      vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, v);
      await expect(boot()).resolves.toBeUndefined();
    }
    expect(leverWarnings()).toHaveLength(0);
  });

  it("the edge runtime serves no scoring route and does not parse the value (positive pair: the same junk rejects on nodejs)", async () => {
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, "footbal=2");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(boot()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(boot()).rejects.toThrow(/footbal/);
  });
});
