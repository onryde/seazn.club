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
//  * (W2c X-PT-1) each fixture's played fact, from its ledger under the same
//    module (`qualificationFixtures`), so a stage rule's awarded score lands in
//    the what-if exactly where the standings fold wrote it. Without the module
//    that fact is unknowable, so a retired build gives no view at all — under a
//    stage PointsRule too, whose bounds would otherwise stand in for the
//    module's (no status beats a wrong one, R3);
//
// and, per table, the stage's V414 meta and the pool the SNAPSHOT is for.
import type { StandingsRow } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { forfeitPlayedFacts, playedFor } from "@/server/engine-db/forfeit-played";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import {
  buildQualificationView,
  divisionAwardAddsToLedger,
  divisionPointsBounds,
  pointsRuleScoresForfeits,
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

/**
 * W2c X-PT-1 — the division's fixtures as the qualification view reads them: each with its `played` fact, the one the
 * standings fold hands `applyPointsRule` (`engine-db/forfeit-played.ts`), read exactly where the view reads it
 * (`ruleScoreReaches`): under a stage rule that scores forfeits (`pointsRuleScoresForfeits`), for a two-seated
 * forfeit. One read of those fixtures' ledgers, and none otherwise — a division with no such stage rule (nearly all)
 * costs nothing, and a bye (one seat) has no ledger to read: nothing played. Where it is not read `played` is false:
 * with no scoring rule `ruleScoreReaches` answers before it, and without the module `divisionQualification` builds no
 * view at all.
 */
export async function qualificationFixtures<F extends Omit<QualFixture, "played">>(
  fixtures: readonly F[],
  module_: AnySportModule | null | undefined,
  stages: readonly { points_rule: unknown }[],
): Promise<(F & { played: boolean })[]> {
  if (!module_ || !stages.some((s) => pointsRuleScoresForfeits(s.points_rule))) return fixtures.map((f) => ({ ...f, played: false }));
  const seated = (f: F) => f.home_entrant_id !== null && f.away_entrant_id !== null;
  const facts = await forfeitPlayedFacts(sql, fixtures.filter(seated), module_);
  return fixtures.map((f) => ({ ...f, played: seated(f) ? playedFor(f, facts) : false }));
}

export function divisionQualification(
  i: DivisionQualificationInput,
): (stage: QualStage, snap: QualSnapshot) => QualificationView | null {
  // A retired build: no bounds, and no played facts for a stage rule's awarded score (see the header).
  if (!i.module_) return () => null;
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
