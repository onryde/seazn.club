// Da: the build sha is PARSED out of Fly's image ref, never trusted whole. Pure.
// And the money guard: a process that was never told RELAY_DRIVERS=live runs the fake drivers.
import { afterEach, describe, expect, it } from "vitest";
import { FLY_RELAY_APP_RETIRED_DEFAULT, LOCAL_ENV_NAME, buildShaOf, liveRunnerIdentity, relayDriverMode, relayEnvironment } from "../config";

describe("buildShaOf (Da)", () => {
  it("a 40-hex tag → the sha; a deployment-… tag → null; unset → null", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildShaOf(`registry.fly.io/seazn-club:${sha}`)).toBe(sha);
    expect(buildShaOf("registry.fly.io/seazn-club:deployment-01HZX5Y8K2M3N4P5Q6R7S8T9V0")).toBeNull();
    expect(buildShaOf(undefined)).toBeNull();
  });
});

describe("relayDriverMode — unset is fake (a process not told it may spend money does not)", () => {
  // Restored after every case: removed when it was originally unset (never assigned `undefined`, which Node stores as
  // the string "undefined" — and "undefined" is exactly a value this function must refuse).
  const saved = process.env.RELAY_DRIVERS;
  afterEach(() => {
    if (saved === undefined) delete process.env.RELAY_DRIVERS;
    else process.env.RELAY_DRIVERS = saved;
  });

  it("unset → fake, and empty → fake (the money guard)", () => {
    delete process.env.RELAY_DRIVERS;
    expect(relayDriverMode()).toBe("fake");
    process.env.RELAY_DRIVERS = "";
    expect(relayDriverMode()).toBe("fake");
  });

  it("the explicit values are themselves: fake → fake, live → live", () => {
    process.env.RELAY_DRIVERS = "fake";
    expect(relayDriverMode()).toBe("fake");
    process.env.RELAY_DRIVERS = "live";
    expect(relayDriverMode()).toBe("live");
  });

  it("anything else throws rather than guessing a mode — LIVE, true, 1, the string \"undefined\"", () => {
    for (const value of ["LIVE", "true", "1", "undefined"]) {
      process.env.RELAY_DRIVERS = value;
      expect(() => relayDriverMode(), value).toThrow(/RELAY_DRIVERS must be "fake" or "live"/);
    }
  });
});

// I1 (Task 12 fix round 1, owner decision 2026-09-28): the deploy environment's identity is ENV_NAME ("stg" | "prod",
// a Fly secret per deployment). It is the daily sweep's ONLY licence to destroy a listed runner, so a live process that
// cannot name its environment must refuse rather than guess; a fake process needs neither variable.
describe("relayEnvironment — ENV_NAME, required in live mode, a named local default in fake mode", () => {
  it("fake (unset or explicit) without ENV_NAME → the local default; with it → the value; live with it → the value", () => {
    let checked = 0;
    for (const drivers of [undefined, "", "fake"]) {
      expect(relayEnvironment({ RELAY_DRIVERS: drivers }), `RELAY_DRIVERS=${drivers}`).toBe(LOCAL_ENV_NAME);
      expect(relayEnvironment({ RELAY_DRIVERS: drivers, ENV_NAME: "stg" })).toBe("stg");
      checked++;
    }
    expect(relayEnvironment({ RELAY_DRIVERS: "live", ENV_NAME: "prod" })).toBe("prod");
    expect(checked).toBe(3);
  });

  it("live without ENV_NAME — unset, empty, or blank — REFUSES by name; it never falls back to the local default", () => {
    let checked = 0;
    for (const ENV_NAME of [undefined, "", "   "]) {
      expect(() => relayEnvironment({ RELAY_DRIVERS: "live", ENV_NAME }), JSON.stringify(ENV_NAME)).toThrow(/ENV_NAME is not set/);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the default reads process.env", () => {
    const saved = { d: process.env.RELAY_DRIVERS, e: process.env.ENV_NAME };
    try {
      process.env.RELAY_DRIVERS = "fake";
      process.env.ENV_NAME = "stg";
      expect(relayEnvironment()).toBe("stg");
    } finally {
      if (saved.d === undefined) delete process.env.RELAY_DRIVERS; else process.env.RELAY_DRIVERS = saved.d;
      if (saved.e === undefined) delete process.env.ENV_NAME; else process.env.ENV_NAME = saved.e;
    }
  });
});

describe("liveRunnerIdentity — a live runner needs its OWN app and its environment (I1(b))", () => {
  it("refuses an unset FLY_RELAY_APP, the retired shared default, and an unset ENV_NAME — each by name", () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ ENV_NAME: "stg" }, /FLY_RELAY_APP is not set/],
      [{ ENV_NAME: "stg", FLY_RELAY_APP: "  " }, /FLY_RELAY_APP is not set/],
      [{ ENV_NAME: "stg", FLY_RELAY_APP: FLY_RELAY_APP_RETIRED_DEFAULT }, /retired shared default/],
      [{ FLY_RELAY_APP: "seazn-relay-stg" }, /ENV_NAME is not set/],
      [{ FLY_RELAY_APP: "seazn-relay-stg", ENV_NAME: "" }, /ENV_NAME is not set/],
    ];
    let checked = 0;
    for (const [env, message] of cases) {
      expect(() => liveRunnerIdentity(env), JSON.stringify(env)).toThrow(message);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(FLY_RELAY_APP_RETIRED_DEFAULT).toBe("seazn-relay");   // the app every deployment used to share (runner-fly.ts's old default)
  });

  it("both set → the pair, whatever RELAY_DRIVERS says (a runner that builds its own client is live by definition)", () => {
    expect(liveRunnerIdentity({ FLY_RELAY_APP: "seazn-relay-prod", ENV_NAME: "prod" })).toEqual({ app: "seazn-relay-prod", environment: "prod" });
    expect(liveRunnerIdentity({ RELAY_DRIVERS: "fake", FLY_RELAY_APP: "seazn-relay-stg", ENV_NAME: "stg" })).toEqual({ app: "seazn-relay-stg", environment: "stg" });
  });
});
