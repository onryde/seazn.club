// The 4-step division builder's pure decisions (Match Day C9, owner 2026-11-02): Who plays / Format / Division rules /
// Review. The component (components/v2/division-builder.tsx) holds the state; what it opens at, what it sends and where
// a refusal lands are decided here, so they can be tested without a DOM.
import type { EntrantKind } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { STAGE_TEMPLATES, type TemplateKnobs } from "@/lib/format-templates";
import { PAIR_MINTING_STAGE_KINDS } from "@/lib/chess-individual-only-rule";
import { swissRoundsDefault } from "@/lib/swiss-rounds";
import { estimateMinutes, estimateTemplate, type FormatEstimate } from "./format-estimate";

export const BUILDER_STEPS = ["who", "format", "rules", "review"] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

/** The sport's entrant model as the engine declares it (`effectiveEntrantModel(module.entrantModel, null)`). */
export interface EntrantChoice {
  kinds: readonly EntrantKind[];
  defaultKind: EntrantKind;
}

/**
 * `config.entrants` for the kind shown on Who plays: the division takes that kind alone, and it is the default (owner
 * rulings 2026-11-03, C9 Q3 and then n3 "yes": the kind shown NARROWS the division ALWAYS - picked, clicked or left at the
 * sport's default). A "Teams" division takes teams; an untouched badminton division takes individual players. Settings
 * can widen it later.
 */
export function entrantsConfigFor(model: EntrantChoice, chosen: EntrantKind): { kinds: EntrantKind[]; defaultKind: EntrantKind } {
  if (!model.kinds.includes(chosen)) throw new Error(`entrant kind '${chosen}' is not allowed (${model.kinds.join(", ")})`);
  return { kinds: [chosen], defaultKind: chosen };
}

/** The kinds the division will take, as Create sends them: the one shown (Q3, n3), else - none shown, or one the sport
 *  does not allow - every kind the sport allows. */
