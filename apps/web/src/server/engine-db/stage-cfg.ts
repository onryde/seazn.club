import "server-only";
import { stageScopedCfgOf, type DeciderOffSource } from "@/lib/stage-decider-off";

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
// Exported for `rule-locks.ts` (W2c Task 12): the division lock asks which top-level keys a stage carries as its own, and
// these are the only two this overlay reads there. Task 13b retires the top-level read, and this export with it.
export const STAGE_DECIDER_KEYS = ["shootout", "extraTime"] as const;

export function stageScopedCfg(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
  module: DeciderOffSource | null,
): unknown {
  // Rules first, decider keys second (see above). A stored null is "inherit" (dropped), and a `false` on a decider whose
  // engine off is null is that null (W2c Task 12 fix round 1, R-T12-1). The composition lives in lib/stage-decider-off.ts
  // (`stageScopedCfgOf`, fix round 2, review M-3), shared with the format-matrix harness so neither keeps a copy; this
  // file keeps the `STAGE_DECIDER_KEYS` literal (tools/bench's validate-pack mirror test text-pins it here). Task 13b,
  // which reworks the resolver, keeps calling it.
  return stageScopedCfgOf(divisionCfg, stageCfg, module, STAGE_DECIDER_KEYS);
}
