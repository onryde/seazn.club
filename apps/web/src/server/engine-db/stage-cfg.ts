import "server-only";

// PROMPT-61 §2 — stage-scoped decider overlay. A groups+knockout division
// keeps one sport config, but the knockout STAGE may carry `shootout` /
// `extraTime`; those two keys overlay the division config for fixtures in that
// stage — the same overlay philosophy competition.ts applies for
// points/rngSeed/rounds. Identity when the stage overlays nothing, so the fold
// sites can pass the result unconditionally.
//
// Per-stage match rules (design 2026-09-17 §T1) add a SECOND source: a stage
// may also carry `config.rules`, a partial format override (Best-of-1 in the
// league stage, Best-of-3 in the playoff). Merge order is
// `{...divisionCfg, ...rules, ...deciders}` — rules first so a stage's own
// `shootout`/`extraTime` stay the single winner for those two keys even if a
// future writer smuggles them into `rules`. The overlay itself is permissive
// about WHICH keys `rules` carries; the write path's per-sport allowlist
// (design D2/D2a) is what keeps `points` and the decider keys out of it.
const STAGE_DECIDER_KEYS = ["shootout", "extraTime"] as const;

export function stageScopedCfg(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
): unknown {
  if (stageCfg == null) return divisionCfg;
  const overlay: Record<string, unknown> = {};
  // Rules first, decider keys second (see above).
  const rules = stageCfg.rules;
  if (rules != null && typeof rules === "object" && !Array.isArray(rules))
    for (const [k, v] of Object.entries(rules as Record<string, unknown>))
      // "Inherit" is key ABSENCE, never an explicit null: a spread copies
      // nulls, so a null reaching here would BLANK the division's value
      // instead of leaving it alone. The endpoint strips nulls on the way in;
      // this is the second half of that contract, for rows written before it.
      if (v !== null && v !== undefined) overlay[k] = v;
  for (const key of STAGE_DECIDER_KEYS) {
    if (stageCfg[key] !== undefined) overlay[key] = stageCfg[key];
  }
  if (Object.keys(overlay).length === 0) return divisionCfg;
  return { ...(divisionCfg as Record<string, unknown>), ...overlay };
}
