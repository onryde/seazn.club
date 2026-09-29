// Known product bugs the random walk must not rediscover on every run: fast-
// check stops at the first failure, so one known bug would dominate every
// shrink and hide the next one (Review Focus 3). A fence blocks one command
// while its condition holds; --no-fences lifts all of them, and each fenced
// bug is ALSO a committed regression case (R29), so it is still witnessed.
//
// Imports only types from state.ts, which strip-types erases: no cycle at load.
import type { CommandKind, ModelState } from "./state.ts";

export interface Fence { readonly id: string; readonly issue: string; readonly blocks: CommandKind; applies(m: ModelState): boolean }

export const FENCES: readonly Fence[] = Object.freeze([
  {
    id: "late-entry-then-generate",
    issue: "#879",
    blocks: "Generate",
    // Round-robin stages only: an entrant added after Start, then Generate,
    // seats every existing pair again (#879's trigger, pre-flight ruling R-PF8).
    applies: (m: ModelState) => m.lateEntry && (m.stageKind === "league" || m.stageKind === "group"),
  },
]);

/** The fence that withholds `kind` in this state, or null. `enabled: false`
 *  (--no-fences) lifts every fence. */
export function fenceBlocking(m: ModelState, kind: CommandKind, enabled: boolean): Fence | null {
  if (!enabled) return null;
  return FENCES.find((f) => f.blocks === kind && f.applies(m)) ?? null;
}
