import "server-only";
// The play loop (chess in-page board design §3.4, Task 10). OUR SERVER IS THE
// ONLY MOVER: a player posts an intended move here, we validate it, confirm
// the caller is that colour's player and that it is their turn, and submit it
// with THAT player's own Lichess token. Only a move Lichess accepted is
// recorded in the ledger (V435), and only a recorded move is broadcast.
//
// Lichess decides legality and ends games. This file never adjudicates a
// result and never writes 'finished' (controller ruling Q2): a resign, an
// abort and a draw are forwarded and answered, and T11's reconcile — called by
// T14's act route after a game-ending action, and by T13's sweep — reads the
// end from Lichess. Mid-game truth is this ledger plus the Board API stream;
// the export is never read for moves or clocks (M16).
//
// The append is ONE conditional UPDATE keyed on the move count the caller
// read (create-game.ts's claim/commit shape, without a claim column — a move
// holds nothing between its read and its write that a stale claim could
// block): READ COMMITTED re-checks the predicate on the row a concurrent
// writer left, so the loser of a race updates nothing rather than
// overwriting the winner, and a concurrent clock correction is read, not
// overwritten, because every SET expression is evaluated against that row.
import { Chess } from "chess.js";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { publishRoomBroadcast, type RoomBroadcast } from "@/lib/realtime";
import {
  abortGame as realAbortGame,
  offerOrAcceptDraw as realOfferOrAcceptDraw,
  resignGame as realResignGame,
  submitMove as realSubmitMove,
} from "@/server/external-play/lichess/board-api";
import { assertUci } from "@/server/external-play/lichess/uci";
import type { BoardCall, BoardErrorCode } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { getLichessAccessToken } from "../external-accounts";
import { effectiveBridge, loadOnlinePlayFixture, loadSides, type OnlinePlayFixture, type Side } from "./guard";
import { isPlayableFixtureStatus, playGrantRefusal, type GrantRefusal } from "./preflight";
import type { Colour } from "./invite";

export type PlayAction =
  | { kind: "move"; uci: string }
  | { kind: "resign" }
  /** `accept: true` is lila's `/draw/yes` — it OFFERS, or ACCEPTS a standing
   *  offer; `accept: false` is `/draw/no` — it only DECLINES (ruling Q1). */
  | { kind: "draw"; accept: boolean }
  | { kind: "abort" };

export type PlayResult =
  /** `applied: false` ⇒ nothing changed here: a duplicate absorbed, or a move
   *  Lichess accepted that another writer recorded first. */
  | { ok: true; applied: boolean }
  /** Lichess refused, or may have acted without saying so (`unavailable` on a
   *  5xx MAY have played the move): never "not played" — reconcile (T11). */
  | { ok: false; reconcile: true; reason: BoardErrorCode }
  /** The caller's grant cannot play (ruling Q3), named as seatPlayer names
   *  it, so T14 can draw the re-link screen. No token was read. */
  | { ok: false; reconcile: false; reason: GrantRefusal };

export type PlayDeps = {
  now?: Date;
  submitMove?: (a: { token: string; gameId: string; uci: string }) => Promise<BoardCall>;
  resignGame?: (a: { token: string; gameId: string }) => Promise<BoardCall>;
  offerOrAcceptDraw?: (a: { token: string; gameId: string; accept: boolean }) => Promise<BoardCall>;
  abortGame?: (a: { token: string; gameId: string }) => Promise<BoardCall>;
  accessToken?: (userId: string) => Promise<string | null>;
  publish?: (fixtureId: string, body: RoomBroadcast) => Promise<void>;
};

/** The same 404 the match room answers: "no such fixture", "not your
 *  fixture" and "no game to act on" are one answer, so a caller learns
 *  nothing about a board they do not play on. */
const NOT_FOUND = () => new HttpError(404, "This match room could not be found", "NOT_FOUND");

