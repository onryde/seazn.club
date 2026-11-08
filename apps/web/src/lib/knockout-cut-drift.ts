// W4 T14 (X-QM-4, RB4-Q5, signed S3: W3 RB3-19 by analogy) — "a correction after the main draw started: the bracket stands,
// the desk warns."
//
// Pure and client-safe (no `server-only`): the usecase (`server/usecases/knockout-cut-drift.ts`) judges WHO the corrected
// knockout's cut moved and the stages panel says it, and `apps/web` vitest has no DOM, so what the warning decides and says
// lives here, where a test can read it. The judgement is the Swiss one (who is out, who is in, the same null cases), read
// through `swissCutDrift`: one rule for "a cut moved", two stage kinds.
import { swissCutDrift, type SwissCutDrift } from "./swiss-cut-drift";

/** Who the cut moved: `out` holds a seat from the frozen cut and would not make today's; `in` would make it and holds none. */
export type KnockoutCutDrift = SwissCutDrift;

/** The drift between the cut the destination was seeded from and today's (see `swissCutDrift` for its null cases). */
export const knockoutCutDrift = swissCutDrift;

/**
 * The drift this stage's card warns about, or null — THE one predicate for "does this card carry the warning?". The card
 * draws the notice from it (`stages-panel.tsx`) and the division page lists the same stages as needing attention
 * (`knockoutCutDriftStageIds`), so PB1's fold opens exactly the cards that carry it. Only an organiser's knockout.
 */
export function knockoutCutDriftOf(
  stage: { id: string; kind: string },
  canEdit: boolean,
  drifts: Readonly<Record<string, KnockoutCutDrift>> | undefined,
): KnockoutCutDrift | null {
  if (!canEdit || stage.kind !== "knockout") return null;
  return drifts?.[stage.id] ?? null;
}

/** The ids of the stages whose card carries the warning, in the order handed in. */
export function knockoutCutDriftStageIds(
  stages: readonly { id: string; kind: string }[],
  canEdit: boolean,
  drifts: Readonly<Record<string, KnockoutCutDrift>> | undefined,
): string[] {
  return stages.filter((s) => knockoutCutDriftOf(s, canEdit, drifts) !== null).map((s) => s.id);
}

/** The plural base (`.one` / `.other` in every locale). The count is the number who come in: the verb agrees with them. */
export const KNOCKOUT_CUT_DRIFT_PLURAL_KEY = "knockout.cutDrift.warning" as const;

/** The i18n surface the sentence needs; `useMsgPlural` satisfies it. */
export type KnockoutCutDriftI18n = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** The warning, in the reader's language: both lists are entrant DISPLAY NAMES (an id missing from `names` reads "?", as every
 *  other desk line does), joined with the locale's own conjunction. */
export function knockoutCutDriftText(
  drift: KnockoutCutDrift,
  names: Readonly<Record<string, string>>,
  locale: string,
  plural: KnockoutCutDriftI18n,
): string {
  const list = (ids: readonly string[]): string =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(ids.map((id) => names[id] ?? "?"));
  return plural(KNOCKOUT_CUT_DRIFT_PLURAL_KEY, drift.in.length, { in: list(drift.in), out: list(drift.out) });
}
