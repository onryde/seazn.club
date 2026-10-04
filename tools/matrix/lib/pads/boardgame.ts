// boardgame: the result event is all the matrix generator emits
// (streams/boardgame.ts). The pad is tap model S (boardgame.tsx:595): the
// references into boardgame.tsx:
//  - a decisive result is the winner's scorebug half, which HOLDS
//    `{winner}`; the dock then offers DECISIVE_METHODS (:147) as chips;
//  - a draw is the `draw` tile (DRAW_TILE_ID, :381), which HOLDS
//    `{winner: null}` (:403) with DRAWN_METHODS (:155) as chips;
//  - a chip is `method:<method>` (:509) and only rewrites the held `method`.
// Step 0 (2026-09-30, 320, the builder default `blitz`) saw the halves turn
// into buttons only after Start, the half and the draw tile each HOLD
// (send-now present), the chip keep the dock open, and the release write one
// `boardgame.result {method, winner}` row — keys exactly [method, winner] for
// both a checkmate and a draw by agreement. The draw tile asks no sheet, and
// with no chip it writes no method, so the chip is part of the route.
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../../scripts/bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** boardgame.tsx:109 RESULT_TYPE, an event the engine's boardgame module declares (pinned). */
export const BOARDGAME_RESULT = "boardgame.result";
/** boardgame.tsx:381 DRAW_TILE_ID (text-pinned). */
export const BOARDGAME_DRAW_TILE = "draw";
/** boardgame.tsx:509 methodChip's id (text-pinned). */
export const methodChipId = (method: string): string => `method:${method}`;

function resultSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const side = p.winner === ctx.entrants.home ? "home" : p.winner === ctx.entrants.away ? "away" : p.winner === null ? "draw" : null;
  if (payload === null || typeof payload !== "object" || keys.length !== 2 || keys[0] !== "method" || keys[1] !== "winner"
    || typeof p.method !== "string" || p.method === "" || side === null) {
    throw new Error(`boardgamePad: ${BOARDGAME_RESULT} payload ${JSON.stringify(payload)} is not {winner: an entrant of the fixture or null, method}`);
  }
  // Both HOLD; the replay's closing releaseHold sends the result with its method.
  const hold: TapStep = side === "draw" ? { kind: "tile", tileId: BOARDGAME_DRAW_TILE } : { kind: "half", side };
  return [hold, { kind: "chip", chipId: methodChipId(p.method) }];
}

export const boardgamePad: MatrixPadAdapter = {
  sport: "boardgame",
  emits: ["core.start", BOARDGAME_RESULT],
  fallbacks: [],
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === BOARDGAME_RESULT) return resultSteps(event.payload, ctx);
    throw new Error(`boardgamePad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: every row's keys were exactly method and winner.
  tolerableExtraKeys: () => [],
};
