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
    // Round-robin stages only (schedule.ts roundRobinStageIds). An entrant
    // added while the stage already has fixtures — before Start, since the
    // roster locks at Start — then Generate: the reconcile keys on POSITION
    // (rr-r{round}-c{court}), so it duplicates pairs and misses others (issue
    // #879; ruling C-1 supersedes R-PF8's post-Start add). Lifted once an
    // accepted Rebuild or Generate re-seats the grown field.
    applies: (m: ModelState) => m.lateEntry && (m.stageKind === "league" || m.stageKind === "group"),
  },
]);

/** The fence that withholds `kind` in this state, or null. `enabled: false`
 *  (--no-fences) lifts every fence. */
export function fenceBlocking(m: ModelState, kind: CommandKind, enabled: boolean): Fence | null {
  if (!enabled) return null;
  return FENCES.find((f) => f.blocks === kind && f.applies(m)) ?? null;
}
