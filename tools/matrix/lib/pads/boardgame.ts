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
//
// W2a (BG-KO-1, ruling 82): a drawn game in a bracket opens phase `tiebreak`, and the scorer records the tie-break on
// the pad: the `tiebreak` tile (TIEBREAK_TILE_ID), a sheet of choices — the rung (`rung`), the winner (`winner`, or
// `winner-armageddon` on the armageddon rung: two steps, one option id set), and for rapid and blitz the score
// (`score`: none / 2–0 / 1½–½). The chassis' own attributes, not testids: `[data-tile-id]` and
// `[data-choice-option-id]` (guided-sheet.tsx:418), the last choice of a sheet completing it. The matrix asks for no
// score, so it taps `none`, which writes `{rung, winner}` and no `score` key. Lots is NOT here: it is the organiser's
// core.settle (X-ST-2), and the pad refuses to emit it.
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** boardgame.tsx:109 RESULT_TYPE, an event the engine's boardgame module declares (pinned). */
export const BOARDGAME_RESULT = "boardgame.result";
/** The engine's tie-break event (boardgame.eventSchemas; pinned). */
export const BOARDGAME_TIEBREAK = "boardgame.tiebreak";
/** boardgame.tsx TIEBREAK_TILE_ID (text-pinned in pad-adapters.test.ts; the skin gains it with loop H). */
export const BOARDGAME_TIEBREAK_TILE = "tiebreak";
/** The score step's "no score" option (boardgame.tsx's SCORES[0]; text-pinned). */
export const TIEBREAK_SCORE_NONE = "none";
/** The rung whose sheet has no score step (BG-KO-2: the armageddon winner is tapped, nothing more). */
export const ARMAGEDDON = "armageddon";
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

function tiebreakSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const side = p.winner === ctx.entrants.home ? "home" : p.winner === ctx.entrants.away ? "away" : null;
  const rung = typeof p.rung === "string" && (TIEBREAK_RUNGS as readonly string[]).includes(p.rung) ? p.rung : null;
  if (payload === null || typeof payload !== "object" || keys.length !== 2 || keys[0] !== "rung" || keys[1] !== "winner" || rung === null || side === null) {
    throw new Error(`boardgamePad: ${BOARDGAME_TIEBREAK} payload ${JSON.stringify(payload)} is not {rung: one of ${TIEBREAK_RUNGS.join(", ")}, winner: an entrant of the fixture}`);
  }
  return [
    { kind: "tile", tileId: BOARDGAME_TIEBREAK_TILE },
    { kind: "choice", optionId: rung },
    { kind: "choice", optionId: side },
    ...(rung === ARMAGEDDON ? [] : [{ kind: "choice", optionId: TIEBREAK_SCORE_NONE } as const]),
  ];
}

export const boardgamePad: MatrixPadAdapter = {
  sport: "boardgame",
  emits: ["core.start", BOARDGAME_RESULT, BOARDGAME_TIEBREAK],
  fallbacks: [],
  stepsFor(event, ctx) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === BOARDGAME_RESULT) return resultSteps(event.payload, ctx);
    if (event.type === BOARDGAME_TIEBREAK) return tiebreakSteps(event.payload, ctx);
    throw new Error(`boardgamePad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Step 0: every row's keys were exactly method and winner.
  tolerableExtraKeys: () => [],
};
