// Sport configuration resolved exactly as createDivision does it: the variant
// preset merged under the overrides, parsed by the module's own configSchema
// (divisions.ts createDivision; mirrors validate-pack.ts resolveDivisionCfg,
// which this harness may not import — ruling 17).
import type { StageKind } from "@seazn/engine/core";
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
  return sportModule(sportKey).supportsDraws(cfg as never, stageKind);
}

export function entrantKindFor(sportKey: string, cfg: unknown): "individual" | "pair" | "team" {
  return effectiveEntrantModel(sportModule(sportKey).entrantModel ?? null, cfg).defaultKind;
}
