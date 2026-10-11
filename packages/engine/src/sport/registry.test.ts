// Registry & versioning — spec 03 §3, PROMPT-03 §2. Divisions pin the module
// version at creation; two versions of one sport resolve independently.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { generic } from "../sports/generic/generic.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import type { AnySportModule } from "./module.ts";
import { compareSemver, createRegistry, parseSemver, registry } from "./registry.ts";

const genericV11: AnySportModule = { ...generic, version: "1.1.0" };

describe("parseSemver", () => {
  it("parses strict x.y.z", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it.each(["1.0", "v1.0.0", "1.0.0-beta", "1..0", "one.two.three", ""])(
    "rejects %j with CONFIG_INVALID",
    (version) => {
      expect(() => parseSemver(version)).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    },
  );

  it("compares numerically, not lexically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.0.1", "1.0.1")).toBe(0);
    expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
  });
});

describe("registry", () => {
  it("resolves two versions of generic independently (version pinning)", () => {
    const reg = createRegistry();
    reg.register(generic);
    reg.register(genericV11);
    expect(reg.get("generic", "1.0.0")).toBe(generic);
    expect(reg.get("generic", "1.1.0")).toBe(genericV11);
    expect(reg.get("generic", "1.0.0").version).toBe("1.0.0");
  });

  it("latest() picks the highest semver, not insertion order", () => {
    const reg = createRegistry();
    reg.register(genericV11);
    reg.register(generic);
    reg.register({ ...generic, version: "1.2.10" });
    reg.register({ ...generic, version: "1.2.9" });
    expect(reg.latest("generic").version).toBe("1.2.10");
  });

  it("throws MODULE_DUPLICATE on duplicate key+version registration", () => {
    const reg = createRegistry();
    reg.register(generic);
    expect(() => reg.register({ ...generic })).toThrowError(
      expect.objectContaining({ code: "MODULE_DUPLICATE" }),
    );
    // a different version of the same key is fine
    expect(() => reg.register(genericV11)).not.toThrow();
  });

  it("throws MODULE_NOT_FOUND on unknown key or version", () => {
    const reg = createRegistry();
    reg.register(generic);
    expect(() => reg.get("generic", "9.9.9")).toThrowError(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
    expect(() => reg.get("quidditch", "1.0.0")).toThrowError(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
    expect(() => reg.latest("quidditch")).toThrowError(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
  });

  it("rejects modules with a bad version or empty key at registration", () => {
    const reg = createRegistry();
    expect(() => reg.register({ ...generic, version: "latest" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => reg.register({ ...generic, key: "" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("exposes a shared default instance", () => {
    expect(EngineError.is(catchErr(() => registry.latest("__nope__")), "MODULE_NOT_FOUND")).toBe(
      true,
    );
  });
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------------
// Engine mutation debt (Stryker leg modules-7, registry.ts). Expected values come from the semver rule (numeric x.y.z)
// and from the engine's own declaration of what ships (sports/index.ts builtinModules) — never from a list of sports typed
// here, so a sport added or re-versioned is swept without editing this file.
//
// A refusal's `message` is wire-visible: apps/web's v1 envelope sends `err.message` verbatim (server/api-v1/http.ts,
// `errorResponse(..., err.code, err.message, extra)`) and the overlay logs the whole error (server/overlay/load.ts,
// foldOrNull) — so each refusal must NAME what it refused. Its `data` is the machine-readable twin: pino's err serializer
// writes it into the log line beside the message.
// ---------------------------------------------------------------------------

/** The EngineError `fn` throws; fails the test if it returns or throws anything else. */
function refusal(fn: () => unknown): EngineError {
  const err = catchErr(fn);
  expect(err).toBeInstanceOf(EngineError);
  return err as EngineError;
}

/** Semver precedence (semver.org §11): major, then minor, then patch, each compared numerically. The test's own oracle. */
function semverAbove(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

describe("parseSemver / compareSemver — every part is a whole number of any length", () => {
  it("parses a multi-digit major, minor and patch", () => {
    expect(parseSemver("10.0.0")).toEqual({ major: 10, minor: 0, patch: 0 });
    expect(parseSemver("123.45.678")).toEqual({ major: 123, minor: 45, patch: 678 });
  });

  it("ranks 10.0.0 above 9.0.0 (numeric, where a string compare would say the opposite)", () => {
    expect("10.0.0" < "9.0.0").toBe(true); // the wrong answer this case exists to tell apart
    expect(compareSemver("10.0.0", "9.0.0")).toBeGreaterThan(0);
    expect(compareSemver("9.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("a refused version is CONFIG_INVALID naming the version, with the version as data", () => {
    for (const bad of ["1.0", "v1.0.0", "1.0.0-beta", ""]) {
      const err = refusal(() => parseSemver(bad));
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.message, JSON.stringify(bad)).toContain(`"${bad}"`);
      expect(err.message, JSON.stringify(bad)).not.toBe(`"${bad}"`); // says what is wrong, not only what
      expect(err.data).toStrictEqual({ version: bad });
    }
  });
});

// semver.org §2: "Numeric identifiers MUST NOT include leading zeroes." A version that violates it is refused, which also keeps two
// spellings of one number ("1.0.0", "01.0.0") from ranking equal and letting latest() fall back to insertion order.
describe("parseSemver refuses leading zeros (semver.org §2)", () => {
  it.each(["01.0.0", "1.00.0", "1.0.00", "001.2.3", "1.02.3", "1.2.03"])("rejects %j with CONFIG_INVALID", (bad) => {
    const err = refusal(() => parseSemver(bad));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.data).toStrictEqual({ version: bad });
  });

  it("still accepts a lone zero and a multi-digit part that does not start with zero", () => {
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseSemver("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
    expect(parseSemver("1.0.10")).toEqual({ major: 1, minor: 0, patch: 10 });
  });

  it("a module whose version has a leading zero is refused at registration, so it can never tie with its plain spelling", () => {
    const reg = createRegistry();
    reg.register(generic);
    const err = refusal(() => reg.register({ ...generic, version: `0${generic.version}` }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(reg.latest(generic.key)).toBe(generic);
  });
});

describe("registry refusals name what they refused", () => {
  it("an empty key is CONFIG_INVALID with a message that says the key is the problem", () => {
    const err = refusal(() => createRegistry().register({ ...generic, key: "" }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.message).toMatch(/\bkey\b/);
  });
});

describe("every shipped sport module through a fresh registry (sports/index.ts builtinModules)", () => {
  it("each registers, resolves by its exact key and version, and a second get returns the same module", () => {
    const reg = createRegistry();
    for (const module of builtinModules) reg.register(module);
    const visited = forEachSport(({ key, module }) => {
      expect(reg.get(key, module.version)).toBe(module);
      expect(reg.get(key, module.version)).toBe(module);
    });
    expect(visited).toBe(builtinModules.length);
    expect(visited).toBeGreaterThan(0);
  });

  it("latest(key) is the highest-ranking shipped version of that key", () => {
    const reg = createRegistry();
    for (const module of builtinModules) reg.register(module);
    const keys = new Set(builtinModules.map((m) => m.key));
    let checked = 0;
    for (const key of keys) {
      const shipped = builtinModules.filter((m) => m.key === key);
      const top = shipped.find((m) => shipped.every((o) => o === m || semverAbove(m.version, o.version)));
      expect(top, `${key}: one shipped version ranks above the rest`).toBeDefined();
      expect(reg.latest(key), key).toBe(top);
      checked++;
    }
    expect(checked).toBe(keys.size);
    expect(checked).toBeGreaterThan(0);
  });

  it("a second registration of a shipped module is MODULE_DUPLICATE naming key@version, and the first stays registered", () => {
    const reg = createRegistry();
    for (const module of builtinModules) reg.register(module);
    const visited = forEachSport(({ key, module }) => {
      const err = refusal(() => reg.register({ ...module }));
      expect(err.code).toBe("MODULE_DUPLICATE");
      expect(err.message).toContain(`${key}@${module.version}`);
      expect(err.data).toStrictEqual({ key, version: module.version });
      expect(reg.get(key, module.version)).toBe(module);
    });
    expect(visited).toBe(builtinModules.length);
  });

  it("lookup is by the exact key and version: a near miss is MODULE_NOT_FOUND naming what was asked for", () => {
    const reg = createRegistry();
    for (const module of builtinModules) reg.register(module);
    let misses = 0;
    const visited = forEachSport(({ key, module }) => {
      const { major, minor, patch } = parseSemver(module.version);
      const unshipped = `${major}.${minor}.${patch + 1000}`;
      const nearMisses: [string, string][] = [
        [key, `v${module.version}`],
        [key, unshipped],
        [`${key} `, module.version],
        [key.toUpperCase() === key ? `${key}_` : key.toUpperCase(), module.version],
      ];
      for (const [k, v] of nearMisses) {
        const err = refusal(() => reg.get(k, v));
        expect(err.code).toBe("MODULE_NOT_FOUND");
        expect(err.message).toContain(`${k}@${v}`);
        expect(err.data).toStrictEqual({ key: k, version: v });
        misses++;
      }
      const err = refusal(() => reg.latest(`${key}_unshipped`));
      expect(err.code).toBe("MODULE_NOT_FOUND");
      expect(err.message).toContain(`"${key}_unshipped"`);
      expect(err.data).toStrictEqual({ key: `${key}_unshipped` });
    });
    expect(visited).toBe(builtinModules.length);
    expect(misses).toBe(visited * 4);
  });

  it("an empty registry resolves nothing: get and latest of every shipped key are MODULE_NOT_FOUND", () => {
    const reg = createRegistry();
    const visited = forEachSport(({ key, module }) => {
      expect(refusal(() => reg.get(key, module.version)).data).toStrictEqual({ key, version: module.version });
      const err = refusal(() => reg.latest(key));
      expect(err.code).toBe("MODULE_NOT_FOUND");
      expect(err.data).toStrictEqual({ key });
    });
    expect(visited).toBe(builtinModules.length);
  });
});
