// W2c Task 12 fix round 2 (review M-3) — the format-matrix harness folds a stage's fixtures under `stageCfg`
// (tools/matrix/lib/sport-cfg.ts). That function is a single call to this app's lib/stage-decider-off.ts `postedStageCfg`,
// pinned by tools/matrix/__tests__/boundary.test.ts. apps/ may never import a harness under tools/ (ruling 56), so the
// differential runs here instead, against the code the harness calls.
//
// For every sport x variant x stage kind, `postedStageCfg` must equal what the PRODUCT folds the same stage's fixtures
// under, reached through its own entry points: `validatedStageConfig` stores the stage as the create does, and `liveCfg`
// reads it as the resolver does, with no snapshot and no override.
//
// What this pins is the GLUE only (Task 12 re-review N-1). Both sides bottom out in the same two functions —
// `storedStageRules` (the base and the merge) and `liveStageCfg` (the overlay) — so a defect INSIDE either moves both
// sides together and stays green here. What it catches is a door or a harness that composes them differently: a
// different base, a skipped merge, a different overlay order, a create door that stores something else. The internals
// are pinned by the DB tests that drive the real doors and folds (stage-defaults.test.ts, stage-cfg.test.ts).
//
// Two arms, the ones the matrix posts:
// - presets ON (no rules);
// - every decider off on a bracket stage (`decidersOffRules`, the HOLD_PATH cells' rules, X-SR-6's held arm).
//
// Counted. The knockout preset pairs are pinned. Pure: no database.
import { describe, expect, it } from "vitest";
import { forbidsLevelResult, StageKind } from "@seazn/engine/core";
import { stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { decidersOffRules, postedStageCfg } from "@/lib/stage-decider-off";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { validatedStageConfig } from "../stage-defaults";

const MODULES = builtinModules as readonly AnySportModule[];

/** The cfg the product folds a fixture of this stage under, before its first event: the stage as the create stores it,
 *  read through the resolver's live path. */
function productCfg(m: AnySportModule, variant: string, kind: StageKind, division: unknown, rules: Record<string, unknown> | undefined): unknown {
  const stored = validatedStageConfig(m, m.key, kind, variant, division, rules === undefined ? {} : { rules });
  return liveCfg(division, { kind, config: stored }, m);
}

describe("M-3 the matrix harness's stageCfg (postedStageCfg) composes the stage cfg the way the product's doors do (the glue, not the internals)", () => {
  it("every sport x variant x kind, both arms the matrix posts: postedStageCfg == the create door's stored stage read through the resolver's live path (counted; the knockout preset pairs pinned)", () => {
    let compared = 0;
    let heldCompared = 0;
    const presetPairs = new Set<string>();
    const presetSports = new Set<string>();
    for (const m of MODULES) {
      for (const variant of Object.keys(m.variants)) {
        const division = m.configSchema.parse(m.variants[variant]);
        for (const kind of StageKind.options) {
          const where = `${m.key}/${variant}/${kind}`;
          expect(postedStageCfg(m, division, kind, variant), `${where}: presets on`).toEqual(productCfg(m, variant, kind, division, undefined));
          compared++;
          if (forbidsLevelResult(kind)) {
            const held = decidersOffRules(m, variant, kind);
            expect(postedStageCfg(m, division, kind, variant, held), `${where}: every decider off`).toEqual(productCfg(m, variant, kind, division, held));
            heldCompared++;
          }
          if (kind === "knockout" && Object.keys(stageDefaultsFor(m, kind, variant)).length > 0) {
            presetPairs.add(`${m.key}/${variant}`);
            presetSports.add(m.key);
          }
        }
      }
    }
    // Every sweep size derived from the engine's own kinds and variants, never typed.
    const variants = MODULES.reduce((n, m) => n + Object.keys(m.variants).length, 0);
    expect(compared, "anti-vacuity").toBeGreaterThan(0);
    expect(compared).toBe(StageKind.options.length * variants);
    expect(heldCompared).toBe(StageKind.options.filter((k) => forbidsLevelResult(k)).length * variants);
    // The ruling's four sports and their 12 variants (R-T12-3's positive pairs).
    expect([...presetSports].sort()).toEqual(["cricket", "football", "hockey", "icehockey"]);
    expect(presetPairs.size).toBe(12);
  });

  it("the differential sees a difference: a posted null removes a preset key on both sides, and the result differs from the preset's", () => {
    const m = MODULES.find((x) => x.key === "football")!; // single-sport: the merge is sport-blind; football has a multi-key preset
    const division = m.configSchema.parse(m.variants["11-a-side"]) as Record<string, unknown>;
    const [first] = Object.keys(stageDefaultsFor(m, "knockout", "11-a-side")) as [string];
    const removed = postedStageCfg(m, division, "knockout", "11-a-side", { [first]: null }) as Record<string, unknown>;
    expect(removed).toEqual(productCfg(m, "11-a-side", "knockout", division, { [first]: null }));
    expect(removed[first], "the key falls back to the division's value").toEqual(division[first]);
    expect(postedStageCfg(m, division, "knockout", "11-a-side")).not.toEqual(removed);
  });
});