// lila source, not measured — live measurement owed (T17). lila @
// 3747530a154ab955bfbcd8e2bba58787479098d4:
//   modules/game/src/main/Game.scala:72-80 `playerCanOfferDraw` requires
//   `ply >= 2`, no standing own offer, and not `playerHasOfferedDrawRecently`
//   (`drawOffers.lastBy(color).exists(_ >= g.ply - 20)`).
//   modules/round/src/main/Drawer.scala:43 `yes`: the opponent offering ⇒
//   the draw; else `playerCanOfferDraw` ⇒ an offer (`drawOffers.add(color,
//   g.ply)`); else nothing. Drawer.scala:66 `no`: declines ONLY the
//   opponent's standing offer; the offerer's own "no" changes nothing.
//   modules/round/src/main/MovePlayer.scala:77: a move declines the
//   OPPONENT's standing offer; the mover's own offer survives it.
//   app/controllers/PlayApi.scala `draw/{bool}` answers 200 in every one of
//   these cases, so the HTTP answer cannot tell an offer from a no-op — the
//   rules above are applied to OUR ledger instead.
// Not modelled (each ENDS the game at Lichess, so T11's reconcile corrects
// the row): a "yes" on a threefold repetition (a draw claim) and a "yes" by a
// side that cannot lose (InsufficientMaterialClaim, Drawer.scala:55).
const DRAW_MIN_PLY = 2;
const DRAW_REOFFER_PLIES = 20;

/** Replay a UCI list into a FEN. chess.js (BSD-2) is a RENDERER here, never
 *  an arbiter: Lichess decides legality (spec §1), so a move it accepted and
 *  chess.js rejects stops the replay and leaves the caller to reconcile —
 *  it must not refuse the player's move. Throws nothing. */
export function fenAfter(moves: readonly string[]): { fen: string; replayed: number } {
  const board = new Chess();
  let replayed = 0;
  for (const uci of moves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    try {
      board.move(promotion === undefined ? { from, to } : { from, to, promotion });
    } catch {
      return { fen: board.fen(), replayed };
    }
    replayed++;
  }
  // An empty list is chess.js's own start position — no special case.
  return { fen: board.fen(), replayed };
}

const turnAt = (ply: number): Colour => (ply % 2 === 0 ? "white" : "black");
const otherColour = (c: Colour): Colour => (c === "white" ? "black" : "white");

type Game = {
  fixture: OnlinePlayFixture;
  gameId: string;
  whiteSide: Side;
  whiteLichessId: string;
  blackLichessId: string;
  moves: string[];
  ply: number;
};

/** The game a player may act on, or null. A ready or live bridge with a
 *  game id, on a board that is still playable. */
function playableGame(f: OnlinePlayFixture): Game | null {
  const b = effectiveBridge(f);
  if (!b || b.challenge_id === null) return null;
  // 'finished' and 'needs_organiser' accept nothing; 'pending' has no game.
  if (b.status !== "ready" && b.status !== "live") return null;
  // A withdrawn or walked-over board still loads (guard.ts); T8's predicate
  // is the one authority for "still playable".
  if (!isPlayableFixtureStatus(f.fixtureStatus)) return null;
  // T9 writes the colours and both accounts in the SAME update as the game
  // id, so a game without them is a broken row, not a state. Colour is READ,
  // never assigned or guessed (global constraint) — without it nobody moves.
  if (b.white_side === null || b.white_lichess_id === null || b.black_lichess_id === null) {
    log.error(
      { fixtureId: f.fixtureId, gameId: b.challenge_id },
      "lichess: a game on file carries no recorded colours — no move can be attributed",
    );
    return null;
  }
  return {
    fixture: f,
    gameId: b.challenge_id,
    whiteSide: b.white_side,
    whiteLichessId: b.white_lichess_id,
    blackLichessId: b.black_lichess_id,
    moves: b.moves_uci,
    ply: b.move_count,
  };
}

