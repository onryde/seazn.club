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

/** Division config keys that are TABLE rules (Q3); every other key is match format (Q4).
 *  A literal until Task 5, which derives it from the engine (`pointsKeysFor` ∪ {"pointsMap"}, D11). */
export const TABLE_RULE_KEYS: ReadonlySet<string> = new Set(["points", "pointsMap"]);

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
): Promise<RefusedField[]> {
  if (change.configKeys.length === 0 && !change.variant && !change.tiebreakers) return [];
  const stages = await tx<{ id: string; name: string; seq: number; config: Record<string, unknown> | null }[]>`
    select id, name, seq, config from stages where division_id = ${divisionId} order by seq`;
  const started = await lockedStageIdsAmong(tx, stages.map((s) => s.id));
  const live = stages.filter((s) => started.has(s.id));
  const out: RefusedField[] = [];
  const first = (pred: (s: (typeof live)[number]) => boolean) => live.find(pred);
  if (change.variant) {
    const s = first(() => true);
    if (s) out.push({ field: "variant_key", code: "DIVISION_FORMAT_LOCKED", stageId: s.id, stageName: s.name });
  }
  if (change.tiebreakers) {
    const s = first(() => true); // W2d owns per-stage cascades; until then every stage inherits them
    if (s) out.push({ field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: s.id, stageName: s.name });
  }
  for (const key of change.configKeys) {
    const table = TABLE_RULE_KEYS.has(key);
    const s = first((st) => {
      const cfg = st.config ?? {};
      if (table) return cfg.points == null;                       // a stage PointsRule replaces division points
      const rules = (cfg.rules ?? {}) as Record<string, unknown>;
      return rules[key] === undefined;                             // the stage inherits this key
    });
    if (s) out.push({ field: key, code: table ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED", stageId: s.id, stageName: s.name });
  }
  return out;
}
