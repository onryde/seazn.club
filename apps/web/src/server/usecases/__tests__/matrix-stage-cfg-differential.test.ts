// W2c Task 12 fix round 2 (review M-3) — the format-matrix harness folds a stage's fixtures under `stageCfg`
// (tools/matrix/lib/sport-cfg.ts). It shares the product's ONE mapping (`stageRulesOverlay`), but it composes the rest
// itself: the preset layered under the rules it posted, and then the bracket deciders. This test is the differential that
// keeps that composition honest. For every sport x variant x stage kind, the harness's cfg must equal the cfg the product
// would fold the same stage's fixtures under. The product side is reached through its own code: `validatedStageConfig`
// stores the stage as the create does, and `liveCfg` reads it as the resolver does (no snapshot, no override).
//
// Two arms, the ones the matrix posts:
// - presets ON (no rules posted);
// - every decider off on a bracket stage (`decidersOffRulesFor`, the HOLD_PATH cells' rules, X-SR-6's held arm).
//
// Counted. The preset pairs (every sport x variant whose knockout has a preset) are tallied on their own, and must
// cover every such sport the engine declares. Pure: no database.
//
// Why a differential rather than the harness importing the product composition: `STAGE_DECIDER_KEYS` is text-pinned
// in `engine-db/stage-cfg.ts` by tools/bench's validate-pack mirror test. Task 13b reworks that resolver, and the bench
// gap is carried there, so moving the composition now would churn both. This diff reds on any drift instead.
import { describe, expect, it } from "vitest";
import { forbidsLevelResult, StageKind } from "@seazn/engine/core";
import { stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { validatedStageConfig } from "../stage-defaults";
import { decidersOffRulesFor, resolveSportCfg, stageCfg } from "../../../../../../tools/matrix/lib/sport-cfg.ts";

const MODULES = builtinModules as readonly AnySportModule[];

/** The cfg the product folds a fixture of this stage under, before its first event: the stage as the create stores it,
 *  read through the resolver's live path. */
function productCfg(m: AnySportModule, variant: string, kind: StageKind, division: unknown, rules: Record<string, unknown> | undefined): unknown {
  const stored = validatedStageConfig(m, m.key, kind, variant, division, rules === undefined ? {} : { rules });
  return liveCfg(division, { kind, config: stored }, m);
}

describe("M-3 the matrix harness's stageCfg is the product's cfg for the same stage (presets on, and every decider off)", () => {
  it("every sport x variant x kind, both arms the matrix posts: harness == product (counted; the knockout preset pairs pinned)", () => {
    let compared = 0;
    let heldCompared = 0;
    const presetPairs = new Set<string>();
    const presetSports = new Set<string>();
    for (const m of MODULES) {
      for (const variant of Object.keys(m.variants)) {
        const division = resolveSportCfg(m.key, variant);
        for (const kind of StageKind.options) {
          const where = `${m.key}/${variant}/${kind}`;
          expect(stageCfg(m.key, division, kind, variant), `${where}: presets on`).toEqual(productCfg(m, variant, kind, division, undefined));
          compared++;
          const held = decidersOffRulesFor(m.key, variant, kind);
          if (held !== undefined) {
            expect(stageCfg(m.key, division, kind, variant, held), `${where}: every decider off`).toEqual(productCfg(m, variant, kind, division, held));
            heldCompared++;
          }
          if (kind === "knockout" && Object.keys(stageDefaultsFor(m, kind, variant)).length > 0) {
            presetPairs.add(`${m.key}/${variant}`);
            presetSports.add(m.key);
            expect(held, `${where}: a preset knockout has a held arm`).toBeDefined();
          }
        }
      }
    }
    expect(compared, "anti-vacuity").toBeGreaterThan(0);
    expect(heldCompared, "anti-vacuity: bracket kinds were compared held too").toBeGreaterThan(0);
    // Exactly as many held comparisons as bracket stages swept: derived from the engine's kinds, never typed.
    const bracketKinds = StageKind.options.filter((k) => forbidsLevelResult(k)).length;
    const variants = MODULES.reduce((n, m) => n + Object.keys(m.variants).length, 0);
    expect(heldCompared).toBe(bracketKinds * variants);
    expect(compared).toBe(StageKind.options.length * variants);
    // The ruling's four sports and their 12 variants (R-T12-3's positive pairs), pinned so a preset added or lost moves
    // this line on purpose.
    expect([...presetSports].sort()).toEqual(["cricket", "football", "hockey", "icehockey"]);
    expect(presetPairs.size).toBe(12);
  });
});