export async function act(
  a: { fixtureId: string; personId: string; action: PlayAction },
  deps: PlayDeps = {},
): Promise<PlayResult> {
  const { action } = a;
  // 1. SHAPE FIRST. M5: Lichess truncates `e7e6xx` to `e7e6` and plays it,
  //    so an unvalidated client string moves a piece the player never chose.
  //    This throws before anything is read, let alone a token sent.
  if (action.kind === "move") assertUci(action.uci);

  // 2. THE GAME.
  const f = await loadOnlinePlayFixture(a.fixtureId);
  if (!f) throw NOT_FOUND();
  const game = playableGame(f);
  if (!game) throw NOT_FOUND();

  // 3. THE CALLER: one of the two seated people. Colour comes from the
  //    colours T9 RECORDED with the game, never a fresh read of the pairing.
  const { home, away } = await loadSides(f);
  const me = [home, away].find((s) => s.personId === a.personId);
  if (!me) throw NOT_FOUND();
  const colour: Colour = game.whiteSide === me.side ? "white" : "black";

  // 4. THE GRANT, as the seat asks it (T2's one play gate). Named, so T14
  //    can send the player to re-link; a downgraded grant mid-game lands here.
  const refused = await playGrantRefusal(me.userId);
  if (refused) return { ok: false, reconcile: false, reason: refused };
  // 5. THE ACCOUNT the game was created for. A player who re-linked a
  //    different Lichess account cannot move this game with it: that
  //    account is not a player in it. (`userId` is non-null whenever the
  //    grant passed — the gate refuses a null — narrowed here for the token.)
  const recorded = colour === "white" ? game.whiteLichessId : game.blackLichessId;
  if (me.lichess?.id !== recorded || me.userId === null) throw NOT_FOUND();
  const userId = me.userId;

  const now = deps.now ?? new Date();
  const publish = deps.publish ?? publishRoomBroadcast;
  const token = () => (deps.accessToken ?? getLichessAccessToken)(userId);

  switch (action.kind) {
    case "move":
      return playMove(game, colour, action.uci, { token, now, publish, submit: deps.submitMove ?? realSubmitMove });
    case "draw":
      return draw(game, colour, action.accept, { token, now, publish, call: deps.offerOrAcceptDraw ?? realOfferOrAcceptDraw });
    case "resign":
    case "abort": {
      const call = action.kind === "resign" ? (deps.resignGame ?? realResignGame) : (deps.abortGame ?? realAbortGame);
      const tok = await token();
      if (tok === null) return { ok: false, reconcile: false, reason: "lichess_link_required" };
      const sent = await call({ token: tok, gameId: game.gameId });
      // Forwarded and answered — nothing written, nothing broadcast (ruling
      // Q2). A resign at ply < 2 is an abort at Lichess (BotPlayer.scala).
      return sent.ok ? { ok: true, applied: true } : { ok: false, reconcile: true, reason: sent.code };
    }
  }
}

type Ctx<C> = {
  token: () => Promise<string | null>;
  now: Date;
  publish: (fixtureId: string, body: RoomBroadcast) => Promise<void>;
} & C;

type LedgerRow = {
  moves_uci: string[];
  move_count: number;
  /** Both seeded by the append itself (`coalesce` onto the division clock),
   *  so never null on a row an append returns. */
  white_ms: number;
  black_ms: number;
  draw_offer_by: Colour | null;
};

