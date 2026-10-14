import "server-only";
import { stageScopedCfgOf, type DeciderOffSource } from "@/lib/stage-decider-off";

// PROMPT-61 §2 and design 2026-09-17 §T1 — the stage-scoped cfg. A groups+knockout division keeps one sport config, and
// each stage may carry `config.rules`, a partial format override (Best-of-1 in the league stage, Best-of-3 in the
// playoff), laid over the division config for fixtures in that stage — the same overlay philosophy competition.ts
// applies for points/rngSeed/rounds. Identity when the stage overlays nothing, so the fold sites can pass the result
// unconditionally.
//
// Merge order is `{...divisionCfg, ...rules}` (W2c D3, Task 13b). A stage's deciders (`shootout`, `extraTime`,
// `overtime`, `superOver`, …) are ordinary `rules` keys: the write paths' per-sport allowlist (`stageTopKeysFor`, Tasks 11
// and 12) gates which keys `rules` may carry, and keeps `points` out of it. Nothing at the stage config's TOP level is
// read: the old top-level `shootout` / `extraTime` overlay is retired, and the create door refuses a top-level decider
// by name (`usecases/stage-defaults.ts`). A stored null is "inherit" (dropped), and a `false` on a decider whose engine
// off is null is that null (W2c Task 12, R-T12-1).
export function stageScopedCfg(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
  module: DeciderOffSource | null,
): unknown {
  // The composition lives in lib/stage-decider-off.ts (`stageScopedCfgOf`, fix round 2, review M-3), shared with the
  // format-matrix harness so neither keeps a copy.
  return stageScopedCfgOf(divisionCfg, stageCfg, module);
}
