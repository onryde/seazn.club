import { describe, expect, it } from "vitest";
import { declaredCfgs } from "./declared-cfgs.ts";
import { forEachSport } from "./for-each-sport.ts";

describe("declaredCfgs (W2a, preflight C7)", () => {
  it("empty case first: a module that declares nothing is refused, never an empty sweep", () => {
    expect(() => declaredCfgs({ configSchema: { safeParse: () => ({ success: false }), parse: (v) => v }, variants: {} })).toThrow(/declares no config/);
  });
  it("every sport yields every declared variant by name, and the schema default only where {} parses", () => {
    let checked = 0;
    const sports = forEachSport(({ key, module }) => {
      const got = declaredCfgs(module as never).map((c) => c.name);
      const bareOk = module.configSchema.safeParse({}).success;
      expect(got, key).toEqual([...(bareOk ? ["(schema default)"] : []), ...Object.keys(module.variants)]);
      expect(got.length, key).toBeGreaterThan(0);
      checked++;
    });
    expect(sports).toBe(11);
    expect(checked).toBe(11);
  });
  it("generic has no schema default, so its declared cfgs are exactly its variants (the case that used to throw)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "generic") return; // one-line reason: generic is the one schema with no defaults (preflight C7)
      expect(module.configSchema.safeParse({}).success).toBe(false);
      expect(declaredCfgs(module as never).map((c) => c.name)).toEqual(Object.keys(module.variants));
      checked++;
    });
    expect(checked).toBe(1);
  });
});
