// PROMPT-61 §2 — stage-scoped decider overlay, pure.
import { describe, expect, it } from "vitest";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { stageScopedCfg } from "../stage-cfg";

describe("stageScopedCfg", () => {
  it("overlays only shootout/extraTime from the stage config", () => {
    const div = { shootout: false, points: { win: 3 }, halfMinutes: 45 };
    expect(
      stageScopedCfg(div, {
        shootout: true,
        extraTime: { enabled: true, halfMinutes: 15 },
        points: { win: 99 }, // stage points are competition.ts territory, not deciders
      }, null),
    ).toEqual({
      shootout: true,
      extraTime: { enabled: true, halfMinutes: 15 },
      points: { win: 3 },
      halfMinutes: 45,
    });
  });

  it("is the identity when the stage sets no decider key", () => {
    const div = { extraTime: { enabled: true, halfMinutes: 15 } };
    expect(stageScopedCfg(div, null, null)).toBe(div);
    expect(stageScopedCfg(div, undefined, null)).toBe(div);
    expect(stageScopedCfg(div, {}, null)).toBe(div);
    expect(stageScopedCfg(div, { rngSeed: 7 }, null)).toBe(div);
  });

  it("overlays stage.config.rules onto the division config, per key", () => {
    const division = { bestOf: 1, setTo: 21, cap: 30 };
    const out = stageScopedCfg(division, { rules: { bestOf: 3 } }, null) as Record<string, unknown>;
    expect(out).toEqual({ bestOf: 3, setTo: 21, cap: 30 });
  });

  it("lets a stage's own decider keys win over anything in rules", () => {
    // rules is applied FIRST, the decider loop second, so `shootout` has one
    // winner even if a future writer smuggles it into rules.
    const out = stageScopedCfg(
      { shootout: "none" },
      {
        shootout: "best_of_five",
        rules: { shootout: "sudden_death" },
      },
      null,
    ) as Record<string, unknown>;
    expect(out.shootout).toBe("best_of_five");
  });

  it("treats an explicit null in rules as no override, not as a value", () => {
    // "inherit" is key ABSENCE. Object.assign copies nulls, so a null that
    // reached the column would blank the division value.
    const out = stageScopedCfg({ bestOf: 3 }, { rules: { bestOf: null } }, null) as Record<
      string,
      unknown
    >;
    expect(out.bestOf).toBe(3);
  });

  it("is reference-identical when the stage carries no rules", () => {
    const division = { bestOf: 3 };
    expect(stageScopedCfg(division, { pairing: "fold" }, null)).toBe(division);
  });

  // W2c Task 12 fix round 1 (R-T12-1): a stage switches off a decider whose engine off is null with an explicit `false`,
  // and the resolver reads it as that null. Swept over every sport, variant and knockout decider the engine declares;
  // the expected list is the ruling's (ice hockey's overtime and shoot-out, hockey's shoot-out), never the predicate's.
  it("R-T12-1 a stage's `false` is the engine's null for exactly the ruling's deciders, and itself everywhere else (registry sweep, counted)", () => {
    const RULING: Record<string, readonly string[]> = { icehockey: ["overtime", "shootout"], hockey: ["shootout"] };
    let mapped = 0;
    let kept = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
        for (const k of deciderKeysFor(m, "knockout", variant)) {
          const out = stageScopedCfg(division, { rules: { [k]: false } }, m) as Record<string, unknown>;
          if (RULING[m.key]?.includes(k)) {
            expect(out[k], `${m.key}/${variant}/${k}: off`).toBeNull();
            expect(m.configSchema.safeParse(out).success, `${m.key}/${variant}: the engine takes the resolved cfg`).toBe(true);
            mapped++;
          } else {
            expect(out[k], `${m.key}/${variant}/${k}: false is its own value here`).toBe(false);
            kept++;
          }
        }
      }
    }
    // 2 ice-hockey variants x 2 deciders + 3 hockey variants x 1 = 7.
    expect(mapped).toBe(7);
    expect(kept, "football, cricket and chess deciders swept too").toBeGreaterThan(0);
  });

  it("R-T12-1 the map needs the module: without one (a caller that has none) `false` is left as sent; a non-decider is never mapped", () => {
    const ice = builtinModules.find((m) => m.key === "icehockey") as AnySportModule;
    const division = ice.configSchema.parse(ice.variants.iihf) as Record<string, unknown>;
    expect((stageScopedCfg(division, { rules: { overtime: false } }, null) as Record<string, unknown>).overtime).toBe(false);
    const badminton = builtinModules.find((m) => m.key === "badminton") as AnySportModule;
    const bwf = badminton.configSchema.parse(badminton.variants.bwf) as Record<string, unknown>;
    // `cap` takes null (no cap) and refuses false, but it is no decider: a `false` there is refused by the schema, never
    // read as "no cap".
    expect(badminton.configSchema.safeParse({ ...bwf, cap: null }).success, "the premise: cap takes null").toBe(true);
    expect((stageScopedCfg(bwf, { rules: { cap: false } }, badminton) as Record<string, unknown>).cap).toBe(false);
  });
});
