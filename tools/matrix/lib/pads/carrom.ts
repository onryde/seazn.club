// carrom: board summaries are all the matrix generator emits
// (streams/carrom.ts). The references into carrom.tsx:
//  - :368-378 the `board` tile (live), which opens the "board" sheet (:531);
//  - :446-458 boardSheet: the winner as a choice over sideOptions (ids
//    `home` / `away`, :206-208), then the opponent's coins left as a number
//    (0..9), building `{winner, opponentCoinsLeft}`. `queenTo` is never asked
//    (:440-446: "which reads exactly like an explicit `null` to the fold");
//    a queen board is the other tile, `boardQueen`.
// Step 0 (2026-09-30, 320, the builder default `club-29`) saw each board write
// one `carrom.board.summary {opponentCoinsLeft, winner}` row at once, with no
// hold and no `queenTo` key, and the eighth board decide the match. So the
// generated `queenTo: null` is excused as absent for this one type.
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** The engine's carrom event type (carrom.eventSchemas; pinned). */
export const CARROM_BOARD = "carrom.board.summary";
/** carrom.tsx:373 (text-pinned in pad-adapters.test.ts). */
export const CARROM_BOARD_TILE = "board";

function boardSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => k !== "winner" && k !== "opponentCoinsLeft" && k !== "queenTo");
  const side = p.winner === ctx.entrants.home ? "home" : p.winner === ctx.entrants.away ? "away" : null;
  const coins = p.opponentCoinsLeft;
  if (payload === null || typeof payload !== "object" || extra.length > 0 || side === null
    || !Number.isInteger(coins) || (coins as number) < 0 || (coins as number) > 9
    || ("queenTo" in p && p.queenTo !== null)) {
    throw new Error(`carromPad: ${CARROM_BOARD} payload ${JSON.stringify(payload)} is not the board sheet's {winner, opponentCoinsLeft 0..9, queenTo null}`);
  }
  return [
    { kind: "tile", tileId: CARROM_BOARD_TILE },
    { kind: "choice", optionId: side },
    { kind: "number", value: coins as number },
    { kind: "confirm" },
  ];
}

export const carromPad: MatrixPadAdapter = {
  sport: "carrom",
  emits: ["core.start", CARROM_BOARD],
  fallbacks: [],
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === CARROM_BOARD) return boardSteps(event.payload, ctx);
    throw new Error(`carromPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: every row's keys were exactly opponentCoinsLeft and winner.
  tolerableExtraKeys: () => [],
  // carrom.tsx:440-446 — the board sheet never asks queenTo, which the fold reads as null.
  nullAsAbsentKeys: (eventType) => (eventType === CARROM_BOARD ? ["queenTo"] : []),
};
