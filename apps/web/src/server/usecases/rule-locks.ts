import "server-only";
// W2c X-SR-4 — which rules a division save may not touch, and why, by name.
//
// The division's match format and table rules lock PER STARTED STAGE THAT INHERITS THEM (owner P-2 "A", 2026-10-13),
// not once any fixture exists. `replaceStages`' division-wide FORMAT_LOCKED is a different door and stays as it was
// (spec §4.3). Two things live here because two writers need them: the stage PUT (`stage-rules.ts`) asks only "has
// this stage started", the division PATCH (`divisions.ts`) asks "which started stages depend on the thing I am
// changing".
import type { Tx } from "@/lib/db";
import type { RefusedField } from "@/lib/rule-errors";
import { DRAW_KINDS, forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { deciderKeysFor, pointsKeysFor, type AnySportModule } from "@seazn/engine/sport";

/**
 * Division config keys that are TABLE rules (Q3); every other key is match format (Q4). Derived from the engine's own
 * declaration (plan D11): the sport's `points`-scope keys for this variant, plus `pointsMap`, named explicitly so the
 * set sports' points table stays a table rule even if a module version stops declaring it (the set kernel declares it
 * today). Ice hockey's `awardScore` is a points key, so it is a table rule; its `periods` is match format.
 */
export const tableRuleKeys = (module: AnySportModule, variant: string | null): ReadonlySet<string> =>
  new Set([...pointsKeysFor(module, null, variant), "pointsMap"]);

/**
 * The table keys a stage PointsRule REPLACES. `applyPointsRule` (engine competition/points.ts) re-derives `delta.points`
 * from the rule, and touches the ledger only on a forfeit with nothing played, where the rule's own award score replaces
 * `for`/`against`/`diff` and the sport's declared score keys (W2c X-PT-1 and its gap a), so a stage with its own
 * `config.points` no longer reads the division's keys whose ONLY reader is `delta.points`: the per-sport win/draw/loss
 * (`points`) and the set sports' `pointsMap`. The other points-scope keys are NOT replaced and a stage rule does not make
 * them stop mattering:
 *  - a board game's `scoring` also writes the game's own score: its headline (`summary` reads `cfg.scoring`), its
 *    declared points sets and its per-match bounds — none of which a stage rule replaces (W2c Task 9 addendum);
 *  - football's and the period sports' `awardScore` sets the goal credit of every forfeit AFTER play
 *    (`goalCredit(awardScore, real)`, FB-RT-1), which a stage rule pays as a result and leaves standing — even one that
 *    carries its own award score, which replaces the credit only where nothing was played (W2c fix round 1: the
 *    addendum-2 condition for unlocking it does not hold);
 *  - a board game's `byeScore` is declared and read nowhere.
 * Anything not named here stays locked, which is the safe side for a key a future module declares. Pinned against the
 * engine's declarations in division-locks.test.ts.
 */
export const STAGE_POINTS_REPLACES: ReadonlySet<string> = new Set(["points", "pointsMap"]);

/**
 * "Which of these stages have already started?" — THE format-lock predicate,
 * stated ONCE and interpolated by both halves of the lock: the single-stage
 * guard in `putStageRules`, which REFUSES the write, and
 * `formatLockedStageIds`, which the division page reads so the fixtures panel
 * knows whether to OFFER the editor at all. Two copies of this expression
 * would drift, and the shape of that drift is an organiser shown an Edit
 * button whose Save comes back 409. Change it here and both change.
 *
 * D1 — the predicate is MONOTONIC. Deliberately not `fixtures.status`:
 * `fixtureStatusFromFold` returns `in_play` only while an active `core.start`
 * exists, so voiding a start moves a fixture back to `scheduled` and a status
 * predicate would re-open a stage that has already been played. A frozen
 * `config_snapshot` and a score event both only ever appear; neither goes
 * away. The `score_events` half also covers the JSON-`null`-config carve-out,
 * where a fixture records events and never takes a snapshot at all.
 */
export async function lockedStageIdsAmong(tx: Tx, stageIds: readonly string[]): Promise<Set<string>> {
  if (stageIds.length === 0) return new Set();
  const rows = await tx<{ stage_id: string }[]>`
    select distinct f.stage_id from fixtures f
     where f.stage_id = any(${stageIds as string[]}::uuid[])
       and (f.config_snapshot is not null
            or exists(select 1 from score_events e where e.fixture_id = f.id))`;
  return new Set(rows.map((r) => r.stage_id));
}

/** The top-level keys a bracket stage forces on itself (`bracketDeciders`), read off the division's cfg as the fixture
 *  resolver reads it (`safeParse`, never `parse`: a stored config the schema now refuses must not make the lock throw). */
function forcedKeys(module: AnySportModule, divisionConfig: Record<string, unknown>): ReadonlySet<string> {
  const parsed = module.configSchema.safeParse(divisionConfig);
  return new Set(Object.keys(module.bracketDeciders((parsed.success ? parsed.data : divisionConfig) as never)));
}

/**
 * The fields of a division save that a STARTED stage still depends on, each named with the first such stage.
 *
 * `configKeys` are the top-level config keys the save actually CHANGES (not the keys it names — re-sending a stored
 * value is not a change). `variant` is a change of variant key; `tiebreakers` a change of the standings cascade.
 *
 * Empty case first: nothing changed asks no question and costs no query. A division with no started stage refuses
 * nothing, whatever it changes — `live` is empty and every `first(...)` below answers `undefined`.
 */
export async function divisionRefusals(
  tx: Tx,
  divisionId: string,
  change: { configKeys: readonly string[]; variant: boolean; tiebreakers: boolean },
  scope: { module: AnySportModule; variantKey: string; divisionConfig: Record<string, unknown> },
): Promise<RefusedField[]> {
  if (change.configKeys.length === 0 && !change.variant && !change.tiebreakers) return [];
  const stages = await tx<{ id: string; name: string; seq: number; kind: StageKind; config: Record<string, unknown> | null }[]>`
    select id, name, seq, kind, config from stages where division_id = ${divisionId} order by seq`;
  const started = await lockedStageIdsAmong(tx, stages.map((s) => s.id));
  const live = stages.filter((s) => started.has(s.id));
  const out: RefusedField[] = [];
  const first = (pred: (s: (typeof live)[number]) => boolean) => live.find(pred);
  const { module, variantKey } = scope;
  const tableKeys = tableRuleKeys(module, variantKey);
  // The keys a bracket stage forces on itself for the tie it must break (carrom's tie board, a board game's tiebreak):
  // that stage never reads the division's value for them. Asked the way the fixture resolver asks it (`liveCfg`,
  // fixture-cfg.ts): with the cfg the sport's schema parsed, defaults applied, or the stored one if the schema refuses it.
  const forced = live.some((s) => forbidsLevelResult(s.kind)) ? forcedKeys(module, scope.divisionConfig) : new Set<string>();
  if (change.variant) {
    const s = first(() => true);
    if (s) out.push({ field: "variant_key", code: "DIVISION_FORMAT_LOCKED", stageId: s.id, stageName: s.name });
  }
  if (change.tiebreakers) {
    // W2d owns per-stage cascades; until then every stage that HAS a table inherits it. A knockout ranks no table.
    const s = first((st) => DRAW_KINDS.has(st.kind));
    if (s) out.push({ field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: s.id, stageName: s.name });
  }
  for (const key of change.configKeys) {
    const table = tableKeys.has(key);
    const s = first((st) => {
      const cfg = st.config ?? {};
      if (table && !DRAW_KINDS.has(st.kind)) return false;        // a knockout has no table to protect
      if (table && cfg.points != null && STAGE_POINTS_REPLACES.has(key)) return false; // the stage's own PointsRule replaces it
      // NOT `appliesTo`: that says where the engine OFFERS a key, and the fold reads cfg whatever the stage kind (boardgame
      // `tiebreak` is listed for bracket kinds, yet a league game folds to the tie-break phase when the division says so).
      // What a stage truly ignores is a key it FORCES.
      if (forbidsLevelResult(st.kind) && forced.has(key)) return false;
      if (deciderKeysFor(module, st.kind, variantKey).includes(key) && cfg[key] !== undefined) return false; // the stage carries its own decider
      const rules = (cfg.rules ?? {}) as Record<string, unknown>;
      return rules[key] == null;                                   // the stage inherits this key (a null is "inherit", stage-cfg.ts)
    });
    if (s) out.push({ field: key, code: table ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED", stageId: s.id, stageName: s.name });
  }
  return out;
}
