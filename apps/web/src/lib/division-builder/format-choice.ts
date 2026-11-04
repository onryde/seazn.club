// FMT5 (owner-approved mock, 2026-11-03): the format choice, one model for the two screens that make it — the new-division
// builder's Format step (Match Day C9) and the Format dialog on the Fixtures tab's Division rules card, which replaces
// Settings › Format. Both render `formatPickerFields` (components/v2/format-picker.tsx) over this file, so the cards, their
// order, the knobs each format shows, the stages it builds and the bounds a knob is judged by cannot drift apart.
//
// Pure: the picker's state lives in the screen (`useFormatKnobs`), the derivations here.
import { FORMAT_BOUNDS, type FormatBoundKey, withinFormatBounds } from "@/lib/format-bounds";
import {
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  detectTemplate,
  templateHasProgression,
  type StageDraft,
  type StandingsCarry,
} from "@/lib/format-templates";
import type { MessageKey } from "@/lib/messages";
import { estimateMinutes, estimateStages, type FormatEstimate } from "./format-estimate";
import { collapsedPicks, formatPickerOrder, openingKnobs, rankTemplates, SUGGESTED_COUNT, type PlanInput, type RankedTemplate } from "./model";

/** The format knobs as the picker holds them: what the organiser typed, unclamped (a cleared box reads 0). */
export interface FormatKnobValues {
  qualified: number;
  swissRounds: number;
  poolCount: number;
  legs: number;
  standingsCarry: StandingsCarry;
}

/** Which knobs a format shows. The picker renders exactly these, and `formatBoundIssue` / `formatStagesFor` read the same
 *  answer, so a knob is judged — and sent — exactly when it is on screen. */
export interface FormatKnobsShown {
  /** The Top N box: templates whose second stage is sized by `qualified`. ko_plate and qualifying_main read `qualified` too,
   *  at their own default of 4 (sent that, never the box); group_playoffs is a fixed four. */
  secondStage: boolean;
  pools: boolean;
  rounds: boolean;
  legs: boolean;
  /** The standings carry select: templates whose stages progress. */
  carry: boolean;
}

export function formatKnobsShown(template: string): FormatKnobsShown {
  return {
    secondStage: template === "league_ko" || template === "groups_ko" || template === "group_stepladder" || template === "swiss_knockout",
    pools: template === "groups_ko",
    rounds: template === "swiss" || template === "swiss_playoff" || template === "swiss_knockout",
    legs: template === "league" || template === "league_ko" || template === "groups_ko" || template === "group_stepladder",
    carry: templateHasProgression(template),
  };
}

/** The first VISIBLE number knob outside FORMAT_BOUNDS (pools, rounds, then Top N), with the label the picker shows it
 *  under, or null. The builder's Next and the dialog's Save both refuse on it before anything is sent. */
export function formatBoundIssue(
  template: string,
  knobs: Pick<FormatKnobValues, "qualified" | "swissRounds" | "poolCount">,
): { field: FormatBoundKey; label: MessageKey; min: number; max: number } | null {
  const shown = formatKnobsShown(template);
  const asked: [FormatBoundKey, number, MessageKey][] = [];
  if (shown.pools) asked.push(["pools", knobs.poolCount, "wizard.pools"]);
  if (shown.rounds) asked.push(["swissRounds", knobs.swissRounds, "wizard.rounds"]);
  if (shown.secondStage) asked.push(["qualify", knobs.qualified, "wizard.qualify"]);
  for (const [field, value, label] of asked) {
    if (!withinFormatBounds(field, value)) return { field, label, ...FORMAT_BOUNDS[field] };
  }
  return null;
}

/** The stage drafts a format sends. A cleared knob reads as Number("") === 0, so every number knob goes through the one
 *  clampKnob over FORMAT_BOUNDS; the Top N is read only where it is on screen, and a template that does not show it gets
 *  the templates' default 4. */
export function formatStagesFor(template: string, knobs: FormatKnobValues): StageDraft[] {
  const shown = formatKnobsShown(template);
  return applyStandingsCarry(
    buildTemplateStages(template, {
      qualified: shown.secondStage ? clampKnob(knobs.qualified, FORMAT_BOUNDS.qualify.min, FORMAT_BOUNDS.qualify.max) : 4,
      swissRounds: knobs.swissRounds,
      poolCount: clampKnob(knobs.poolCount, FORMAT_BOUNDS.pools.min, FORMAT_BOUNDS.pools.max),
      legs: knobs.legs,
    }),
    knobs.standingsCarry,
  );
}

/** What the picker shows for a plan: the cards in order, which are folded, each card's counts, and the picked format's. */
export interface FormatPickerView {
  /** Every offered card, ranked for the plan at the opening knobs (so the suggested five do not reshuffle while a knob
   *  moves). */
  ranked: RankedTemplate[];
  /** The cards in the picker's order: the ranking, Americano and Mexicano after every other (C9 R2). */
  pickerOrder: string[];
  /** The first SUGGESTED_COUNT of that order. */
  suggested: string[];
  /** Is this card folded away until Show more? The picked card never is. */
  folded: (key: string) => boolean;
  foldedCount: number;
  /** The picked format's counts at the knobs as they stand. */
  estimate: FormatEstimate;
  estimateMins: number | null;
  /** The plan feature the picked format needs and the organisation lacks. */
  templateLock: string | undefined;
  /** A carry is picked that the plan does not include. */
  carryLocked: boolean;
}