async function playMove(
  game: Game,
  colour: Colour,
  uci: string,
  ctx: Ctx<{ submit: NonNullable<PlayDeps["submitMove"]> }>,
): Promise<PlayResult> {
  const { fixture: f, gameId, ply } = game;
  // TURN, from OUR accepted-move count. M6 collapses "not your turn" and
  // "game already over" into one 400 we could not read, so we answer it here.
  if (turnAt(ply) !== colour) {
    // ABSORB: the tab one move behind re-sends the move already on file.
    // Only while it is NOT the caller's turn — the last move on file is then
    // theirs — so their genuinely different next move is never eaten.
    if (game.moves.at(-1) === uci) return { ok: true, applied: false };
    return { ok: false, reconcile: true, reason: "not_your_turn_or_over" };
  }

  const tok = await ctx.token();
  if (tok === null) return { ok: false, reconcile: false, reason: "lichess_link_required" };
  const sent = await ctx.submit({ token: tok, gameId, uci });
  if (!sent.ok) {
    // A twin tab's identical move won the race at Lichess and ours was
    // refused as out of turn: the move the player chose IS played.
    if (sent.code === "not_your_turn_or_over" && (await ledgerOnFile(f.fixtureId, gameId))?.[ply] === uci) {
      return { ok: true, applied: false };
    }
    // Nothing is written on a refusal — and `unavailable` (a 5xx, a timeout)
    // MAY have played the move, so it is never recorded as "not played".
    return { ok: false, reconcile: true, reason: sent.code };
  }

  const limitMs = f.clock.limit * 1000;
  const moverCol = colour === "white" ? "white_ms" : "black_ms";
  const waitingCol = colour === "white" ? "black_ms" : "white_ms";
  // Clocks are RENDERED, never adjudicated: nothing here declares a flag
  // (spec §6, M2). scalachess Clock.step (2ab0a403): the clock is not
  // running until both sides have moved, so the first two plies cost
  // nothing and earn nothing; after that the mover pays the time since the
  // last move and earns the increment only if time remained. Clamped at
  // zero; a negative elapsed (clock skew) counts as none.
  const mover = sql`coalesce(${sql(moverCol)}, ${limitMs})`;
  const elapsed = sql`coalesce(greatest(0, floor(extract(epoch from (${ctx.now}::timestamptz - last_move_at)) * 1000))::bigint, 0)`;
  const appended = await sql<LedgerRow[]>`
    update fixture_external_play
       set moves_uci = moves_uci || jsonb_build_array(${uci}::text),
           move_count = move_count + 1,
           status = 'live',
           started_at = coalesce(started_at, ${ctx.now}),
           last_move_at = ${ctx.now},
           clock_increment_s = coalesce(clock_increment_s, ${f.clock.increment}),
           ${sql(moverCol)} = case
             when move_count < 2 then ${mover}
             when ${mover} - ${elapsed} > 0
               then ${mover} - ${elapsed} + coalesce(clock_increment_s, ${f.clock.increment}) * 1000
             else 0
           end,
           ${sql(waitingCol)} = coalesce(${sql(waitingCol)}, ${limitMs}),
           draw_offer_by = case when draw_offer_by = ${otherColour(colour)} then null else draw_offer_by end,
           updated_at = now()
     where fixture_id = ${f.fixtureId}
       and challenge_id = ${gameId}
       and status in ('ready', 'live')
       and move_count = ${ply}
     returning moves_uci, move_count, white_ms, black_ms, draw_offer_by`;
  const [row] = appended;
  if (!row) {
    // Lost the race: another writer moved the ledger first. Our move at our
    // ply ⇒ it is recorded (a twin tab, or reconcile adopting the stream).
    if ((await ledgerOnFile(f.fixtureId, gameId))?.[ply] !== uci) {
      log.warn(
        { fixtureId: f.fixtureId, gameId, ply },
        "lichess: accepted a move the ledger could not record — left to reconcile",
      );
    }
    return { ok: true, applied: false };
  }

  // The ledger is Lichess's record; the FEN is ours. If chess.js cannot
  // replay what Lichess accepted, broadcasting would show the wrong board.
  const replay = fenAfter(row.moves_uci);
  if (replay.replayed !== row.moves_uci.length) {
    log.error(
      { fixtureId: f.fixtureId, gameId, replayed: replay.replayed, moveCount: row.move_count },
      "lichess: an accepted move does not replay — nothing broadcast, left to reconcile",
    );
    return { ok: false, reconcile: true, reason: "unavailable" };
  }
  await ctx.publish(f.fixtureId, {
    fen: replay.fen,
    lastMove: uci,
    turn: turnAt(row.move_count),
    whiteMs: row.white_ms,
    blackMs: row.black_ms,
    status: "started",
    drawOfferBy: row.draw_offer_by,
  });
  return { ok: true, applied: true };
}

