import "server-only";
// Final review M-9: an organiser's settle ends the Lichess game too. The result is ours (written first, through the
// scoring path); this only stops the game at Lichess, so both players cannot play on at lichess.org towards an
// outcome nobody will record. Best effort, after the settle: every failure is logged and none reaches the settle.
//
// The rules (brief ruling):
//   - fewer than 2 plies: abort, with either token (lila: a resign before ply 2 is an abort anyway, M9);
//   - a decided winner: resign with the LOSER's token;
//   - a draw: offer and accept a draw with both tokens (`draw/yes` offers, or accepts a standing offer);
//   - void: abort if it can still be aborted, otherwise offer and accept a draw.
// Our ply count can lag Lichess (a move played at lichess.org directly), so an abort Lichess refuses falls through to
// the rule for the settle itself.
import { sql } from "@/lib/db";
import {
  abortGame as realAbortGame,
  offerOrAcceptDraw as realOfferOrAcceptDraw,
  resignGame as realResignGame,
} from "@/server/external-play/lichess/board-api";
import type { BoardCall } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { getLichessAccessToken } from "../external-accounts";
import type { Side } from "./guard";
import { DRAW_REOFFER_PLIES } from "./play";

type Colour = "white" | "black";

/** How the settle decided the board. */
export type EndDecision = { kind: "win"; loser: Side } | { kind: "draw" } | { kind: "void" };

/** A game on file that Lichess may still be playing: created, its colours recorded, and no read has seen it end. */
export type GameToEnd = {
  fixtureId: string;
  gameId: string;
  whiteSide: Side;
  lichessIds: Record<Colour, string>;
  ply: number;
  /** The standing draw offer on file, and each side's last offer's ply (V454) — lila's draw rules read both. */
  drawOfferBy: Colour | null;
  offerPly: Record<Colour, number | null>;
};

export type EndGameDeps = {
  accessToken?: (userId: string) => Promise<string | null>;
  resignGame?: (a: { token: string; gameId: string }) => Promise<BoardCall>;
  abortGame?: (a: { token: string; gameId: string }) => Promise<BoardCall>;
  offerOrAcceptDraw?: (a: { token: string; gameId: string; accept: boolean }) => Promise<BoardCall>;
};

/** Below this, Lichess aborts rather than ends a game (lila: abortable before both sides have moved). */
const ABORTABLE_BELOW_PLY = 2;

/** The game a settle should end, read BEFORE the settle closes the bridge. Null when there is none: no game created
 *  yet, colours not recorded (a broken row — play.ts reports it), or the game already ended (`game_over_at`). A
 *  `finished` bridge is never asked: resolve.ts refuses its settle first (ONLINE_GAME_OVER / _NEVER_STARTED). */
export async function gameToEnd(fixtureId: string): Promise<GameToEnd | null> {
  const [row] = await sql<
    {
      gameId: string; whiteSide: Side | null; white: string | null; black: string | null; ply: number;
      drawOfferBy: Colour | null; whiteOfferPly: number | null; blackOfferPly: number | null;
    }[]
  >`
    select challenge_id as "gameId", white_side as "whiteSide", white_lichess_id as white, black_lichess_id as black,
           move_count as ply, draw_offer_by as "drawOfferBy", white_draw_offer_ply as "whiteOfferPly",
           black_draw_offer_ply as "blackOfferPly"
      from fixture_external_play
     where fixture_id = ${fixtureId} and challenge_id is not null and game_over_at is null`;
  if (!row || row.whiteSide === null || row.white === null || row.black === null) return null;
  return {
    fixtureId,
    gameId: row.gameId,
    whiteSide: row.whiteSide,
    lichessIds: { white: row.white, black: row.black },
    ply: row.ply,
    drawOfferBy: row.drawOfferBy,
    offerPly: { white: row.whiteOfferPly, black: row.blackOfferPly },
  };
}

/** The token of whoever holds the Lichess account the game was recorded for — null when no Seazn user holds it now
 *  (unlinked, or re-linked elsewhere: M-2 revoked that grant) or it cannot be opened. */
