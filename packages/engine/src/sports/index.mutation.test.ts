// Engine mutation debt (sport-free lane) — `registerBuiltins`, the boot path the web app (server/engine-db/registry.ts,
// scorepad/module-client.ts) and the bench run to fill a registry with every shipped module. Expected values come from the
// engine's own declaration of what ships (`builtinModules`), never a list typed here.
import { describe, expect, it } from "vitest";
import { createRegistry } from "../sport/registry.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { builtinModules, registerBuiltins } from "./index.ts";

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
};

describe("registerBuiltins", () => {
  it("the empty case: a registry nobody booted resolves no shipped module", () => {
    const reg = createRegistry();
    const visited = forEachSport(({ key, module }) => {
      expect(codeOf(() => reg.get(key, module.version)), key).toBe("MODULE_NOT_FOUND");
    });
    expect(visited).toBe(builtinModules.length);
    expect(visited).toBeGreaterThan(0);
  });

  it("registers every shipped module: each resolves by its exact key and version to that very module", () => {
    const reg = createRegistry();
    registerBuiltins(reg);
    const visited = forEachSport(({ key, module }) => {
      expect(reg.get(key, module.version), key).toBe(module);
      expect(codeOf(() => reg.latest(key)), key).toBeUndefined();
    });
    expect(visited).toBe(builtinModules.length);
  });

  it("a second boot of the same registry is MODULE_DUPLICATE; a different registry boots cleanly (idempotent per registry)", () => {
    const first = createRegistry();
    registerBuiltins(first);
    expect(codeOf(() => registerBuiltins(first))).toBe("MODULE_DUPLICATE");
    const second = createRegistry();
    expect(codeOf(() => registerBuiltins(second))).toBeUndefined();
    const visited = forEachSport(({ key, module }) => {
      expect(second.get(key, module.version), key).toBe(module);
      expect(first.get(key, module.version), key).toBe(module);
    });
    expect(visited).toBe(builtinModules.length);
  });
});