export function formatPickerView(input: {
  offer: readonly string[];
  plan: PlanInput;
  template: string;
  stages: StageDraft[];
  showAll: boolean;
  templateLocks: Readonly<Record<string, string>>;
  carryAllowed: boolean;
  standingsCarry: StandingsCarry;
}): FormatPickerView {
  const ranked = rankTemplates(input.offer, input.plan, openingKnobs(input.plan.entrants));
  const pickerOrder = formatPickerOrder(ranked.map((r) => r.key));
  const shownKeys = collapsedPicks(pickerOrder, input.template);
  const folded = (key: string) => !input.showAll && !shownKeys.includes(key);
  const estimate = estimateStages(input.stages, input.plan.entrants);
  return {
    ranked,
    pickerOrder,
    suggested: pickerOrder.slice(0, SUGGESTED_COUNT),
    folded,
    foldedCount: pickerOrder.filter(folded).length,
    estimate,
    estimateMins: estimateMinutes(estimate, input.plan.venues, input.plan.matchMinutes),
    templateLock: input.templateLocks[input.template],
    carryLocked: !input.carryAllowed && input.standingsCarry !== "none",
  };
}

/** A saved stage, as the dialog reads the division's current format from it. */
export interface SavedStage {
  kind: string;
  config?: Record<string, unknown> | null;
  progression: StageDraft["progression"];
}

/** Reverse-derives the "how many qualify" knob from a division's stored stages (moved from Settings › Format, FMT5).
 *
 *  F2 (unified progression field): reads the FIRST stage's `.progression`, matching whichever TakeRule kind
 *  format-templates.ts's real specs emit — rankRange -> to-from+1 (league_ko/group_stepladder/group_playoffs/
 *  qualifying_main), roundLosers -> count (ko_plate), picks -> picks.length (a hand-built custom graph only).
 *
 *  A3 (round-4 review): groups_ko emits topNPerGroup (+ a bestNth remainder), never picks. topNPerGroup -> n × the group
 *  stage's pool count (config.pools.count on the group stage the progression sources: the nearest earlier one — F3
 *  ultrareview finding 8, every template declares `stage: "previous"`); bestNth -> its count. Summed, because groups_ko
 *  carries BOTH in one take array. Falls back to 4. */
export function currentQualifiedFromStages(
  stages: readonly { kind?: string; config?: SavedStage["config"]; progression: SavedStage["progression"] }[],
): number {
  const stageIdx = stages.findIndex((st) => st.progression);
  const stage = stageIdx === -1 ? undefined : stages[stageIdx];
  const sources = (stage?.progression as { sources?: { take?: unknown[] }[] } | undefined)?.sources;
  const take = sources?.flatMap((s) => s.take ?? []) ?? [];
  const poolCount =
    (stages
      .slice(0, stageIdx === -1 ? 0 : stageIdx)
      .reverse()
      .find((st) => st.kind === "group")?.config as { pools?: { count?: number } } | undefined)?.pools?.count ?? 1;
  let total = 0;
  let matched = false;
  for (const t of take) {
    const rule = t as { kind?: string; from?: number; to?: number; count?: number; picks?: unknown[]; n?: number };
    if (rule.kind === "rankRange" && typeof rule.from === "number" && typeof rule.to === "number") {
      total += rule.to - rule.from + 1;
      matched = true;
    } else if (rule.kind === "picks" && Array.isArray(rule.picks)) {
      total += rule.picks.length;
      matched = true;
    } else if (rule.kind === "roundLosers" && typeof rule.count === "number") {
      total += rule.count;
      matched = true;
    } else if (rule.kind === "topNPerGroup" && typeof rule.n === "number") {
      total += rule.n * poolCount;
      matched = true;
    } else if (rule.kind === "bestNth" && typeof rule.count === "number") {
      total += rule.count;
      matched = true;
    }
  }
  return matched ? total : 4;
}

/** Reverse-derives the carry knob from stored progression stages. */
export function currentStandingsCarryFromStages(stages: { progression: StageDraft["progression"] }[]): StandingsCarry {
  for (const st of stages) {
    if (!st.progression) continue;
    const carry = st.progression.carry;
    if (carry === "points" || carry === "full") return carry;
  }
  return "none";
}

/** The picker's opening state for a division that already has stages: the format they are (`detectTemplate`; null for a
 *  custom graph or none) and its knobs as stored. `swissRounds` is null where no Swiss stage stores rounds, so the box
 *  follows the field's default until typed in. */
export function formatChoiceFromStages(stages: SavedStage[]): {
  template: string | null;
  qualified: number;
  poolCount: number;
  swissRounds: number | null;
  legs: number;
  standingsCarry: StandingsCarry;
} {
  const configOf = (kinds: readonly string[]) => stages.find((st) => kinds.includes(st.kind))?.config ?? null;
  const rounds = (configOf(["swiss"]) as { rounds?: unknown } | null)?.rounds;
  const legs = (configOf(["league", "group"]) as { legs?: unknown } | null)?.legs;
  const pools = (configOf(["group"]) as { pools?: { count?: unknown } } | null)?.pools?.count;
  return {
    template: stages.length === 0 ? null : detectTemplate(stages.map((st) => ({ ...st, config: st.config ?? null }))),
    qualified: currentQualifiedFromStages(stages),
    poolCount: typeof pools === "number" ? pools : 2,
    swissRounds: typeof rounds === "number" ? rounds : null,
    legs: typeof legs === "number" ? legs : 1,
    standingsCarry: currentStandingsCarryFromStages(stages),
  };
}
