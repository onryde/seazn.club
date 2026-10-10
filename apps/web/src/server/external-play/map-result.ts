import type { BoardgameMethod, BoardgameResult } from "@seazn/engine/sports/boardgame";
import { isLichessStatus, type LichessGameSnapshot, type LichessStatus } from "./types";

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

/** Lichess status → boardgame method when the game has a decisive/draw finish.
 *  Keyed by `LichessStatus`, so a status Lichess does not declare cannot be a
 *  key: the three this table used to carry (`insufficientMaterialDraw`,
 *  `fiftyMoveRuleDraw`, `threefoldRepetitionDraw`) are not in the OpenAPI
 *  enum or scalachess Status.scala, and an export carrying one never reaches
 *  here (board-api.ts validates the status). Lichess reports those endings as
 *  `draw`. Read by usecases/external-play/result.ts (T12) for the method. */
export const STATUS_METHOD: Readonly<Partial<Record<LichessStatus, BoardgameMethod>>> = {
  mate: "checkmate",
  resign: "resign",
  timeout: "time",
  outoftime: "time",
  stalemate: "stalemate",
  draw: "agreement",
  // scalachess Status.scala: "the side that cannot lose claims a draw" —
  // a draw on the material rule (controller addendum 1, T12).
  insufficientMaterialClaim: "insufficient",
  variantEnd: "adjudication",
};

/** The statuses STATUS_METHOD names, for the spec-agreement test. */
export const STATUS_METHOD_KEYS: readonly string[] = Object.keys(STATUS_METHOD);

/**
 * Map a finished Lichess game onto a boardgame.result payload.
 * LEGACY, with no production caller (only its own test): it assumes the home
 * entrant is White. That has been false since `whiteSideOf` (guard.ts) — a
 * pairing card can give White to away, and colour is read from the pairing
 * and recorded as the bridge row's `white_side`. The live writer,
 * usecases/external-play/result.ts, attributes the winner through that.
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

  const method = isLichessStatus(game.status) ? STATUS_METHOD[game.status] : undefined;
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
