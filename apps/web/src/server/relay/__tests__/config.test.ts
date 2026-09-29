// Da: the build sha is PARSED out of Fly's image ref, never trusted whole. Pure.
// And the money guard: a process that was never told RELAY_DRIVERS=live runs the fake drivers — outside production. In
// production (Task 14b, R5) it runs NO drivers: "disabled", and createSession refuses. Explicit fake is refused on stg/prod.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLY_RELAY_APP_RETIRED_DEFAULT, LOCAL_ENV_NAME, buildShaOf, liveRunnerIdentity, relayDriverMode, relayEnvironment } from "../config";

describe("buildShaOf (Da)", () => {
  it("a 40-hex tag → the sha; a deployment-… tag → null; unset → null", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildShaOf(`registry.fly.io/seazn-club:${sha}`)).toBe(sha);
    expect(buildShaOf("registry.fly.io/seazn-club:deployment-01HZX5Y8K2M3N4P5Q6R7S8T9V0")).toBeNull();
    expect(buildShaOf(undefined)).toBeNull();
  });
});

describe("relayDriverMode — unset is fake outside production (a process not told it may spend money does not)", () => {
  // Restored after every case: removed when it was originally unset (never assigned `undefined`, which Node stores as
  // the string "undefined" — and "undefined" is exactly a value this function must refuse).
  const saved = process.env.RELAY_DRIVERS;
  afterEach(() => {
    if (saved === undefined) delete process.env.RELAY_DRIVERS;
    else process.env.RELAY_DRIVERS = saved;
  });

  it("unset → fake, and empty → fake (the money guard) — vitest's own NODE_ENV is not production", () => {
    expect(process.env.NODE_ENV, "premise: this reads process.env outside production").not.toBe("production");
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

  it("anything else throws rather than guessing a mode — LIVE, true, 1, the string \"undefined\", disabled", () => {
    // "disabled" is a RESOLVED mode, never a value to set: production with nothing set is how a deployment reaches it.
    for (const value of ["LIVE", "true", "1", "undefined", "disabled"]) {
      process.env.RELAY_DRIVERS = value;
      expect(() => relayDriverMode(), value).toThrow(/RELAY_DRIVERS must be "fake" or "live"/);
    }
  });
});

// R5 (Task 14b, owner ruling 2026-09-29): once every plan streams, a production deploy missing its relay secrets would
// otherwise hand every club a FAKE "live" stream and consume real credits. The rule, from the ruling's own words:
//   * RELAY_DRIVERS=live → live, whatever else is set;
//   * unset or empty → "disabled" under NODE_ENV=production (nothing faked; createSession answers ingest_unavailable),
//     and fake anywhere else (dev and test keep today's behaviour);
//   * explicit fake → only when ENV_NAME is unset, "local" or "ci" — stg, prod or any other name REFUSES;
//   * anything else → refused, as before.
// The expected column is that rule written out, never the function's output: every cell of the table is enumerated.
describe("R5: relayDriverMode over every NODE_ENV × RELAY_DRIVERS × ENV_NAME", () => {
  const NODE_ENVS = ["production", "development", "test", undefined] as const;
  const DRIVERS = [undefined, "", "fake", "live", "junk"] as const;
  const ENV_NAMES = [undefined, "", "   ", "local", "ci", "stg", "prod", "preview"] as const;
  const FAKE_ALLOWED = new Set<string | undefined>([undefined, "", "   ", "local", "ci"]);   // blank reads as unset (envNameOf trims)
  type Want = "fake" | "live" | "disabled" | RegExp;
  const rule = (node: string | undefined, drivers: string | undefined, envName: string | undefined): Want => {
    if (drivers === "live") return "live";
    if (drivers === undefined || drivers === "") return node === "production" ? "disabled" : "fake";
    if (drivers === "fake") return FAKE_ALLOWED.has(envName) ? "fake" : /RELAY_DRIVERS=fake is refused on ENV_NAME/;
    return /RELAY_DRIVERS must be "fake" or "live"/;
  };

  it("resolves each cell as the ruling says — and every outcome is reached at least once", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const NODE_ENV of NODE_ENVS) {
      for (const RELAY_DRIVERS of DRIVERS) {
        for (const ENV_NAME of ENV_NAMES) {
          const env = { NODE_ENV, RELAY_DRIVERS, ENV_NAME };
          const want = rule(NODE_ENV, RELAY_DRIVERS, ENV_NAME);
          const label = JSON.stringify(env);
          if (want instanceof RegExp) {
            expect(() => relayDriverMode(env), label).toThrow(want);
            seen.add(want.source);
          } else {
            expect(relayDriverMode(env), label).toBe(want);
            seen.add(want);
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(NODE_ENVS.length * DRIVERS.length * ENV_NAMES.length);
    // Anti-vacuity: a table whose every cell landed on one answer would pass on a constant function.
    expect([...seen].sort()).toEqual(["RELAY_DRIVERS must be \"fake\" or \"live\"", "RELAY_DRIVERS=fake is refused on ENV_NAME", "disabled", "fake", "live"].sort());
  });

  it("the refusal of fake on a deployment names the variable, the environment and the way out", () => {
    expect(() => relayDriverMode({ RELAY_DRIVERS: "fake", ENV_NAME: "prod" })).toThrow(/ENV_NAME="prod".*RELAY_DRIVERS=live/s);
  });

  it("disabled is production-only: the same unset variable under every other NODE_ENV is fake", () => {
    let checked = 0;
    for (const NODE_ENV of NODE_ENVS) {
      expect(relayDriverMode({ NODE_ENV }), String(NODE_ENV)).toBe(NODE_ENV === "production" ? "disabled" : "fake");
      checked++;
    }
    expect(checked).toBe(NODE_ENVS.length);
  });
});

// I1 (Task 12 fix round 1, owner decision 2026-09-28): the deploy environment's identity is ENV_NAME ("stg" | "prod",
// a Fly secret per deployment). It is the daily sweep's ONLY licence to destroy a listed runner, so a live process that
// cannot name its environment must refuse rather than guess; a fake process needs neither variable.
describe("relayEnvironment — ENV_NAME, required in live mode, a named local default in fake mode", () => {
  it("fake (unset or explicit) without ENV_NAME → the local default; unset with it → the value; live with it → the value", () => {
    let checked = 0;
    for (const drivers of [undefined, "", "fake"]) {
      expect(relayEnvironment({ RELAY_DRIVERS: drivers }), `RELAY_DRIVERS=${drivers}`).toBe(LOCAL_ENV_NAME);
      checked++;
    }
    for (const drivers of [undefined, ""]) {
      expect(relayEnvironment({ RELAY_DRIVERS: drivers, ENV_NAME: "stg" }), `RELAY_DRIVERS=${drivers}`).toBe("stg");
      checked++;
    }
    // R5: an EXPLICIT fake on a named deployment is refused before any environment is answered.
    expect(() => relayEnvironment({ RELAY_DRIVERS: "fake", ENV_NAME: "stg" })).toThrow(/RELAY_DRIVERS=fake is refused/);
    // A disabled production process still names itself (nothing is created under it).
    expect(relayEnvironment({ NODE_ENV: "production", ENV_NAME: "prod" })).toBe("prod");
    expect(relayEnvironment({ RELAY_DRIVERS: "live", ENV_NAME: "prod" })).toBe("prod");
    expect(checked).toBe(5);
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
      process.env.RELAY_DRIVERS = "live";
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

// R5 "throws at boot": instrumentation.ts's register() — the hook Next calls ONCE before the server takes a request —
// resolves the relay mode on the nodejs runtime, so a deployment configured to fake refuses to START rather than fail at
// its first stream. Sentry is doubled: the hook initialises it first, and this file is about the relay check only.
vi.mock("@sentry/nextjs", () => ({ captureRequestError: () => {}, init: () => {} }));
vi.mock("../../../../sentry.server.config", () => ({}));
vi.mock("../../../../sentry.edge.config", () => ({}));

describe("R5: the boot hook refuses a faking deployment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("nodejs runtime: fake on a named deployment REJECTS register(); every allowed configuration boots; the edge runtime never checks", async () => {
    const { register } = await import("../../../../instrumentation");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "prod");
    await expect(register()).rejects.toThrow(/RELAY_DRIVERS=fake is refused on ENV_NAME/);
    let booted = 0;
    for (const [drivers, envName] of [["fake", "ci"], ["fake", "local"], ["live", "prod"], ["", "prod"]] as const) {
      vi.stubEnv("RELAY_DRIVERS", drivers);
      vi.stubEnv("ENV_NAME", envName);
      await expect(register(), `${drivers}/${envName}`).resolves.toBeUndefined();
      booted++;
    }
    expect(booted).toBe(4);
    // The edge runtime serves no relay route; the same bad configuration does not stop it.
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "prod");
    await expect(register()).resolves.toBeUndefined();
  });
});
