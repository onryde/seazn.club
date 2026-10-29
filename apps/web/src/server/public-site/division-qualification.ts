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
//    that fact is unknowable, so a retired build gives no view for a stage
//    whose rule scores forfeits, though its bounds would otherwise stand in for
//    the module's (no status beats a wrong one, R3); every other stage builds
//    as before (fix round 1 M-2);
//
// and, per table, the stage's V414 meta, the pool the SNAPSHOT is for, and (W2d Task 9) the stage's TABLE RULES — its
// order, the rule it is paid by and the outcomes it reaches — from the one loader (`stageTableRulesDocs`, carried on the
// stage as `table_rules`): the order it is ranked by is its pin (or its live layers while pending), never the division's
// order or the sport's default re-read here, and the per-match bounds are that rule's over those outcomes
// (`pointsRuleBounds`). A stage the loader could not read carries none: no status (R3).
import type { StandingsRow } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { forfeitPlayedFacts, playedFor } from "@/server/engine-db/forfeit-played";
import type { AnySportModule } from "@seazn/engine/sport";
import type { StageTableRulesDoc } from "@/server/engine-db/table-rules";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import {
  buildQualificationView,
  divisionAwardAddsToLedger,
  pointsRuleScoresForfeits,
  stageQualMeta,
  type QualFixture,
  type QualificationView,
} from "./qualification-view";

/** A stage as the public views and the console read it: its id and kind, the
 *  V414 columns `stageQualMeta` maps, and (W2d T9) its table rules from the one
 *  loader — absent or null when the loader refused the stage (no status). */
export type QualStage = { id: string; kind: string; table_rules?: StageTableRulesDoc | null } & Parameters<typeof stageQualMeta>[0];

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
}

/**
 * W2c X-PT-1 — the division's fixtures as the qualification view reads them: each with its `played` fact, the one the
 * standings fold hands `payout` (`engine-db/forfeit-played.ts`), read exactly where the view reads it
 * (`ruleScoreReaches`): under a stage rule that scores forfeits (`pointsRuleScoresForfeits`), for a two-seated
 * forfeit. One read of those fixtures' ledgers, and none otherwise — a division with no such stage rule (nearly all)
 * costs nothing, and a bye (one seat) has no ledger to read: nothing played. Where it is not read `played` is false:
 * with no scoring rule `ruleScoreReaches` answers before it, and without the module `divisionQualification` builds no
 * view at all.
 */
export async function qualificationFixtures<F extends Omit<QualFixture, "played">>(
  fixtures: readonly F[],
  module_: AnySportModule | null | undefined,
  stages: readonly { readonly table_rules?: { readonly points: unknown } | null }[],
): Promise<(F & { played: boolean })[]> {
  // W2d T9 (T7 carry): the rule each stage's table is PAID by (the loader's), never its own rule.
  if (!module_ || !stages.some((s) => pointsRuleScoresForfeits(s.table_rules?.points))) return fixtures.map((f) => ({ ...f, played: false }));
  const seated = (f: F) => f.home_entrant_id !== null && f.away_entrant_id !== null;
  const facts = await forfeitPlayedFacts(sql, fixtures.filter(seated), module_);
  return fixtures.map((f) => ({ ...f, played: seated(f) ? playedFor(f, facts) : false }));
}

export function divisionQualification(
  i: DivisionQualificationInput,
): (stage: QualStage, snap: QualSnapshot) => QualificationView | null {
  const awardAddsToLedger = divisionAwardAddsToLedger(i.module_, i.division.config);
  const msg = (key: TKey, vars?: Record<string, string | number>) => t(i.dict, key, vars);
  const pluralMsg = (key: string, count: number, vars?: Record<string, string | number>) =>
    plural(i.dict, key, count, i.locale, vars);
  return (stage, snap) => {
    // W2d T9: the stage's own table rules, or no status — never a guessed order (R3).
    const rules = stage.table_rules;
    if (rules === undefined || rules === null) return null;
    // A retired build has no played facts, so a stage rule's awarded score cannot be placed (see the header): no view for
    // a stage whose rule scores forfeits. Any other stage builds — the rule's own bounds are the bounds (fix round 1 M-2).
    if (!i.module_ && pointsRuleScoresForfeits(rules.points)) return null;
    return buildQualificationView({
      // The rule in force: one authority, the loader (no SQL column publishes it — T9 review m3).
      stage: { id: stage.id, kind: stage.kind, meta: { ...stageQualMeta(stage), tablePointsRule: rules.points } },
      poolId: snap.pool_id ?? null,
      rows: snap.rows,
      fixtures: i.fixtures,
      entrantStatuses: i.entrantStatuses,
      // every stage has a rule in force since W2d, so the sport's own bounds never stand in for it
      bounds: null,
      reachable: new Set(rules.reachable),
      primary: rules.primary,
      ...(rules.ballsPerOver === undefined ? {} : { ballsPerOver: rules.ballsPerOver }),
      awardAddsToLedger,
      cascade: rules.tiebreakers,
      entrantNames: i.entrantNames,
      msg,
      plural: pluralMsg,
    });
  };
}
