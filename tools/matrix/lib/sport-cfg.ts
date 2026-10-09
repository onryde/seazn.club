// Sport configuration resolved the way createDivision does it: the variant
// preset merged under the overrides, parsed by the module's own configSchema
// (divisions.ts createDivision; mirrors validate-pack.ts resolveDivisionCfg,
// which this harness may not import — ruling 17). The two agree ONLY under
// these conditions, and nothing here checks them:
//  - The preset source differs. The product merges the DB row
//    `sport_variants.config`, preferring an org-owned row. This file merges the
//    engine's `module.variants`. They are equal only after `sync:sports` has
//    written the rows from `module.variants`, and only while the org has no
//    variant rows of its own. A fresh matrix DB and a fresh org satisfy both
//    (R14).
//  - The product folds a fixture under `stageScopedCfg(division.config,
//    stage.config)`, which overlays `rules`, `shootout` and `extraTime` from
//    the stage. The builder's template stage configs (format-templates.ts)
//    carry none of those keys, so today the overlay is the identity. A wave
//    that adds stage rules must resolve them here too, or the in-process fold
//    diverges from the product's.
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { effectiveEntrantModel, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";

export class UnknownSport extends Error {
  readonly sportKey: string;
  constructor(sportKey: string) {
    super(`sport-cfg: unknown sport '${sportKey}'`);
    this.name = "UnknownSport";
    this.sportKey = sportKey;
  }
}

export class UnknownVariant extends Error {
  readonly sportKey: string;
  readonly variantKey: string;
  readonly declared: string[];
  constructor(sportKey: string, variantKey: string, declared: string[]) {
    super(`sport-cfg: unknown variant '${variantKey}' for ${sportKey} (declared: ${declared.join(", ")})`);
    this.name = "UnknownVariant";
    this.sportKey = sportKey;
    this.variantKey = variantKey;
    this.declared = declared;
  }
}

export class CfgInvalid extends Error {
  readonly detail: string;
  constructor(sportKey: string, variantKey: string, detail: string) {
    super(`sport-cfg: ${sportKey}/${variantKey} config invalid — ${detail}`);
    this.name = "CfgInvalid";
    this.detail = detail;
  }
}

export function sportModule(sportKey: string): AnySportModule {
  const m = builtinModules.find((x) => x.key === sportKey);
  if (m === undefined) throw new UnknownSport(sportKey);
  return m;
}

export function variantKeys(sportKey: string): string[] {
  return Object.keys(sportModule(sportKey).variants as Record<string, unknown>);
}

export function resolveSportCfg(sportKey: string, variantKey: string, overrides: Record<string, unknown> = {}): unknown {
  const m = sportModule(sportKey);
  const variants = m.variants as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(variants, variantKey)) {
    throw new UnknownVariant(sportKey, variantKey, Object.keys(variants));
  }
  const parsed = m.configSchema.safeParse({ ...(variants[variantKey] as object), ...overrides });
  if (!parsed.success) {
    throw new CfgInvalid(
      sportKey,
      variantKey,
      parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

/** The ONLY source of "may this fixture end level" (R9): the module's declaration. */
export function drawsAllowed(sportKey: string, cfg: unknown, stageKind: StageKind): boolean {
  return sportModule(sportKey).supportsDraws(cfg, stageKind);
}

/** W2a (spec §5.6.1, finding 16): the cfg a fixture is FOLDED under. A bracket stage applies the module's own
 *  `bracketDeciders(cfg)` overlay on top of the resolved cfg (loop F Task 6 will do the same server-side; the
 *  V347 freeze then carries it), so the harness's in-process fold and its stream generation must read the
 *  overlaid cfg or they diverge from the product on every boardgame and carrom bracket. Built from the engine's
 *  own declaration, never a table typed here: a stage that is not a bracket is returned as it came, untouched.
 *  `drawsAllowed` is unchanged: it answers a different question (may this fixture end level, by stage kind). */
export function stageCfg(sportKey: string, cfg: unknown, stageKind: StageKind): unknown {
  if (!forbidsLevelResult(stageKind)) return cfg;
  const overlay = sportModule(sportKey).bracketDeciders(cfg) as Record<string, unknown>;
  return { ...(cfg as Record<string, unknown>), ...overlay };
}

export function entrantKindFor(sportKey: string, cfg: unknown): "individual" | "pair" | "team" {
  return effectiveEntrantModel(sportModule(sportKey).entrantModel ?? null, cfg).defaultKind;
}

/** Every entrant kind the sport's model allows under this cfg (a division
 *  picks one; the default is entrantKindFor). Doubles-capable sports list
 *  "pair" here though they default to "individual"; a module that declares no
 *  model (generic) allows every kind. */
export function entrantKindsFor(sportKey: string, cfg: unknown): string[] {
  return [...effectiveEntrantModel(sportModule(sportKey).entrantModel ?? null, cfg).kinds];
}
