// W5 Task 11 (X-CUT-4 <- RB5-K6; FX-G16's table half) - "a correction after the knockout started: the bracket stands, the desk
// warns", for a completed LEAGUE or GROUP. The Swiss (swiss-cut-drift.ts) and the knockout (knockout-cut-drift.ts) have said it
// since W3 and W4; this is the same sentence for the third kind of source, read through the same rule (`swissCutDrift`: who is
// out, who is in, the same null cases) so there is one meaning of "a cut moved".
//
// Pure and client-safe (no `server-only`): the usecase (`server/usecases/table-cut-drift.ts`) judges WHO the corrected table's
// cut moved and the stages panel says it, and `apps/web` vitest has no DOM, so what the warning decides and says lives here.
import { swissCutDrift, type SwissCutDrift } from "./swiss-cut-drift";

/** Who the cut moved: `out` holds a seat from the frozen cut and would not make today's; `in` would make it and holds none. */
export type TableCutDrift = SwissCutDrift;

/** The drift between the cut the destination was seeded from and today's (see `swissCutDrift` for its null cases). */
export const tableCutDrift = swissCutDrift;

/** The source kinds this warning belongs to: the two round-robin tables. A Swiss has its own (`swissCutDriftOf`), a knockout
 *  its own (`knockoutCutDriftOf`); one card never carries two. */
export const TABLE_CUT_DRIFT_KINDS: ReadonlySet<string> = new Set(["league", "group"]);

/**
 * The drift this stage's card warns about, or null - THE one predicate for "does this card carry the warning?". The card draws
 * the notice from it (`stages-panel.tsx`) and the division page lists the same stages as needing attention
 * (`tableCutDriftStageIds`), so a completed card (which starts folded) opens exactly when it carries one. Only an organiser's
 * league or group.
 */
export function tableCutDriftOf(
  stage: { id: string; kind: string },
  canEdit: boolean,
  drifts: Readonly<Record<string, TableCutDrift>> | undefined,
): TableCutDrift | null {
  if (!canEdit || !TABLE_CUT_DRIFT_KINDS.has(stage.kind)) return null;
  return drifts?.[stage.id] ?? null;
}

/** The ids of the stages whose card carries the warning, in the order handed in. */
export function tableCutDriftStageIds(
  stages: readonly { id: string; kind: string }[],
  canEdit: boolean,
  drifts: Readonly<Record<string, TableCutDrift>> | undefined,
): string[] {
  return stages.filter((s) => tableCutDriftOf(s, canEdit, drifts) !== null).map((s) => s.id);
}

/** The plural base (`.one` / `.other` in every locale). The count is the number who come in: the verb agrees with them. */
export const TABLE_CUT_DRIFT_PLURAL_KEY = "table.cutDrift.warning" as const;

/** The i18n surface the sentence needs; `useMsgPlural` satisfies it. */
export type TableCutDriftI18n = (key: string, count: number, vars?: Record<string, string | number>) => string;

/** The warning, in the reader's language: both lists are entrant DISPLAY NAMES (an id missing from `names` reads "?", as every
 *  other desk line does), joined with the locale's own conjunction. */
export function tableCutDriftText(
  drift: TableCutDrift,
  names: Readonly<Record<string, string>>,
  locale: string,
  plural: TableCutDriftI18n,
): string {
  const list = (ids: readonly string[]): string =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(ids.map((id) => names[id] ?? "?"));
  return plural(TABLE_CUT_DRIFT_PLURAL_KEY, drift.in.length, { in: list(drift.in), out: list(drift.out) });
}
