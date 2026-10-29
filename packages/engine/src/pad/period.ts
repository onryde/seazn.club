// P1.1 (pad wave) - the period kernel's two pad records, `hockeyPadRules` and `icehockeyPadRules` (spec 2026-10-29 section 3).
//
// Every field is the object the fold reads or a pure derivation of the sport's own declarations: the preset's reason list and
// goal-type flag, padSpec(cfg) for what one cfg offers, and the kernel's EVENT_PHASES table, which the fold's WRONG_PHASE guards read
// too. Nothing is restated here. A cfg is read through the module's own configSchema (defaults applied); one the schema refuses
// throws rather than being answered with a guess.
import type { PadSpec, SportModule } from "../sport/module.ts";
import { hockey, HOCKEY_GOAL_KIND_REQUIRED, HOCKEY_SUSPENSION_REASONS } from "../sports/hockey/hockey.ts";
import { icehockey, ICEHOCKEY_GOAL_KIND_REQUIRED, ICEHOCKEY_SUSPENSION_REASONS } from "../sports/icehockey/icehockey.ts";
import {
  EVENT_PHASES,
  PERIOD_ASSISTS_MAX,
  PERIOD_SUSPENSION_MINUTES_FALLBACK,
  PERIOD_SWAP_BAND,
  periodEventAllowedInPhase,
  periodSuspensionMinutesBound,
  type PeriodCfg,
  type PeriodEv,
  type PeriodEventSuffix,
  type PeriodState,
} from "../sports/period/kernel.ts";
import { padEnumValues, padFieldOf } from "./spec-lookup.ts";
import type { PeriodPadRules } from "./types.ts";

type PeriodModule = SportModule<PeriodCfg, PeriodEv, PeriodState>;

interface PresetFacts {
  /** The preset's own `suspensionReasons` list (hockey.ts / icehockey.ts). */
  readonly reasons: readonly string[];
  /** The preset's own `goalKindRequired` flag. */
  readonly goalKindRequired: boolean;
}

function periodPadRules(module: PeriodModule, facts: PresetFacts): PeriodPadRules {
  const key = module.key;
  if (module.padSpec === undefined) throw new Error(`${key}PadRules: the ${key} module declares no padSpec`);
  const buildSpec = (cfg: PeriodCfg): PadSpec => {
    const spec = module.padSpec?.(cfg);
    if (spec === undefined) throw new Error(`${key}PadRules: the ${key} module declares no padSpec`);
    return spec;
  };

  // The pad hands the same stored cfg object back on every render, so each is parsed (and its padSpec built) once.
  const parsed = new WeakMap<object, PeriodCfg>();
  const cfgOf = (cfg: unknown): PeriodCfg => {
    if (cfg === null || typeof cfg !== "object") return module.configSchema.parse(cfg);
    const hit = parsed.get(cfg);
    if (hit !== undefined) return hit;
    const read = module.configSchema.parse(cfg);
    parsed.set(cfg, read);
    return read;
  };
  const specs = new WeakMap<PeriodCfg, PadSpec>();
  const specOf = (cfg: PeriodCfg): PadSpec => {
    const hit = specs.get(cfg);
    if (hit !== undefined) return hit;
    const built = buildSpec(cfg);
    specs.set(cfg, built);
    return built;
  };

  // The static catalogue: every class the schema default or any declared variant names, first-declared order.
  const declared = [module.configSchema.parse({}), ...Object.values(module.variants).map((v) => module.configSchema.parse(v))];
  const classKeys = [...new Set(declared.flatMap((cfg) => Object.keys(cfg.suspensions?.classes ?? {})))];

  const suffixOf = (eventType: string): PeriodEventSuffix => {
    const suffix = eventType.startsWith(`${key}.`) ? eventType.slice(key.length + 1) : null;
    if (suffix === null || !Object.hasOwn(EVENT_PHASES, suffix)) {
      throw new Error(`${key}PadRules.eventAllowedInPhase: "${eventType}" is not one of the ${key} module's own event types`);
    }
    return suffix as PeriodEventSuffix;
  };

  return {
    eventBands: specOf(cfgOf({})).fidelity,
    suspensionReasons: facts.reasons,
    suspensionClassKeys: classKeys,
    goalKindRequired: facts.goalKindRequired,
    assistsMax: PERIOD_ASSISTS_MAX,
    swapBand: PERIOD_SWAP_BAND,
    suspensionMinutes: (cfg) => ({ ...periodSuspensionMinutesBound(cfgOf(cfg)), fallback: PERIOD_SUSPENSION_MINUTES_FALLBACK }),
    suspensionClasses: (cfg) => {
      const field = padFieldOf(specOf(cfgOf(cfg)), `${key}.suspension.start`, "class");
      if (field === undefined) return [];
      if (field.kind !== "enum") throw new Error(`${key}PadRules.suspensionClasses: padSpec's class field is a ${field.kind}, not an enum`);
      return field.values;
    },
    goalKinds: (cfg) => padEnumValues(specOf(cfgOf(cfg)), `${key}.goal`, "kind"),
    eventAllowedInPhase: (eventType, phase, cfg) => periodEventAllowedInPhase(suffixOf(eventType), phase, cfgOf(cfg)),
  };
}

export const hockeyPadRules: PeriodPadRules = periodPadRules(hockey, {
  reasons: HOCKEY_SUSPENSION_REASONS,
  goalKindRequired: HOCKEY_GOAL_KIND_REQUIRED,
});

export const icehockeyPadRules: PeriodPadRules = periodPadRules(icehockey, {
  reasons: ICEHOCKEY_SUSPENSION_REASONS,
  goalKindRequired: ICEHOCKEY_GOAL_KIND_REQUIRED,
});
