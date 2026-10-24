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
// the pad: the `tiebreak` tile (TIEBREAK_TILE_ID), a sheet of choices — the rung (`rung`), the winner (`winner`), and for
// rapid and blitz the score (`score`: none / 2–0 / 1½–½). The chassis' own attributes, not testids: `[data-tile-id]` and
// `[data-choice-option-id]` (guided-sheet.tsx:418), the last choice of a sheet completing it. The matrix asks for no
// score, so it taps `none`, which writes `{rung, winner}` and no `score` key. Lots is NOT here: it is the organiser's
// core.settle (X-ST-2), and the pad refuses to emit it.
//
// W2c Task 21 (S5, BG-KO-2): the Armageddon is no longer a winner tap. The scorer records FACTS — who had Black
// (`black-home` / `black-away`), then how it ended (`result-white` / `result-black` / `result-draw`) — and the sheet closes
// on a read-back step whose one Confirm (`pad-sheet-confirm`, the bench driver's `confirm` TapStep) writes
// `{rung, black, result}`. The ENGINE decides who advances: White won → the other entrant; Black won or drawn → Black.
// So the generator's `winner` is Black here, and a drawn Armageddon is one more `result-draw` tap, never a winner tap.
import { ARMAGEDDON_RESULTS, TIEBREAK_RUNGS, effectiveRungs, type TiebreakRung } from "@seazn/engine/sports/boardgame";
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
/** The rung whose sheet records Black and a result instead of a winner and a score (BG-KO-2). */
export const ARMAGEDDON = "armageddon";
/** boardgame.tsx BLACK_OPTION_PREFIX / RESULT_OPTION_PREFIX: the Armageddon sheet's option ids are `black-<side>` and
 *  `result-<result>` (text-pinned in pad-adapters.test.ts). */
export const BLACK_OPTION_PREFIX = "black-";
export const RESULT_OPTION_PREFIX = "result-";
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

/** W2c design pass: the rungs the stage plays (`effectiveRungs`: the list in its order, else every rung). The pad asks "which
 *  tie-break?" only when there is more than one to choose from, so the rung tap is part of the route only then; a one-rung
 *  stage opens straight on that rung's first step (boardgame.tsx `tiebreakSheet`'s `only`). */
function playedRungs(ctx: TapAdapterContext): readonly TiebreakRung[] {
  return effectiveRungs({ tiebreakRungs: (ctx.cfg as { tiebreakRungs?: TiebreakRung[] } | null)?.tiebreakRungs });
}
/** The tile, then the rung pick WHEN the pad shows one, and refuses a rung the stage does not play (the pad cannot author it). */
function tiebreakOpening(rung: string, ctx: TapAdapterContext): readonly TapStep[] {
  const played = playedRungs(ctx);
  if (!(played as readonly string[]).includes(rung)) {
    throw new Error(`boardgamePad: ${BOARDGAME_TIEBREAK} for the ${rung} rung, but the stage does not play the ${rung} rung (it plays ${played.length === 0 ? "none" : played.join(", ")}): the pad cannot author it`);
  }
  return played.length === 1 ? [{ kind: "tile", tileId: BOARDGAME_TIEBREAK_TILE }] : [{ kind: "tile", tileId: BOARDGAME_TIEBREAK_TILE }, { kind: "choice", optionId: rung }];
}

function tiebreakSteps(payload: unknown, ctx: TapAdapterContext): readonly TapStep[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const rung = typeof p.rung === "string" && (TIEBREAK_RUNGS as readonly string[]).includes(p.rung) ? p.rung : null;
  if (rung === ARMAGEDDON) return armageddonSteps(payload, p, keys, ctx);
  const side = p.winner === ctx.entrants.home ? "home" : p.winner === ctx.entrants.away ? "away" : null;
  if (payload === null || typeof payload !== "object" || keys.length !== 2 || keys[0] !== "rung" || keys[1] !== "winner" || rung === null || side === null) {
    throw new Error(`boardgamePad: ${BOARDGAME_TIEBREAK} payload ${JSON.stringify(payload)} is not {rung: one of ${TIEBREAK_RUNGS.join(", ")}, winner: an entrant of the fixture}`);
  }
  return [...tiebreakOpening(rung, ctx), { kind: "choice", optionId: side }, { kind: "choice", optionId: TIEBREAK_SCORE_NONE }];
}

/** BG-KO-2: `{rung: "armageddon", black: <an entrant>, result: <one of the engine's>}` and nothing else. The old
 *  `{rung, winner}` shape is gone (the engine refuses it), so a payload carrying a winner is refused here by name too. */
function armageddonSteps(payload: unknown, p: Record<string, unknown>, keys: readonly string[], ctx: TapAdapterContext): readonly TapStep[] {
  const side = p.black === ctx.entrants.home ? "home" : p.black === ctx.entrants.away ? "away" : null;
  const result = typeof p.result === "string" && (ARMAGEDDON_RESULTS as readonly string[]).includes(p.result) ? p.result : null;
  if (payload === null || typeof payload !== "object" || keys.length !== 3 || keys[0] !== "black" || keys[1] !== "result" || keys[2] !== "rung" || side === null || result === null) {
    throw new Error(`boardgamePad: ${BOARDGAME_TIEBREAK} payload ${JSON.stringify(payload)} is not {rung: ${ARMAGEDDON}, black: an entrant of the fixture, result: one of ${ARMAGEDDON_RESULTS.join(", ")}}`);
  }
  return [
    ...tiebreakOpening(ARMAGEDDON, ctx),
    { kind: "choice", optionId: `${BLACK_OPTION_PREFIX}${side}` },
    { kind: "choice", optionId: `${RESULT_OPTION_PREFIX}${result}` },
    { kind: "confirm" },
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
