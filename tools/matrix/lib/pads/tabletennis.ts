// tabletennis: the setScore tile authors the coarse game summary that the
// matrix generator emits (streams/setbased.ts). The references into
// tabletennis.tsx, by symbol (line numbers go stale on every skin edit):
//  - SET_SCORE_TILE_ID is the tile's id;
//  - `buildTiles` offers the tile while no game is in progress;
//  - `setScoreSheet` is its sheet, two number steps, home then away, each
//    prefilled from the open game (0 on a fresh one).
// Step 0 (2026-09-30, 320) saw the tile enabled with the serve anchor
// (the tile beside it in `buildTiles`) still offered and never set: the anchor gates rally scoring only, so
// no anchor step is owed. Each tap route wrote one
// `tabletennis.game.summary {home, away}` row at once, with no hold and no
// extra key. So one event is one row.
import { START_MATCH_TESTID, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** tabletennis.tsx SET_SCORE_TILE_ID (text-pinned in pad-adapters.test.ts). */
export const TABLETENNIS_SET_SCORE_TILE = "setScore";
/** `tabletennis.${coarseEventType}`: tabletennis.tsx SUMMARY_TYPE, the engine's setbased/tabletennis.ts `coarseEventType` (pinned). */
export const TABLETENNIS_SUMMARY = "tabletennis.game.summary";

function summarySteps(payload: unknown): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== "away" || keys[1] !== "home" || !Number.isInteger(p.home) || !Number.isInteger(p.away)) {
    throw new Error(`tabletennisPad: ${TABLETENNIS_SUMMARY} payload ${JSON.stringify(payload)} is not the sheet's {home, away} of whole numbers`);
  }
  return [
    { kind: "tile", tileId: TABLETENNIS_SET_SCORE_TILE },
    { kind: "number", value: p.home as number }, { kind: "confirm" },
    { kind: "number", value: p.away as number }, { kind: "confirm" },
  ];
}

export const tabletennisPad: MatrixPadAdapter = {
  sport: "tabletennis",
  emits: ["core.start", TABLETENNIS_SUMMARY],
  fallbacks: [],
  stepsFor(event) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === TABLETENNIS_SUMMARY) return summarySteps(event.payload);
    throw new Error(`tabletennisPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: every row's keys were exactly away and home.
  tolerableExtraKeys: () => [],
};
