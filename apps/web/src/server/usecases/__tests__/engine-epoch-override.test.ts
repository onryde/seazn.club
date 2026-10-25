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
const sentryMock = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn(), flush: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => ({ captureRequestError: () => {}, init: () => {}, ...sentryMock }));
vi.mock("../../../../sentry.server.config", () => ({}));
vi.mock("../../../../sentry.edge.config", () => ({}));
// The other boot checks register() runs are not the subject here; their own tests drive them.
vi.mock("@/server/relay/config", () => ({ relayDriverMode: vi.fn() }));
vi.mock("@/server/public-site/error-no-store", () => ({ installPublicErrorNoStore: vi.fn() }));

import { FOLD_EPOCH, foldEpochOf } from "@seazn/engine/sport";
import { relayDriverMode } from "@/server/relay/config";
import { installPublicErrorNoStore } from "@/server/public-site/error-no-store";
import {
  ENGINE_EPOCH_FLOOR_OVERRIDE_ENV,
  epochFloorOverride,
  epochFloorOverrideActiveMessage,
  epochFloorOverrideOrOff,
  epochFloorOverrideSentryLevel,
  judgeEngineEpoch,
  majorsBehind,
  parseEpochFloorOverride,
  reportEpochFloorOverrides,
} from "../engine-epoch-override";

const SPORTS = Object.keys(FOLD_EPOCH);

