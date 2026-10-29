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
//    carry none of those keys, but since W2c Task 12 the product WRITES each
//    new stage's preset rules (the engine's `stageDefaults` for its kind and
//    the division's variant: a knockout's extra time and shoot-out, overtime,
//    the super over) into `config.rules` at create, under any rules the
//    create sent. `stageCfg` below layers both the same way, through the
//    product's own mapping (fix round 1, R-T12-3): a stage the harness posts
//    with rules (a hold-path cell's every-decider-off, `decidersOffRulesFor`)
//    passes them, or the in-process fold diverges from the product's.
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { effectiveEntrantModel, writeConfigIssues, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { decidersOffRules, postedStageCfg } from "../../../apps/web/src/lib/stage-decider-off.ts";

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
  /** The rule row of the write door that refused the cfg (after the schema accepted it), or null for a schema refusal. */
  readonly doorRow: string | null;
  constructor(sportKey: string, variantKey: string, detail: string, doorRow: string | null = null) {
    super(`sport-cfg: ${sportKey}/${variantKey} config invalid — ${detail}`);
    this.name = "CfgInvalid";
    this.detail = detail;
    this.doorRow = doorRow;
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

/** The rulebook's row for each sport that declares a WRITE door (`SportModule.configWriteIssues`, W2e ruling 31 / RB2A-13): VB-CF-1
 *  and TT-CF-1 refuse a set target below the engine's floor, TN-CF-1 a tennis best of 1 whose final set is a match tie-break. The
 *  table is the rulebook's (typed once); which sports NEED a row is the engine's (sport-cfg-write-door.test.ts sweeps the two equal). */
export const WRITE_DOOR_ROW: Readonly<Record<string, string>> = { volleyball: "VB-CF-1", tabletennis: "TT-CF-1", tennis: "TN-CF-1" };

/** A sport whose module declares a write door but whose rows this table does not name: a new door owes its row here, so it is
 *  refused by name rather than planned or reported as an unnamed sentence. */
export class WriteDoorRowUnnamed extends Error {
  constructor(sportKey: string, issues: readonly string[]) {
    super(`sport-cfg: ${sportKey} refuses a config at the write door (${issues.join("; ")}) but WRITE_DOOR_ROW names no rule row for it`);
    this.name = "WriteDoorRowUnnamed";
  }
}

/** The detail of a write-door refusal: the sport's rule row and the engine's own sentence(s). */
export function writeDoorRefusal(sportKey: string, issues: readonly string[]): string {
  const row = WRITE_DOOR_ROW[sportKey];
  if (row === undefined) throw new WriteDoorRowUnnamed(sportKey, issues);
  return `${row}: the write door refuses it - ${issues.join("; ")}`;
}

/** The cfg a division could be WRITTEN with: `resolveSchemaCfg`, then what the module's write door refuses (`writeConfigIssues`: the
 *  set-target floors, a tennis best of 1 with a match tie-break). Throws CfgInvalid for either, so a combination the product refuses
 *  at create is never built, never planned and never scored by the harness (variants.ts: such a pair is listed uncoverable, naming
 *  its rule row). A caller that must build a REFUSED cfg on purpose (a test proving the door) asks `resolveSchemaCfg`. */
export function resolveSportCfg(sportKey: string, variantKey: string, overrides: Record<string, unknown> = {}): unknown {
  const cfg = resolveSchemaCfg(sportKey, variantKey, overrides);
  const issues = writeConfigIssues(sportModule(sportKey), cfg);
  if (issues.length > 0) throw new CfgInvalid(sportKey, variantKey, writeDoorRefusal(sportKey, issues), WRITE_DOOR_ROW[sportKey]);
  return cfg;
}

/** The variant preset merged under the overrides and parsed by the module's own schema - the schema's verdict ALONE. A stored
 *  config that breaks a write-door rule still loads, folds and scores (E15), so this is the cfg of a division written before the
 *  rule; `resolveSportCfg` is the one that answers "may this be written". */
export function resolveSchemaCfg(sportKey: string, variantKey: string, overrides: Record<string, unknown> = {}): unknown {
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
 *  own declaration, never a table typed here. `drawsAllowed` is unchanged: it answers a different question (may
 *  this fixture end level, by stage kind).
 *
 *  W2c Task 12, fix rounds 1 and 2 (R-T12-3, review M-3): the PRODUCT's composition, imported, never re-composed:
 *  apps/web lib/stage-decider-off.ts `postedStageCfg`, which is what the create door stores (`storedStageRules`: its
 *  sport's preset for its kind and the division's variant, the posted `rules` merged over it, a sent null removing a
 *  preset key) read through the resolver (`liveStageCfg`: the division, the stage's rules through the one mapping, then
 *  the bracket deciders over the parse). The product's own door and resolver equal it, a counted differential in
 *  apps/web usecases/__tests__/stage-cfg-composition.test.ts. `rules` are what the harness POSTED with the stage, never
 *  the product's read-back. A stage whose kind and variant declare no preset, that was posted no rules and is not a
 *  bracket is returned as it came, untouched. */
export function stageCfg(sportKey: string, cfg: unknown, stageKind: StageKind, variantKey: string, rules?: Readonly<Record<string, unknown>>): unknown {
  return postedStageCfg(sportModule(sportKey), cfg, stageKind, variantKey, rules);
}

/** The `config.rules` a HOLD-PATH cell posts on a stage of `stageKind` (a cell whose scenario is "a level knockout is
 *  held"): every decider off, X-SR-6's held arm and a state an organiser reaches on purpose, from the product's own
 *  builder (`decidersOffRules`, the e2e rigs' too). A table stage posts none: no decider plays there. */
export function decidersOffRulesFor(sportKey: string, variantKey: string, stageKind: StageKind): Record<string, unknown> | undefined {
  return forbidsLevelResult(stageKind) ? decidersOffRules(sportModule(sportKey), variantKey, stageKind) : undefined;
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
