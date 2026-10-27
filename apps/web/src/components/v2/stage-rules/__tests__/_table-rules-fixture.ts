// W2d Task 15 — a stage's `tableRules` exactly as Task 13 serves it (GET /stages/{id}), built through the engine's ONE
// resolver (`resolveTableRules`, the loader's own), for the Tie-breaks model, section and panel tests. Never the code under
// test: the order, its source and its pin are the engine's answers.
import { resolveTableRules, type TableRulesPin } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import type { StageTableRules } from "@/server/api-v1/schemas";

/** The cfg a division of `variant` plays, as the sport parses it; with no variant the sport's defaults, or — for a sport whose
 *  schema has no default for a required key (generic's scoring mode) — its first declared variant. */
export const cfgOf = (m: AnySportModule, variant?: string): unknown => {
  if (variant !== undefined) return m.configSchema.parse(m.variants[variant]);
  const bare = m.configSchema.safeParse({});
  return bare.success ? bare.data : m.configSchema.parse(Object.values(m.variants)[0]);
};
/** A stage's `tableRules` exactly as Task 13 serves it, built through the engine's ONE resolver (the loader's own). */
export function tableRulesOf(
  m: AnySportModule,
  stageKind: TableStageKind,
  over: { cfg?: unknown; own?: readonly TiebreakerKey[] | null; division?: readonly TiebreakerKey[] | null; pinned?: TableRulesPin | null; pinnedAt?: string | null } = {},
): StageTableRules {
  const cfg = over.cfg ?? cfgOf(m);
  const r = resolveTableRules({
    module: m,
    stageKind,
    mergedCfg: cfg,
    stageOwn: { points: null, tiebreakers: over.own ?? null, crossGroup: null },
    divisionTiebreakers: over.division ?? null,
    pinned: over.pinned ?? null,
  });
  const pinnedAt = over.pinnedAt ?? (over.pinned ? "2026-10-27T10:00:00.000Z" : null);
  return {
    tiebreakers: { keys: [...r.tiebreakers], source: r.sources.tiebreakers, pinnedAt, sportDefault: m.defaultTiebreakers(stageKind, cfg) },
    crossGroup: { keys: [...r.crossGroup] },
    points: { rule: r.points, source: r.sources.points, pinnedAt },
    reachableOutcomes: [],
  };
}