beforeEach(() => {
  for (const m of [logMock.error, logMock.warn, logMock.info, logMock.debug, sentryMock.captureMessage, sentryMock.captureException, sentryMock.flush, vi.mocked(installPublicErrorNoStore)]) m.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

/** The `log.error` calls that report a value that is not understood. */
const invalidReports = () => logMock.error.mock.calls.filter(([f]) => (f as { code?: unknown } | undefined)?.code === "ENGINE_EPOCH_FLOOR_OVERRIDE_INVALID");

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
  // Each KIND of failure says so in words, so a wrong branch (a missing `=` reported as an unknown sport) cannot hide behind a
  // message that happens to contain the token.
  const UNKNOWN = "unknown sport";
  const NOT_INT = "is not an integer >= 1";
  const DUP = "duplicate sport";
  const EMPTY = "empty pair";
  const NO_EQ = 'no "="';
  // [what, raw value, the token the message must name, the kind of failure it must say]. A typo must never become "no override",
  // nor a wrong floor.
  const BAD: [string, string, string, string][] = [
    // unknown sport (an own-key check: Object.prototype names are NOT sports)
    ["unknown sport", "footbal=2", "footbal", UNKNOWN],
    ["unknown sport, second pair", `${A}=2,quidditch=1`, "quidditch", UNKNOWN],
    ["case matters", "Football=2", "Football", UNKNOWN],
    ["empty sport name", "=2", "=2", UNKNOWN],
    ["constructor is not a sport", "constructor=1", "constructor", UNKNOWN],
    ["toString is not a sport", "toString=1", "toString", UNKNOWN],
    ["__proto__ is not a sport", "__proto__=1", "__proto__", UNKNOWN],
    ["hasOwnProperty is not a sport", "hasOwnProperty=1", "hasOwnProperty", UNKNOWN],
    // the epoch is an integer >= 1
    ["zero", `${A}=0`, "0", NOT_INT],
    ["negative", `${A}=-1`, "-1", NOT_INT],
    ["fraction", `${A}=1.5`, "1.5", NOT_INT],
    ["whole number written as a decimal", `${A}=2.0`, "2.0", NOT_INT],
    ["words", `${A}=abc`, "abc", NOT_INT],
    ["exponent", `${A}=1e1`, "1e1", NOT_INT],
    ["hex", `${A}=0x2`, "0x2", NOT_INT],
    ["explicit plus", `${A}=+2`, "+2", NOT_INT],
    ["two numbers", `${A}=2 3`, "2 3", NOT_INT],
    ["a second =", `${A}=2=3`, "2=3", NOT_INT],
    ["leading zero", `${A}=02`, "02", NOT_INT],
    ["Infinity", `${A}=Infinity`, "Infinity", NOT_INT],
    ["NaN", `${A}=NaN`, "NaN", NOT_INT],
    ["beyond the safe integers", `${A}=9007199254740993`, "9007199254740993", NOT_INT],
    ["nothing after =", `${A}=`, `${A}=`, NOT_INT],
    ["the second pair's epoch", `${A}=2,${B}=x`, "x", NOT_INT],
    // duplicates
    ["same sport twice", `${A}=2,${A}=1`, A, DUP],
    ["same sport twice, same value, spaced", `${A}=2 , ${A} = 2`, A, DUP],
    // empty pairs
    ["trailing comma", `${A}=2,`, "empty", EMPTY],
    ["leading comma", `,${A}=2`, "empty", EMPTY],
    ["double comma", `${A}=2,,${B}=1`, "empty", EMPTY],
    ["only a comma", ",", "empty", EMPTY],
    ["comma and spaces", " , ", "empty", EMPTY],
    // missing =
    ["no =", A, A, NO_EQ],
    ["no =, second pair", `${A}=2,${B}`, B, NO_EQ],
  ];

  it("each case throws an Error whose message names the variable, the bad token and the KIND of failure", () => {
    let checked = 0;
    for (const [what, raw, token, kind] of BAD) {
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
      expect(message, `${what}: says ${JSON.stringify(kind)}`).toContain(kind);
      checked++;
    }
    expect(checked, "every bad value was thrown on").toBe(BAD.length);
    expect(checked).toBeGreaterThan(25);
    expect(new Set(BAD.map((b) => b[3])).size, "all five kinds of failure are represented").toBe(5);
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

describe("epochFloorOverrideOrOff — the accessor the GATE reads: a value that is not understood is OFF, reported once", () => {
  const invalid = invalidReports;
  const [A] = SPORTS as [string];

  it("unset, blank and a good value behave exactly like the strict accessor, and report nothing", () => {
    expect(epochFloorOverrideOrOff({}).size).toBe(0);
    expect(epochFloorOverrideOrOff({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "  " }).size).toBe(0);
    const env = { [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=1` };
    expect(epochFloorOverrideOrOff(env)).toBe(epochFloorOverride(env));
    expect(invalid()).toHaveLength(0);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it("a malformed value answers an EMPTY map (every sport keeps its declared floor), never an exception", () => {
    let checked = 0;
    for (const raw of [`footbal=2`, `${A}=0`, `${A}=2,${A}=1`, `${A}=2,`, A, "constructor=1"]) {
      const m = epochFloorOverrideOrOff({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${raw}#off-${checked}` });
      expect(m, raw).toBeInstanceOf(Map);
      expect(m.size, raw).toBe(0);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("is reported ONCE per distinct bad value: one log.error and one Sentry ERROR, naming the variable and the pair and saying the lever is OFF", () => {
    const env = { [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "once-footbal=2" };
    for (let i = 0; i < 4; i++) expect(epochFloorOverrideOrOff(env).size).toBe(0);
    expect(invalid(), "four reads, one report").toHaveLength(1);
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    const [message, level] = sentryMock.captureMessage.mock.calls[0]! as [string, string];
    expect(level).toBe("error");
    expect(message).toContain(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV);
    expect(message).toContain("once-footbal");
    expect(message).toMatch(/OFF/);
    expect(invalid()[0]![1], "the log line and the alert say the same").toBe(message);

    // A different bad value is a new report; the first one coming back is not.
    epochFloorOverrideOrOff({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "twice-footbal=2" });
    expect(invalid()).toHaveLength(2);
    epochFloorOverrideOrOff(env);
    expect(invalid(), "a value already reported is not reported again").toHaveLength(2);
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(2);
  });

  it("the STRICT accessor still throws for the same value (boot's contract is unchanged), and reports nothing itself", () => {
    const env = { [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "strict-footbal=2" };
    expect(() => epochFloorOverride(env)).toThrow(/strict-footbal/);
    expect(invalid()).toHaveLength(0);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
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
      expect(r, sport).toEqual({ active: [{ sport, floor: 2, declared: 3 }], inert: [] });
      const calls = leverWarnings();
      expect(calls, `${sport}: exactly one warning`).toHaveLength(1);
      expect(calls[0]![0], sport).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport, floor: 2, declared: 3, majorsBehind: 1 });
      expect(calls[0]![1], `${sport}: the log line is the message Sentry gets`).toBe(epochFloorOverrideActiveMessage({ sport, floor: 2, declared: 3 }));
      expect(calls[0]![1], `${sport}: and it says how many majors behind`).toContain("majorsBehind=1");
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
        expect(r, `${sport}=${v}`).toEqual({ active: [], inert: [{ sport, floor: v, declared: 3 }] });
        const calls = leverWarnings();
        expect(calls, `${sport}=${v}: exactly one warning`).toHaveLength(1);
        expect(calls[0]![0], `${sport}=${v}`).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_INERT", sport, floor: v, declared: 3 });
        expect(calls[0]![1]).toMatch(/no effect/i);
        checked++;
      }
    }
    expect(checked).toBe(SPORTS.length * 3);
  });

  it("two sports: one warning EACH, in the order given, one active and one inert", () => {
    const [A, B] = SPORTS as [string, string];
    const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=1,${B}=3` }, AT_THREE);
    expect(r).toEqual({ active: [{ sport: A, floor: 1, declared: 3 }], inert: [{ sport: B, floor: 3, declared: 3 }] });
    expect(leverWarnings().map(([f]) => [f.code, f.sport])).toEqual([
      ["ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", A],
      ["ENGINE_EPOCH_FLOOR_OVERRIDE_INERT", B],
    ]);
  });

  it("junk THROWS from the strict report (register() catches it, see below) and logs nothing: no partial report of a value that is not understood", () => {
    const [A] = SPORTS as [string];
    expect(() => reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${A}=2,quidditch=1` }, AT_THREE)).toThrow(/quidditch/);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("against the REAL table: a floor one below each sport's own epoch is ACTIVE with `declared` = the engine's declaration and majorsBehind 1", () => {
    const movable = SPORTS.filter((s) => FOLD_EPOCH[s as keyof typeof FOLD_EPOCH] > 1);
    expect(movable.length, "premise: at least one sport has moved off epoch 1, so a lower floor exists").toBeGreaterThan(0);
    let checked = 0;
    for (const sport of movable) {
      logMock.warn.mockClear();
      const own = foldEpochOf(sport);
      const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=${own - 1}` });
      expect(r, sport).toEqual({ active: [{ sport, floor: own - 1, declared: own }], inert: [] });
      expect(leverWarnings()[0]![0], sport).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport, floor: own - 1, declared: own, majorsBehind: 1 });
      checked++;
    }
    expect(checked).toBe(movable.length);
  });

  it("against the REAL table: a floor TWO majors below the sport's own epoch is ACTIVE with majorsBehind 2 (a forgotten entry across a later bump)", () => {
    const far = SPORTS.filter((s) => FOLD_EPOCH[s as keyof typeof FOLD_EPOCH] >= 3);
    expect(far.length, "premise: a sport has moved two majors, so a floor two below it exists").toBeGreaterThan(0);
    let checked = 0;
    for (const sport of far) {
      logMock.warn.mockClear();
      const own = foldEpochOf(sport);
      const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=${own - 2}` });
      expect(r, sport).toEqual({ active: [{ sport, floor: own - 2, declared: own }], inert: [] });
      expect(leverWarnings()[0]![0], sport).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport, floor: own - 2, declared: own, majorsBehind: 2 });
      expect(leverWarnings()[0]![1], sport).toContain("majorsBehind=2");
      checked++;
    }
    expect(checked).toBe(far.length);
  });

  it("majorsBehind and the Sentry level: one major is a warning, more than one is an error (a table of the rule, not of the code)", () => {
    // [declared, floor, majors, level]
    const table: [number, number, number, "warning" | "error"][] = [
      [2, 1, 1, "warning"],
      [3, 2, 1, "warning"],
      [3, 1, 2, "error"],
      [5, 4, 1, "warning"],
      [5, 3, 2, "error"],
      [5, 1, 4, "error"],
    ];
    let checked = 0;
    for (const [declared, floor, majors, level] of table) {
      const e = { sport: SPORTS[0]!, floor, declared };
      expect(majorsBehind(e), `${declared}/${floor}`).toBe(majors);
      expect(epochFloorOverrideSentryLevel(e), `${declared}/${floor}`).toBe(level);
      checked++;
    }
    expect(checked).toBe(table.length);
  });

  it("against the REAL table: a floor equal to each sport's own epoch is INERT (a stale override after a later bump must not crash prod)", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      logMock.warn.mockClear();
      const own = foldEpochOf(sport);
      const r = reportEpochFloorOverrides({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: `${sport}=${own}` });
      expect(r, sport).toEqual({ active: [], inert: [{ sport, floor: own, declared: own }] });
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

  it("nodejs, a junk value: register() RESOLVES and the lever stays OFF - ONE error line names the variable and the token, nothing is logged as active, no alert is raised as an ACTIVE message", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, "footbal=2");
    await expect(boot()).resolves.toBeUndefined();
    const reports = invalidReports();
    expect(reports, "exactly one error line").toHaveLength(1);
    expect(reports[0]![1]).toMatch(new RegExp(`${ENGINE_EPOCH_FLOOR_OVERRIDE_ENV}.*footbal`));
    expect(reports[0]![1], "and says what it did about it").toMatch(/OFF/);
    expect(leverWarnings(), "nothing is logged as active for a value that was not understood").toHaveLength(0);
    expect(sentryMock.captureMessage, "it alerts as an exception, not as an ACTIVE warning").not.toHaveBeenCalled();
  });

  it("nodejs, a junk value: the parse error goes to Sentry as ONE exception and is FLUSHED, then boot CARRIES ON (the later boot steps still run)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, "footbal=2");
    const order: string[] = [];
    sentryMock.captureException.mockImplementationOnce(() => void order.push("captureException"));
    sentryMock.flush.mockImplementationOnce(async () => {
      order.push("flush");
      return true;
    });
    await expect(boot()).resolves.toBeUndefined();
    expect(order, "captured, then flushed").toEqual(["captureException", "flush"]);
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect((sentryMock.captureException.mock.calls[0]![0] as Error).message).toContain(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV);
    expect(sentryMock.flush).toHaveBeenCalledWith(2000);
    expect(vi.mocked(installPublicErrorNoStore), "the boot step AFTER the lever's check still ran").toHaveBeenCalledTimes(1);
  });

  it("nodejs, a junk value is ONE report for the process: the gate's first read of the same value stays quiet; a different bad value still reports", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, "once-boot-footbal=2");
    await boot();
    expect(invalidReports()).toHaveLength(1);
    expect(epochFloorOverrideOrOff({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "once-boot-footbal=2" }).size, "OFF at the gate").toBe(0);
    expect(invalidReports(), "boot already said it").toHaveLength(1);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    epochFloorOverrideOrOff({ [ENGINE_EPOCH_FLOOR_OVERRIDE_ENV]: "once-gate-footbal=2" });
    expect(invalidReports(), "a different value is a new report").toHaveLength(2);
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("nodejs: relayDriverMode()'s own refusal still REJECTS register() (the relay check is untouched), before the lever reports anything", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${MOVED}=${foldEpochOf(MOVED!) - 1}`);
    vi.mocked(relayDriverMode).mockImplementationOnce(() => {
      throw new Error("relay: a faking deployment is refused");
    });
    await expect(boot()).rejects.toThrow(/relay: a faking deployment is refused/);
    expect(leverWarnings(), "boot died at the relay check, before the lever's report").toHaveLength(0);
    // The positive pair: the same environment with the relay check satisfied boots and reports.
    await expect(boot()).resolves.toBeUndefined();
    expect(leverWarnings()).toHaveLength(1);
  });

  it("nodejs, a valid value: boots, and logs ONE ACTIVE warning for the sport", async () => {
    const own = foldEpochOf(MOVED!);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${MOVED}=${own - 1}`);
    await expect(boot()).resolves.toBeUndefined();
    const calls = leverWarnings();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport: MOVED, floor: own - 1, declared: own, majorsBehind: 1 });
    // The same sentence goes to Sentry as a WARNING, once per ACTIVE sport (a pino line alone never becomes an Issue).
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(epochFloorOverrideActiveMessage({ sport: MOVED!, floor: own - 1, declared: own }), "warning");
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });

  it("nodejs, ONE major behind alerts Sentry as a WARNING; TWO majors behind alerts as an ERROR (the pino line is a warning either way)", async () => {
    const one = MOVED!;
    const two = SPORTS.find((s) => FOLD_EPOCH[s as keyof typeof FOLD_EPOCH] >= 3);
    expect(two, "premise: a sport has moved two majors").toBeDefined();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    // One major behind: the lever doing its job after a bump.
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${one}=${foldEpochOf(one) - 1}`);
    await boot();
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    const [m1, l1] = sentryMock.captureMessage.mock.calls[0]! as [string, string];
    expect(l1).toBe("warning");
    expect(m1).toContain("majorsBehind=1");
    // Two majors behind: a forgotten entry that widened across a later bump.
    sentryMock.captureMessage.mockClear();
    logMock.warn.mockClear();
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${two}=${foldEpochOf(two!) - 2}`);
    await boot();
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    const [m2, l2] = sentryMock.captureMessage.mock.calls[0]! as [string, string];
    expect(l2).toBe("error");
    expect(m2).toContain("majorsBehind=2");
    const lines = leverWarnings();
    expect(lines, "the pino line is still a warning").toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({ code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE", sport: two, majorsBehind: 2 });
    expect(logMock.error.mock.calls.filter(([f]) => (f as { code?: unknown } | undefined)?.code === "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE"), "never logged at error").toHaveLength(0);
  });

  it("nodejs, two sports both lowered: one Sentry warning EACH; one lowered and one inert: only the lowered one alerts", async () => {
    const moved = SPORTS.filter((s) => FOLD_EPOCH[s as keyof typeof FOLD_EPOCH] > 1);
    expect(moved.length, "premise: two sports have moved off epoch 1").toBeGreaterThanOrEqual(2);
    const [a, b] = moved as [string, string];
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${a}=${foldEpochOf(a) - 1},${b}=${foldEpochOf(b) - 1}`);
    await boot();
    expect(sentryMock.captureMessage.mock.calls.map(([m, level]) => [String(m).includes(`${a} scoring`) ? a : String(m).includes(`${b} scoring`) ? b : "?", level])).toEqual([
      [a, "warning"],
      [b, "warning"],
    ]);
    sentryMock.captureMessage.mockClear();
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${a}=${foldEpochOf(a) - 1},${b}=${foldEpochOf(b)}`);
    await boot();
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("nodejs, an inert value (equal to the sport's epoch): boots and logs INERT, not ACTIVE", async () => {
    const own = foldEpochOf(MOVED!);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, `${MOVED}=${own}`);
    await expect(boot()).resolves.toBeUndefined();
    expect(leverWarnings().map(([f]) => f.code)).toEqual(["ENGINE_EPOCH_FLOOR_OVERRIDE_INERT"]);
    expect(sentryMock.captureMessage, "an inert entry is log-only: nobody needs paging for a stale line").not.toHaveBeenCalled();
  });

  it("nodejs, unset or blank: boots and logs nothing from this lever", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    for (const v of [undefined, "", "  "]) {
      vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, v);
      await expect(boot()).resolves.toBeUndefined();
    }
    expect(leverWarnings()).toHaveLength(0);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });

  it("register() on the EDGE runtime does not look at the lever at all - the check is nodejs-only (positive pair: the same junk is reported on nodejs)", async () => {
    vi.stubEnv(ENGINE_EPOCH_FLOOR_OVERRIDE_ENV, "edge-footbal=2");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(boot()).resolves.toBeUndefined();
    expect(invalidReports(), "edge reports nothing").toHaveLength(0);
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(boot()).resolves.toBeUndefined();
    expect(invalidReports(), "nodejs reports it").toHaveLength(1);
  });
});
