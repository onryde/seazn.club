// The 4-step division builder's pure decisions (Match Day C9, owner 2026-11-02): Who plays / Format / Division rules /
// Review. The component (components/v2/division-builder.tsx) holds the state; what it opens at, what it sends and where
// a refusal lands are decided here, so they can be tested without a DOM.
import type { EntrantKind } from "@seazn/engine/sport";
import type { TemplateKnobs } from "@/lib/format-templates";
import { estimateMinutes, estimateTemplate, type FormatEstimate } from "./format-estimate";

export const BUILDER_STEPS = ["who", "format", "rules", "review"] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

/** The sport's entrant model as the engine declares it (`effectiveEntrantModel(module.entrantModel, null)`). */
export interface EntrantChoice {
  kinds: readonly EntrantKind[];
  defaultKind: EntrantKind;
}

/**
 * `config.entrants` for the kind picked on Who plays. Nothing at the sport's own default, so a division created without
 * touching it stores exactly what it did before the builder asked (the Entrants tab then shows "Using the sport's
 * default"). Another kind is sent as the default kind with every kind the sport allows kept: the builder asks which
 * kind enters, it does not narrow what the Entrants tab may add later.
 */
export function entrantsConfigFor(model: EntrantChoice, chosen: EntrantKind): { kinds: EntrantKind[]; defaultKind: EntrantKind } | undefined {
  if (!model.kinds.includes(chosen)) throw new Error(`entrant kind '${chosen}' is not allowed (${model.kinds.join(", ")})`);
  if (chosen === model.defaultKind) return undefined;
  return { kinds: [...model.kinds], defaultKind: chosen };
}

/** The kind after the organiser picks another sport. A kind they never touched follows the sport (it was the old
 *  sport's default, not a choice); a chosen one is kept when the new sport allows it. */
export function entrantKindAfterSportChange(chosen: EntrantKind, touched: boolean, next: EntrantChoice): EntrantKind {
  return touched && next.kinds.includes(chosen) ? chosen : next.defaultKind;
}

/** The plan the Format step's estimates are worked out for (builder-only: nothing here is sent). */
export interface PlanInput {
  entrants: number;
  /** Courts, tables, boards or pitches played on at once. */
  venues: number;
  hours: number;
  matchMinutes: number;
}

export interface RankedTemplate {
  key: string;
  estimate: FormatEstimate;
  minutes: number | null;
  fits: boolean;
}

export const SUGGESTED_COUNT = 4;

/** Every offered template, best first for the plan: formats with a fixed draw before those without (a ladder has no
 *  clock to budget); among them those that fit the time first; of those, the one that guarantees everyone the most
 *  matches, then the fewest matches; of those that do not fit, the least overrun. Ties keep the offer's order. */
export function rankTemplates(offered: readonly string[], plan: PlanInput, knobs: TemplateKnobs): RankedTemplate[] {
  const budget = plan.hours * 60;
  const rows = offered.map((key, i) => {
    const estimate = estimateTemplate(key, plan.entrants, knobs);
    const minutes = estimateMinutes(estimate, plan.venues, plan.matchMinutes);
    return { key, estimate, minutes, fits: minutes !== null && minutes <= budget, i };
  });
  rows.sort((a, b) => {
    const drawA = a.minutes !== null;
    const drawB = b.minutes !== null;
    if (drawA !== drawB) return drawA ? -1 : 1;
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (a.fits) {
      const games = (b.estimate.minGames ?? 0) - (a.estimate.minGames ?? 0);
      if (games !== 0) return games;
      const matches = (a.estimate.matches ?? 0) - (b.estimate.matches ?? 0);
      if (matches !== 0) return matches;
    } else if (drawA) {
      const over = a.minutes! - b.minutes!;
      if (over !== 0) return over;
    }
    return a.i - b.i;
  });
  return rows.map((r) => ({ key: r.key, estimate: r.estimate, minutes: r.minutes, fits: r.fits }));
}

/** The four the Format step shows before "Show all". */
export function suggestTemplates(offered: readonly string[], plan: PlanInput, knobs: TemplateKnobs): string[] {
  return rankTemplates(offered, plan, knobs)
    .slice(0, SUGGESTED_COUNT)
    .map((r) => r.key);
}

/** The earliest step (in step order) holding a problem, or null when every step is clear. */
export function firstBlockedStep(problems: Partial<Record<BuilderStep, string | null>>): BuilderStep | null {
  return BUILDER_STEPS.find((s) => typeof problems[s] === "string") ?? null;
}

/** Fields of the create body that the Who plays step holds. */
const WHO_FIELDS = new Set(["name", "sport_key", "category", "age_min", "age_max", "age_cutoff_month", "age_cutoff_day", "eligibility_note"]);
/** Fields the Division rules step holds. */
const RULE_FIELDS = new Set(["config", "tiebreakers", "variant_key"]);
/** Refusals of the match rules, online play and tie-breaks (createDivision's write doors). */
const RULE_CODES = new Set(["CONFIG_INVALID", "INVALID_TIME_CONTROL", "ONLINE_PLAY_INVALID", "ONLINE_PLAY_SPORT", "ONLINE_CHESS_DISABLED"]);

/** The step a create refusal belongs to, so it is shown beside what caused it. The stages POST is the Format step's;
 *  the division POST's refusals are placed by their code or the field their issues name; anything else (a quota, a
 *  finished competition) stays on Review, where Create is. */
export function stepForCreateError(
  phase: "division" | "stages",
  err: { code?: string; extra?: Record<string, unknown> },
): BuilderStep {
  if (phase === "stages") return "format";
  if (err.code === "CHESS_INDIVIDUAL_ONLY") return "who";
  const issues = Array.isArray(err.extra?.issues) ? (err.extra!.issues as { path?: unknown }[]) : [];
  const heads = issues.map((i) => (Array.isArray(i?.path) ? String(i.path[0]) : ""));
  if (heads.some((h) => WHO_FIELDS.has(h))) return "who";
  if (heads.some((h) => RULE_FIELDS.has(h)) || (err.code !== undefined && RULE_CODES.has(err.code))) return "rules";
  return "review";
}
