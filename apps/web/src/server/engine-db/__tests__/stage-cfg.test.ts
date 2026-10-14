// PROMPT-61 §2 — the stage-scoped cfg, pure. W2c Task 13b (D3): a stage's deciders are ordinary `config.rules` keys; the
// top-level `shootout` / `extraTime` overlay is gone, so nothing at a stage config's top level reaches the resolved cfg.
import { describe, expect, it } from "vitest";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { stageScopedCfg } from "../stage-cfg";

describe("stageScopedCfg", () => {
  // The empty case first: a stage that overlays nothing returns the division cfg ITSELF (callers pass it on unconditionally).
  it("the empty case: no stage cfg, an empty one, and empty rules all return the division cfg unchanged", () => {
    const division = { bestOf: 3 };
    let checked = 0;
    for (const stage of [null, undefined, {}, { rules: {} }, { rules: null }, { rngSeed: 7 }]) {
      expect(stageScopedCfg(division, stage as never, null), JSON.stringify(stage)).toBe(division);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("D3: a top-level stage decider no longer reaches the resolved cfg; the same key under rules does", () => {
    const division = { shootout: true };
    expect(stageScopedCfg(division, { shootout: false }, null)).toEqual({ shootout: true }); // top level ignored
    expect(stageScopedCfg(division, { shootout: false }, null), "the identity: nothing is overlaid").toBe(division);
    expect(stageScopedCfg(division, { rules: { shootout: false } }, null)).toEqual({ shootout: false }); // rules win
    expect(stageScopedCfg(division, { shootout: true, rules: { shootout: false } }, null)).toEqual({ shootout: false }); // both: rules
    const et = { extraTime: { enabled: false, halfMinutes: 15 } };
    expect(stageScopedCfg(et, { extraTime: { enabled: true, halfMinutes: 10 } }, null), "extraTime, the other old twin").toBe(et);
  });

  it("rules carry the deciders like any other key; nothing else at the stage's top level is read (points are competition.ts's)", () => {
    const div = { shootout: false, points: { win: 3 }, halfMinutes: 45 };
    expect(
      stageScopedCfg(div, {
        shootout: true, // top level: read by nothing (D3)
        points: { win: 99 }, // stage points are competition.ts territory, not this overlay's
        rules: { extraTime: { enabled: true, halfMinutes: 15 } },
      }, null),
    ).toEqual({
      shootout: false,
      extraTime: { enabled: true, halfMinutes: 15 },
      points: { win: 3 },
      halfMinutes: 45,
    });
  });

  // Every whole decider the engine declares (every sport, variant and kind): at the top level it is ignored, under `rules`
  // it resolves. A sentinel value, so the expected one is the input's, never the overlay's; no schema parse is involved.
  it("D3 registry sweep: every declared decider resolves from `rules` and never from the top level (counted)", () => {
    const SENTINEL = "stage-own-value";
    const seen = new Set<string>();
    let checked = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
        for (const k of deciderKeysFor(m, null, variant)) {
          expect(stageScopedCfg(division, { [k]: SENTINEL }, m), `${m.key}/${variant}/${k}: top level ignored`).toBe(division);
          const out = stageScopedCfg(division, { [k]: "top-level", rules: { [k]: SENTINEL } }, m) as Record<string, unknown>;
          expect(out[k], `${m.key}/${variant}/${k}: rules win`).toBe(SENTINEL);
          seen.add(`${m.key}.${k}`);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
    // The two keys the deleted overlay read, and one decider that never had a top-level twin.
    for (const k of ["football.shootout", "football.extraTime", "carrom.tieBoard"]) expect(seen, k).toContain(k);
  });

  // Another sport: carrom's tie board is a decider with no top-level twin ever, so it pins that `rules` alone reaches it.
  it("carrom: rules.tieBoard resolves over the division's (the right answer differs from the default 'extra')", () => {
    const carrom = builtinModules.find((m) => m.key === "carrom") as AnySportModule;
    const division = carrom.configSchema.parse(carrom.variants.icf) as Record<string, unknown>;
    expect(division.tieBoard, "the premise: ICF plays extra boards").toBe("extra");
    const out = stageScopedCfg(division, { rules: { tieBoard: "draw" } }, carrom);
    expect((out as Record<string, unknown>).tieBoard).toBe("draw");
    expect(carrom.configSchema.safeParse(out).success, "the engine takes the resolved cfg").toBe(true);
  });

  it("overlays stage.config.rules onto the division config, per key", () => {
    const division = { bestOf: 1, setTo: 21, cap: 30 };
    const out = stageScopedCfg(division, { rules: { bestOf: 3 } }, null) as Record<string, unknown>;
    expect(out).toEqual({ bestOf: 3, setTo: 21, cap: 30 });
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
