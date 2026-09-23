import "server-only";
// Standings qualification status — the ONE place a standings surface turns
// what it already holds into a per-table `QualificationView` (spec 2026-09-22
// §4.2). The division page, the embed and the competition hub each assembled
// the builder's inputs by hand, the organiser console would have been a fourth
// copy, and the page's and the embed's pool wiring went untested (Task 7 fix
// round 1). Everything division-wide is derived ONCE here:
//
//  * the per-match bounds and whether a walkover writes goals, from the
//    division's PINNED module and its live cfg (a retired build gives no
//    bounds, so no status);
//  * every word, from the caller's dictionary in the caller's locale — the
//    public surfaces pass the org's (they are ISR: never the visitor's);
//
// and, per table, the stage's V414 meta and the pool the SNAPSHOT is for.
import type { StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import {
  buildQualificationView,
  divisionAwardAddsToLedger,
  divisionPointsBounds,
  stageQualMeta,
  type QualFixture,
  type QualificationView,
} from "./qualification-view";

/** A stage as the public views and the console read it: its id and kind, and
 *  the V414 columns `stageQualMeta` maps. */
export type QualStage = { id: string; kind: string } & Parameters<typeof stageQualMeta>[0];

/** One standings table: the stage's overall snapshot (`pool_id` null) or one
 *  pool's. */
export interface QualSnapshot {
  pool_id: string | null;
  rows: readonly StandingsRow[];
}

export interface DivisionQualificationInput {
  /** The division's PINNED module; null when its build is retired. */
  module_: AnySportModule | null | undefined;
  /** The division's live cfg (future matches score under it). */
  division: { config?: unknown };
  dict: Dict;
  locale: Locale;
  /** The division's fixtures, any stage — the builder filters. */
  fixtures: readonly QualFixture[];
  /** entrant id → entrants.status, every entrant in the division. */
  entrantStatuses: Readonly<Record<string, string>>;
  entrantNames: Readonly<Record<string, string>>;
  /** The cascade the table is ranked and captioned by. */
  cascade: readonly string[];
}

export function divisionQualification(
  i: DivisionQualificationInput,
): (stage: QualStage, snap: QualSnapshot) => QualificationView | null {
  const bounds = divisionPointsBounds(i.module_, i.division.config);
  const awardAddsToLedger = divisionAwardAddsToLedger(i.module_, i.division.config);
  const msg = (key: TKey, vars?: Record<string, string | number>) => t(i.dict, key, vars);
  const pluralMsg = (key: string, count: number, vars?: Record<string, string | number>) =>
    plural(i.dict, key, count, i.locale, vars);
  return (stage, snap) =>
    buildQualificationView({
      stage: { id: stage.id, kind: stage.kind, meta: stageQualMeta(stage) },
      poolId: snap.pool_id ?? null,
      rows: snap.rows,
      fixtures: i.fixtures,
      entrantStatuses: i.entrantStatuses,
      bounds,
      awardAddsToLedger,
      cascade: i.cascade,
      entrantNames: i.entrantNames,
      msg,
      plural: pluralMsg,
    });
}