async function tokenOf(lichessId: string, deps: EndGameDeps): Promise<string | null> {
  const [row] = await sql<{ userId: string }[]>`
    select user_id as "userId" from user_external_accounts
     where provider = 'lichess' and external_user_id = ${lichessId}`;
  if (!row) return null;
  const { userId } = row;
  // Only the token read is caught: a missing row is the guard above's, never this catch's.
  try {
    return await (deps.accessToken ?? getLichessAccessToken)(userId);
  } catch {
    return null; // LICHESS_TOKEN_UNAVAILABLE: getLichessAccessToken has already reported it
  }
}

type Step = "abort" | "resign" | "draw";

const other = (c: Colour): Colour => (c === "white" ? "black" : "white");

/** Who says `draw/yes`, in order, for the game to end drawn — null when nobody may offer. lila's `draw/yes` OFFERS,
 *  or ACCEPTS the opponent's standing offer; and it registers no offer from a side that offered within the last
 *  DRAW_REOFFER_PLIES plies (Game.scala `playerCanOfferDraw`, as play.ts models it) — such a `yes` is a silent no-op,
 *  and the other side's `yes` would then only offer. So: a standing offer is accepted by the other side alone; else
 *  the first side that may offer does, and the other accepts. */
function drawSayers(game: GameToEnd): Colour[] | null {
  if (game.drawOfferBy !== null) return [other(game.drawOfferBy)];
  const mayOffer = (c: Colour) => game.offerPly[c] === null || game.offerPly[c]! < game.ply - DRAW_REOFFER_PLIES;
  const offerer = (["white", "black"] as const).find(mayOffer);
  return offerer === undefined ? null : [offerer, other(offerer)];
}

/** End `game` at Lichess as `decision` says. Never throws; answers whether Lichess accepted the ending's last call. */
export async function endLichessGame(game: GameToEnd, decision: EndDecision, deps: EndGameDeps = {}): Promise<boolean> {
  const tokens: Partial<Record<Colour, string | null>> = {};
  const token = async (c: Colour) => (c in tokens ? tokens[c]! : (tokens[c] = await tokenOf(game.lichessIds[c], deps)));
  const failed = (step: Step, colour: Colour | null, code: string) =>
    log.warn(
      { fixtureId: game.fixtureId, gameId: game.gameId, step, colour, code },
      "lichess: a settled board's game could not be ended at Lichess — it may play on there, unrecorded",
    );
  /** One call by `colour`'s token; false (logged) when there is no token or Lichess refused it. */
  const send = async (step: Step, colour: Colour, call: (tok: string) => Promise<BoardCall>, quiet = false): Promise<boolean> => {
    const tok = await token(colour);
    if (tok === null) {
      if (!quiet) failed(step, colour, "no_token");
      return false;
    }
    let sent: BoardCall;
    try {
      sent = await call(tok);
    } catch {
      sent = { ok: false, code: "unavailable", raw: "" };
    }
    if (!sent.ok && !quiet) failed(step, colour, sent.code);
    return sent.ok;
  };
  const abort = (c: Colour, quiet: boolean) =>
    send("abort", c, (tok) => (deps.abortGame ?? realAbortGame)({ token: tok, gameId: game.gameId }), quiet);
  const drawYes = (c: Colour) =>
    send("draw", c, (tok) => (deps.offerOrAcceptDraw ?? realOfferOrAcceptDraw)({ token: tok, gameId: game.gameId, accept: true }));

  try {
    if (game.ply < ABORTABLE_BELOW_PLY) {
      // Either token: White's, else Black's. A refusal here is not yet a failure — our count can lag Lichess, and the
      // settle's own rule follows.
      if ((await abort("white", true)) || (await abort("black", true))) return true;
    }
    if (decision.kind === "win") {
      const loser: Colour = decision.loser === game.whiteSide ? "white" : "black";
      return await send("resign", loser, (tok) => (deps.resignGame ?? realResignGame)({ token: tok, gameId: game.gameId }));
    }
    // A draw, and a void past the abort: one side offers, the other accepts.
    const sayers = drawSayers(game);
    if (sayers === null) {
      failed("draw", null, "draw_offer_window");
      return false;
    }
    for (const c of sayers) if (!(await drawYes(c))) return false;
    return true;
  } catch (err) {
    log.warn(
      { fixtureId: game.fixtureId, gameId: game.gameId, err: err instanceof Error ? err.message : String(err) },
      "lichess: ending a settled board's game failed",
    );
    return false;
  }
}
