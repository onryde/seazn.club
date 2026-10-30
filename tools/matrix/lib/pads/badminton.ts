// badminton: the setScore tile authors the coarse game summary that the matrix
// generator emits (streams/setbased.ts). The references into badminton.tsx,
// by symbol (line numbers go stale on every skin edit):
//  - SET_SCORE_TILE_ID is the tile's id;
//  - `buildTiles` offers the tile while no game is in progress;
//  - `setScoreSheet` is its sheet, two number steps, home then away, each
//    prefilled from the open game (0 on a fresh one).
// Step 0 (2026-09-30, 320 and 1280) saw one tap route write one
// `badminton.game.summary {home, away}` row at once, with no hold and no extra
// key. So one event is one row.
import { START_MATCH_TESTID, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** badminton.tsx SET_SCORE_TILE_ID (text-pinned in pad-adapters.test.ts). */
export const BADMINTON_SET_SCORE_TILE = "setScore";
/** `badminton.${coarseEventType}`: badminton.tsx SUMMARY_TYPE, the engine's setbased/badminton.ts `coarseEventType` (pinned). */
export const BADMINTON_SUMMARY = "badminton.game.summary";

function summarySteps(payload: unknown): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== "away" || keys[1] !== "home" || !Number.isInteger(p.home) || !Number.isInteger(p.away)) {
    throw new Error(`badmintonPad: ${BADMINTON_SUMMARY} payload ${JSON.stringify(payload)} is not the sheet's {home, away} of whole numbers`);
  }
  return [
    { kind: "tile", tileId: BADMINTON_SET_SCORE_TILE },
    { kind: "number", value: p.home as number }, { kind: "confirm" },
    { kind: "number", value: p.away as number }, { kind: "confirm" },
  ];
}

export const badmintonPad: MatrixPadAdapter = {
  sport: "badminton",
  emits: ["core.start", BADMINTON_SUMMARY],
  fallbacks: [],
  stepsFor(event) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === BADMINTON_SUMMARY) return summarySteps(event.payload);
    throw new Error(`badmintonPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0 item 2: the row's keys were exactly away and home.
  tolerableExtraKeys: () => [],
};