async function ledgerOnFile(fixtureId: string, gameId: string): Promise<string[] | null> {
  const [row] = await sql<{ moves_uci: string[] }[]>`
    select moves_uci from fixture_external_play where fixture_id = ${fixtureId} and challenge_id = ${gameId}`;
  return row?.moves_uci ?? null;
}

type DrawRow = {
  moves_uci: string[];
  move_count: number;
  white_ms: number | null;
  black_ms: number | null;
  last_move_at: Date | null;
  draw_offer_by: Colour | null;
};

async function draw(
  game: Game,
  colour: Colour,
  accept: boolean,
  ctx: Ctx<{ call: NonNullable<PlayDeps["offerOrAcceptDraw"]> }>,
): Promise<PlayResult> {
  const { fixture: f, gameId } = game;
  const tok = await ctx.token();
  if (tok === null) return { ok: false, reconcile: false, reason: "lichess_link_required" };
  const sent = await ctx.call({ token: tok, gameId, accept });
  // Nothing written on a refusal, nor on a 5xx — which MAY have registered.
  if (!sent.ok) return { ok: false, reconcile: true, reason: sent.code };

  const offerPlyCol = colour === "white" ? "white_draw_offer_ply" : "black_draw_offer_ply";
  // Each transition is applied to the row AS IT STANDS, not to our snapshot,
  // in one conditional UPDATE. Every case it does not match is a no-op at
  // Lichess too (see the lila notes above), so nothing is written:
  //   yes, opponent offering — the draw (the END is reconcile's to record);
  //   yes, own offer standing; yes before ply 2; yes within 20 plies of
  //   this side's last offer; no, with no opponent offer standing.
  const changed = accept
    ? await sql<DrawRow[]>`
        update fixture_external_play
           set draw_offer_by = ${colour}, ${sql(offerPlyCol)} = move_count, updated_at = now()
         where fixture_id = ${f.fixtureId} and challenge_id = ${gameId}
           and status in ('ready', 'live')
           and draw_offer_by is null
           and move_count >= ${DRAW_MIN_PLY}
           and (${sql(offerPlyCol)} is null or ${sql(offerPlyCol)} < move_count - ${DRAW_REOFFER_PLIES})
         returning moves_uci, move_count, white_ms, black_ms, last_move_at, draw_offer_by`
    : await sql<DrawRow[]>`
        update fixture_external_play
           set draw_offer_by = null, updated_at = now()
         where fixture_id = ${f.fixtureId} and challenge_id = ${gameId}
           and status in ('ready', 'live')
           and draw_offer_by = ${otherColour(colour)}
         returning moves_uci, move_count, white_ms, black_ms, last_move_at, draw_offer_by`;
  const [row] = changed;
  const body = row ? drawBroadcast(f, row, ctx.now) : null;
  if (body) await ctx.publish(f.fixtureId, body);
  return { ok: true, applied: true };
}

/** The room state when only the draw offer changed: the board as it stands,
 *  and the clocks as they read NOW — the side to move's clock has been
 *  running since the last move (once both sides have moved), so the stored
 *  value would jump back on every screen. Rendering only; clamped at zero. */
function drawBroadcast(f: OnlinePlayFixture, row: DrawRow, now: Date): RoomBroadcast | null {
  // As after a move: a ledger chess.js cannot replay is never broadcast.
  const replay = fenAfter(row.moves_uci);
  if (replay.replayed !== row.moves_uci.length) return null;
  const limitMs = f.clock.limit * 1000;
  let whiteMs = row.white_ms ?? limitMs;
  let blackMs = row.black_ms ?? limitMs;
  const turn = turnAt(row.move_count);
  if (row.move_count >= 2 && row.last_move_at !== null) {
    const elapsed = Math.max(0, now.getTime() - row.last_move_at.getTime());
    if (turn === "white") whiteMs = Math.max(0, whiteMs - elapsed);
    else blackMs = Math.max(0, blackMs - elapsed);
  }
  return {
    fen: replay.fen,
    lastMove: row.moves_uci.at(-1) ?? null,
    turn,
    whiteMs,
    blackMs,
    status: "started",
    drawOfferBy: row.draw_offer_by,
  };
}
