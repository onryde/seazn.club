// A pool's display label — ONE authority for every surface that names a pool:
// the public division page, the embed, the competition hub, the poster's draw,
// both slideshows and the organiser console.
//
// Never `pools.name`. The generator stores it once, as the English
// "Pool " + key (`server/usecases/stages/`), and nothing renames it, so
// printing it put English in front of every Spanish, French and Dutch reader
// (2026-10-06). The label is rebuilt from the pool's KEY through the reader's
// own `public` dictionary instead: "Group A", "Grupo A", "Poule A". The stored
// name is left as it is — this is display only.
//
// Pure (no `server-only`): the dictionary is passed in, already chosen by the
// caller for its audience (the org's locale on an ISR public page, the
// viewer's on the console).
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { comparePools, type PoolOrderRef } from "@/lib/pool-order";

/** One pool's label in `dict`'s locale, from its key. A missing or empty key
 *  is the bare pool word (`table.pool`) — never "Pool " with nothing after it,
 *  and never the literal "undefined" interpolation would otherwise print. */
export function poolLabel(dict: Dict, key: string | null | undefined): string {
  return key ? t(dict, "table.poolLabel", { key }) : t(dict, "table.pool");
}

/** A division's pools in display order (`comparePools`: key, then name, then id), each with its label in `dict`'s locale. What the
 *  fixtures tab hands the stage cards so a round's bar can say which pool it is for - the two authorities above, composed once. */
export function poolLabelsInOrder(dict: Dict, pools: readonly PoolOrderRef[]): { id: string; label: string }[] {
  return [...pools].sort(comparePools).map((p) => ({ id: p.id, label: poolLabel(dict, p.key) }));
}

/**
 * W5 T3 fix round 1 (X-BD-7; owner R24: a one-pool division shows no letter): how each pool of a read is NAMED, id -> key, or id -> null
 * for a pool that is not named. A group of ONE pool now has a pool row (pool A), but it behaves as a league: its table is the stage's
 * table, headed by the stage's name alone, never "Groups - Group A". Only a pool of a stage with SEVERAL pools is named. `pools` is
 * every pool the read holds (a division's, or one stage's); a pool with no `stage_id` is read as one stage's. A pool the read does not
 * list is absent from the map, and `poolCaption` keeps its old reading of that (the bare pool word). The one authority for "does this
 * stage name its pools" on the public page, the embed, the hub, both slideshows, the PDF, the poster and the console.
 */
export function poolNaming(pools: readonly { id: string; key: string; stage_id?: string }[]): Map<string, string | null> {
  const perStage = new Map<string, number>();
  for (const p of pools) perStage.set(p.stage_id ?? "", (perStage.get(p.stage_id ?? "") ?? 0) + 1);
  return new Map(pools.map((p) => [p.id, (perStage.get(p.stage_id ?? "") ?? 0) > 1 ? p.key : null]));
}

/** A table's caption: "Stage - Group A" for a named pool (`poolNaming`), the bare stage name for a stage-wide table or a pool that is not
 *  named (a one-pool stage's), and "Stage - Group" (the bare pool word) for a pool the read does not list. */
export function poolCaption(dict: Dict, stageName: string, poolId: string | null | undefined, naming: ReadonlyMap<string, string | null>): string {
  if (!poolId) return stageName;
  const key = naming.get(poolId);
  return key === null ? stageName : `${stageName} \u2014 ${poolLabel(dict, key)}`;
}
