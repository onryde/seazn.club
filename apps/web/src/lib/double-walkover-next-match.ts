// W2b D19 (X-DW-3) — WHERE a double walkover is refused: a feeding bracket kind on a line that feeds no next match.
// One reading, shared by the append guard (server/engine-db/append-event.ts, DOUBLE_WALKOVER_NO_NEXT_MATCH) and the
// fixture page (Task 11: the console's forfeit dialog shows the guidance instead of "Neither"), so the dialog can never
// offer a double walkover the server refuses, or hide one it accepts. The feed half is `feedsNextMatch`
// (lib/bracket-next-match.ts, loop-F I-5: a reset grand final feeds only its own rematch); that file stays import-free
// for tools/matrix, which is why the stage-kind half lives here.
import { forbidsLevelResult } from "@seazn/engine/core";

/** The kinds whose double walkover must send nobody somewhere: every kind that forbids a level result except a ladder,
 *  which wires no feed edge by design (W2a loop G) and keeps its positions on a double walkover. */
export function doubleWalkoverNeedsNextMatch(stageKind: string | null): boolean {
  return forbidsLevelResult(stageKind) && stageKind !== "ladder";
}

/** D19: a double walkover on this fixture is refused — its stage kind needs a next match and the line feeds none.
 *  `feedsNext` is `feedsNextMatch` over the fixture's two feed edges. */
export function doubleWalkoverRefused(stageKind: string | null, feedsNext: boolean): boolean {
  return doubleWalkoverNeedsNextMatch(stageKind) && !feedsNext;
}