export function divisionEntrantKinds(model: EntrantChoice, chosen: EntrantKind | null): readonly EntrantKind[] {
  if (chosen === null || !model.kinds.includes(chosen)) return model.kinds;
  return entrantsConfigFor(model, chosen).kinds;
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

/** How many cards a collapsed picker shows; its Show more tile is the next grid cell (C9 R2, owner 2026-11-03: "show 5
 *  format and then 6th one as a show more", and the Sport picker "similar"). Both the Format and the Sport pickers. */
export const SUGGESTED_COUNT = 5;

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

/** The plan the Format step opens at (entrants, places played at once, hours): the boxes' first values, and the plan the
 *  opening format is picked for. The match length is the sport's own default. */
export const OPENING_PLAN = { entrants: 16, venues: 2, hours: 4 } as const;

/** The knobs every card is ranked at: the builder's opening knobs for a field of `entrants`. */
export function openingKnobs(entrants: number): TemplateKnobs {
  return { qualified: 4, swissRounds: swissRoundsDefault(entrants), poolCount: 2, legs: 1 };
}

/**
 * The format the builder OPENS on (owner ruling 2026-11-03, C9 Q5): the suggester's first for the sport at the opening
 * plan - skipping a format the division's entrant kinds cannot play (divisionPlaysTemplate: Americano rotates individual
 * players into pairs, so a division narrowed to pairs or teams opens on the first format it CAN play) and a format the
 * organisation's plan locks (`locked`, the page's templateLocks keys: a Community plan lacks formats.advanced, so it never
 * opens on a locked Americano that Next would refuse). With nothing ranked passing both, League (C9 review 2, n4: never
 * the offer's first, which is then unplayable or locked by construction).
 */
export function openingTemplate(offered: readonly string[], matchMinutes: number, entrantKinds: readonly string[], locked: readonly string[]): string {
  const playable = (key: string) =>
    STAGE_TEMPLATES.some((x) => x.key === key) && !locked.includes(key) && divisionPlaysTemplate(key, entrantKinds);
  const ranked = rankTemplates(offered, { ...OPENING_PLAN, matchMinutes }, openingKnobs(OPENING_PLAN.entrants));
  return ranked.find((r) => playable(r.key))?.key ?? "league";
}

/** The top SUGGESTED_COUNT of the ranking (the suggester's own, before the picker's order is laid over it). */
export function suggestTemplates(offered: readonly string[], plan: PlanInput, knobs: TemplateKnobs): string[] {
  return rankTemplates(offered, plan, knobs)
    .slice(0, SUGGESTED_COUNT)
    .map((r) => r.key);
}

/** What a collapsed picker (Format or Sport) shows: the first SUGGESTED_COUNT of its order, and the one picked never
 *  folded away - outside them, it takes the last of those slots (C9 R2). A pick the order does not hold (a format the
 *  sport no longer offers) is not shown. */
export function collapsedPicks(order: readonly string[], picked: string | null): string[] {
  const head = order.slice(0, SUGGESTED_COUNT);
  if (picked === null || head.includes(picked) || !order.includes(picked)) return head;
  return [...order.slice(0, SUGGESTED_COUNT - 1), picked];
}

/** A partner-rotation format (Americano, Mexicano): one whose stages mint pair entrants (PAIR_MINTING_STAGE_KINDS). */
export function isPairRotationTemplate(key: string): boolean {
  const t = STAGE_TEMPLATES.find((x) => x.key === key);
  return t !== undefined && t.build(openingKnobs(OPENING_PLAN.entrants)).some((s) => PAIR_MINTING_STAGE_KINDS.includes(s.kind));
}

/** The entrant kind a partner-rotation format needs the DIVISION to take (C9 review 2, N1): Americano and Mexicano rotate
 *  individual players into new pairs (stages.ts americanoGen plays one person per entrant, pairEntrantsFor mints the
 *  pairs), so a division that takes no individual players - narrowed to Pairs or Teams on Who plays (Q3, n3) - cannot
 *  play them. What the SPORT is offered is decided upstream, by its engine model (templatesForSport): this narrows that
 *  offer to the division's kinds. */
export const PAIR_ROTATION_NEEDS_KIND: EntrantKind = "individual";

/** Can a division taking these kinds play this format? Only a partner-rotation format needs a kind. */
export function divisionPlaysTemplate(key: string, divisionKinds: readonly string[]): boolean {
  return !isPairRotationTemplate(key) || divisionKinds.includes(PAIR_ROTATION_NEEDS_KIND);
}

/** The Format step's offer for the division: the sport's offer, less what the division's kinds cannot play (N1). The
 *  cards, the ranking, the suggested five, the opening and Next all read this one list. */
export function divisionFormatOffer(sportOffer: readonly string[], divisionKinds: readonly string[]): string[] {
  return sportOffer.filter((key) => divisionPlaysTemplate(key, divisionKinds));
}

/** The picked card after the organiser changes the sport or the kind (C9 review 2, n1 and N1): kept while the division
 *  is still offered it, else dropped - null, so the opening format (openingTemplate) applies again rather than a picked
 *  League the suggester would not have opened on. */
export function pickAfterChange(picked: string | null, offer: readonly string[]): string | null {
  return picked !== null && offer.includes(picked) ? picked : null;
}

/** The Format picker's order (owner 2026-11-03, C9 R2: "Americano, Mexicano always show in bottom"): the ranking, with
 *  the partner-rotation formats after every other; each side keeps the ranking's order. */
export function formatPickerOrder(ranked: readonly string[]): string[] {
  return [...ranked.filter((k) => !isPairRotationTemplate(k)), ...ranked.filter((k) => isPairRotationTemplate(k))];
}

/** The owner's popular sports, in his order (C9 R2, 2026-11-03): after the organisation's own, before the rest. */
export const POPULAR_SPORTS: readonly string[] = Object.freeze(["football", "cricket", "badminton", "tennis", "tabletennis"]);
/** The catch-all sport: always the Sport picker's last tile, named "Any other game" there (and only there). */
export const CATCH_ALL_SPORT = "generic";

/**
 * The Sport picker's order (C9 R2): the sports this organisation has run divisions in, most recent first (`recent`, the
 * page's one query); then the popular five; then the rest in the engine registry's order; then any listed sport the
 * registry does not ship, in the page's order; the catch-all last. Only listed sports (`keys`) appear, each once.
 */
export function sportPickerOrder(keys: readonly string[], recent: readonly string[], registry: readonly string[] = builtinModules.map((m) => m.key)): string[] {
  const listed = new Set(keys);
  const out: string[] = [];
  const add = (k: string) => {
    if (listed.has(k) && k !== CATCH_ALL_SPORT && !out.includes(k)) out.push(k);
  };
  for (const k of recent) add(k);
  for (const k of POPULAR_SPORTS) add(k);
  for (const k of registry) add(k);
  for (const k of keys) add(k);
  if (listed.has(CATCH_ALL_SPORT)) out.push(CATCH_ALL_SPORT);
  return out;
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
