// The choice an any-sport gallery template asks for (W5 X-BD-3): sport, variant, entrant kind, field size. Pure and
// client-safe (the detail sheet is a client island); `server/templates/resolve.ts` turns the choice into the template the
// sheet describes and the create builds, so this file holds only the sheet's state transitions.
import type { SportOption } from "@/components/v2/division-builder";
import { entrantKindAfterSportChange, type EntrantChoice } from "@/lib/division-builder/model";
import { pickVariant } from "@/lib/preferred-variant";
import type { TemplateDivision } from "@/server/templates/schema";
import type { TemplateChoice } from "@/server/templates/resolve";

type Kind = EntrantChoice["defaultKind"];

export interface ChoiceState {
  sportKey: string;
  variantKey: string;
  kind: Kind;
  count: number;
  /** The organiser has picked a kind themselves: a later sport change keeps it where the new sport allows it. */
  kindTouched: boolean;
}

/** The sports a template can be created on: the page resolved the sport's entrant model and it has a variant to start on.
 *  A sport with no model passed cannot say which kinds it plays, and the create would refuse it. */
export function choosableSports(sports: readonly SportOption[]): SportOption[] {
  return sports.filter((s) => s.entrants !== undefined && s.variants.length > 0);
}

/** The sheet's first state: the first choosable sport on its starting variant and its own default kind, the template's
 *  default count. Null when no sport can be chosen (nothing to build on). */
export function initialChoice(division: Pick<TemplateDivision, "entrantCount">, sports: readonly SportOption[]): ChoiceState | null {
  const first = choosableSports(sports)[0];
  if (first === undefined) return null;
  return {
    sportKey: first.key,
    variantKey: pickVariant(first.key, first.variants),
    kind: first.entrants!.defaultKind,
    count: division.entrantCount,
    kindTouched: false,
  };
}

/** The organiser picks another sport: its starting variant, and the kind per the builder's own rule
 *  (`entrantKindAfterSportChange`). An unknown key leaves the state as it was. */
export function pickSport(state: ChoiceState, sportKey: string, sports: readonly SportOption[]): ChoiceState {
  const next = choosableSports(sports).find((s) => s.key === sportKey);
  if (next === undefined) return state;
  return {
    ...state,
    sportKey,
    variantKey: pickVariant(next.key, next.variants),
    kind: entrantKindAfterSportChange(state.kind, state.kindTouched, next.entrants!),
  };
}

export const pickVariantKey = (state: ChoiceState, variantKey: string): ChoiceState => ({ ...state, variantKey });
export const pickKind = (state: ChoiceState, kind: Kind): ChoiceState => ({ ...state, kind, kindTouched: true });
export const pickCount = (state: ChoiceState, count: number): ChoiceState => ({ ...state, count });

/** The state as `resolveTemplate` takes it. */
export function toChoice(state: ChoiceState): TemplateChoice {
  return { sportKey: state.sportKey, variantKey: state.variantKey, entrantKind: state.kind, entrantCount: state.count };
}

/** The state as the from-template POST takes it. */
export function choiceBody(state: ChoiceState): { sport_key: string; variant_key: string; entrant_kind: Kind; entrant_count: number } {
  return { sport_key: state.sportKey, variant_key: state.variantKey, entrant_kind: state.kind, entrant_count: state.count };
}

/** The from-template POST body: the sheet's name and dates, and, for an any-sport template, the choice (all four fields; a
 *  fixed template sends none, so its request is what it was before X-BD-3). */
export function templateRequestBody(input: {
  template: { key: string; version: number };
  name: string;
  startsOn: string;
  endsOn: string;
  choice: ChoiceState | null;
}) {
  return {
    template_key: input.template.key,
    template_version: input.template.version,
    name: input.name,
    starts_on: input.startsOn || null,
    ends_on: input.endsOn,
    ...(input.choice ? choiceBody(input.choice) : {}),
  };
}
