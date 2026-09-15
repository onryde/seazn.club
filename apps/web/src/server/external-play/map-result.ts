import type { BoardgameMethod, BoardgameResult } from "@seazn/engine/sports/boardgame";
import type { LichessGameSnapshot } from "./types";

export type MapResultOk = {
  ok: true;
  type: "boardgame.result";
  payload: BoardgameResult;
};

export type MapResultErr = {
  ok: false;
  reason: "account_mismatch" | "unfinished" | "abort" | "unmapped";
};

export type MapResultInput = {
  game: LichessGameSnapshot;
  homeEntrantId: string;
  awayEntrantId: string;
  homeLichessId: string;
  awayLichessId: string;
};

const UNFINISHED = new Set([
  "created",
  "started",
  "paused", // rare; treat as not finished
]);

const ABORT = new Set(["aborted", "noStart", "unknownFinish"]);

/** Lichess status → boardgame method when the game has a decisive/draw finish. */
const STATUS_METHOD: Record<string, BoardgameMethod> = {
  mate: "checkmate",
  resign: "resign",
  timeout: "time",
  outoftime: "time",
  stalemate: "stalemate",
  draw: "agreement",
  insufficientMaterialDraw: "insufficient",
  fiftyMoveRuleDraw: "fifty_move",
  threefoldRepetitionDraw: "repetition",
  // Lichess also emits these draw-ish statuses:
  variantEnd: "adjudication",
};

/**
 * Map a finished Lichess game onto a boardgame.result payload.
 * Home is always White in Seazn chess fixtures (chess.md §2).
 */
export function mapLichessGameToBoardgameResult(input: MapResultInput): MapResultOk | MapResultErr {
  const { game, homeEntrantId, awayEntrantId, homeLichessId, awayLichessId } = input;

  const whiteId = game.players.white.userId;
  const blackId = game.players.black.userId;
  if (whiteId !== homeLichessId || blackId !== awayLichessId) {
    return { ok: false, reason: "account_mismatch" };
  }

  if (UNFINISHED.has(game.status)) return { ok: false, reason: "unfinished" };
  if (ABORT.has(game.status)) return { ok: false, reason: "abort" };

  const method = STATUS_METHOD[game.status];
  if (!method) return { ok: false, reason: "unmapped" };

  if (game.winner === "white") {
    return {
      ok: true,
      type: "boardgame.result",
      payload: { winner: homeEntrantId, method },
    };
  }
  if (game.winner === "black") {
    return {
      ok: true,
      type: "boardgame.result",
      payload: { winner: awayEntrantId, method },
    };
  }

  // No winner → draw (agreement / stalemate / insufficient / …)
  return {
    ok: true,
    type: "boardgame.result",
    payload: { winner: null, method },
  };
}
