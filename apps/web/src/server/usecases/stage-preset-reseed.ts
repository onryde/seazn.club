import "server-only";
// W2c Task 12, fix round 1 (R-T12-2) — a division VARIANT change re-seeds the presets its unstarted stages store, in the
// division save's own transaction (`patchDivision`, divisions.ts).
//
// A new stage is WRITTEN with its sport's preset for its kind and the division's variant (`stage-defaults.ts`, X-SR-6),
// and some presets depend on the variant: the super over is a limited-overs knockout's (not a test match's), a youth
// knockout's shoot-out is 3 kicks where 11-a-side's is 5. Left as stored, a variant change would strand the old one: a
// t20 knockout's `superOver: true` under a test match (M1 refuses the change until the organiser clears it by hand), a
// youth `shootoutAttempts: 3` under 11-a-side. So, per key of either preset:
//   - stored and EQUAL to the old variant's preset: the preset, not a choice. It becomes the new variant's preset, or
//     goes when the new variant declares none;
//   - a key only the new variant's preset names, not stored: written;
//   - anything else is the organiser's (a changed value, a key removed to inherit, a key no preset names): kept, and the
//     division save then asks it the new variant's allowlist (M1, `refuseInvalidatedStageRules`, refused by name).
// A STARTED stage is never touched: the variant lock (`rule-locks.ts` `divisionRefusals`) refuses a variant change while
// any stage has started, and this passes one by regardless. One `stage.rules_reseeded` audit row per stage re-seeded.
//
// Its own module, importing no other usecase but the lock predicate, so `divisions.ts` imports it without a cycle.
import { isDeepStrictEqual } from "node:util";
import type { StageKind } from "@seazn/engine/core";
import { stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import type { Tx } from "@/lib/db";
import { withoutNulls } from "@/lib/stage-decider-off";
import { lockedStageIdsAmong } from "./rule-locks";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The rules a stage stores after the variant moves from `oldPreset`'s to `newPreset`'s (the rule above), or null when
 *  none are left. A stored null is "inherit" (`stage-cfg.ts`), never a value: dropped first, never compared. */
export function reseededRules(
  stored: unknown,
  oldPreset: Record<string, unknown>,
  newPreset: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = isObj(stored) ? withoutNulls(stored) : {};
  for (const key of new Set([...Object.keys(oldPreset), ...Object.keys(newPreset)])) {
    const had = Object.hasOwn(out, key);
    if (Object.hasOwn(oldPreset, key)) {
      // Not the old preset's value (or not there at all): the organiser's, kept as it is.
      if (!had || !isDeepStrictEqual(out[key], oldPreset[key])) continue;
      if (Object.hasOwn(newPreset, key)) out[key] = newPreset[key];
      else delete out[key];
    } else if (!had) {
      out[key] = newPreset[key];
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Re-seeds every unstarted stage of the division from `fromVariant`'s presets to `toVariant`'s, writing only the stages
 * whose rules move, each with its audit row. Returns the ids re-seeded, in board order. Called inside the division
 * save's transaction, after the stage lock is held by the save and before the save re-asks every stage's rules.
 */
export async function reseedStagePresets(
  tx: Tx,
  input: { divisionId: string; module: AnySportModule; fromVariant: string; toVariant: string; actorId: string | null },
): Promise<string[]> {
  const { divisionId, module, fromVariant, toVariant, actorId } = input;
  const stages = await tx<{ id: string; kind: StageKind; rules: unknown; competition_id: string }[]>`
    select s.id, s.kind, s.config -> 'rules' as rules, d.competition_id
      from stages s join divisions d on d.id = s.division_id
     where s.division_id = ${divisionId} order by s.seq`;
  const started = await lockedStageIdsAmong(tx, stages.map((s) => s.id));
  const reseeded: string[] = [];
  for (const s of stages) {
    if (started.has(s.id)) continue;
    const before = isObj(s.rules) ? s.rules : null;
    const after = reseededRules(before, stageDefaultsFor(module, s.kind, fromVariant), stageDefaultsFor(module, s.kind, toVariant));
    if (isDeepStrictEqual(reseededRules(before, {}, {}), after)) continue; // nothing this change owns moved
    if (after === null) await tx`update stages set config = config - 'rules' where id = ${s.id}`;
    else await tx`update stages set config = config || ${tx.json({ rules: after } as never)} where id = ${s.id}`;
    await tx`
      insert into competition_events (competition_id, type, payload, actor_id)
      values (${s.competition_id}, 'stage.rules_reseeded',
              ${tx.json({ stage_id: s.id, division_id: divisionId, from_variant: fromVariant, to_variant: toVariant, before, after } as never)},
              ${actorId})`;
    reseeded.push(s.id);
  }
  return reseeded;
}
