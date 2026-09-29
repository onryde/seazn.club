// Known product bugs the random walk must not rediscover on every run: fast-
// check stops at the first failure, so one known bug would dominate every
// shrink and hide the next one (Review Focus 3). A fence blocks one command
// while its condition holds; --no-fences lifts all of them, and each fenced
// bug is ALSO a committed regression case (R29), so it is still witnessed.
//
// A fence guards only the cells its committed case names (final batch F-1:
// the knockout fences apply to knockout alone), so the same bug on another
// cell is still reported NEW rather than fenced away.
//
// Imports only types from state.ts, which strip-types erases: no cycle at load.
import { PENDING_STATUSES } from "../observed.ts";
import type { CommandKind, ModelState } from "./state.ts";

/** `subject` is the entrant the command would act on (Withdraw's), else null.
 *  `issue` is the GitHub issue, or null when none is filed — the committed
 *  case that names the fence (regressions.json `fence`) is its witness. */
export interface Fence { readonly id: string; readonly issue: string | null; readonly blocks: CommandKind; applies(m: ModelState, subject: string | null): boolean }

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
  {
    id: "ko-withdraw-waiting-on-tbd",
    issue: null,
    blocks: "Withdraw",
    // MB-002/003. withdrawal.ts: a bracket withdrawal voids the entrant's
    // pending fixture when its opponent is TBD ("A TBD opponent can't receive
    // a walkover"), and that void rides core.abandon, which append-event.ts
    // refuses on a fixture with an unassigned entrant (422 WRONG_PHASE) — so
    // the withdrawal the model holds legal is refused. Only the entrant this
    // Withdraw would pick, only while it waits in a pending fixture (the
    // product's PENDING_STATUSES) on an empty seat.
    applies: (m: ModelState, subject: string | null) => m.stageKind === "knockout" && subject !== null &&
      [...m.fixtures.values()].some((f) => PENDING_STATUSES.includes(f.status) && ((f.home === subject && f.away === null) || (f.away === subject && f.home === null))),
  },
  {
    id: "ko-generate-after-roster-change",
    issue: null,
    blocks: "Generate",
    // MB-004/005. stages.ts generateStageFixtures: a Generate over a knockout
    // whose fixtures exist, after the roster changed — an entrant added
    // (MB-005, before Start) or one withdrawn (MB-004, after) — 500s: the
    // bye-award bulk UPDATE would strand home_slot_label. An added entrant is
    // lifted once an accepted Rebuild or Generate re-seats the field
    // (lateEntry); a withdrawal is never undone.
    applies: (m: ModelState) => m.stageKind === "knockout" && m.fixtures.size > 0 && (m.lateEntry || m.withdrawn.size > 0),
  },
]);

/** The fence that withholds `kind` in this state, or null. `enabled: false`
 *  (--no-fences) lifts every fence. `subject`: the entrant the command would
 *  act on, when it picks one (Withdraw). */
export function fenceBlocking(m: ModelState, kind: CommandKind, enabled: boolean, subject: string | null = null): Fence | null {
  if (!enabled) return null;
  return FENCES.find((f) => f.blocks === kind && f.applies(m, subject)) ?? null;
}
