import "server-only";
// The play loop (chess in-page board design §3.4, Task 10). OUR SERVER IS THE
// ONLY MOVER: a player posts an intended move here, we validate it, confirm
// the caller is that colour's player and that it is their turn, and submit it
// with THAT player's own Lichess token. Only a move Lichess accepted is
// recorded in the ledger (V436), and only a recorded move is broadcast.
//
// Lichess decides legality and ends games. This file never adjudicates a
// result and never writes 'finished' (controller ruling Q2): a resign, an
// abort and a draw are forwarded and answered, and T11's reconcile — called by
// T14's act route after a game-ending action, by T13's sweep, and from HERE
// when Lichess rejects a move we submitted (spec §3.5's first trigger; T11
// review I4) — reads the end from Lichess. Mid-game truth is this ledger plus the Board API stream;
// the export is never read for moves or clocks (M16).
//
// The append is ONE conditional UPDATE keyed on the move count the caller
// read (create-game.ts's claim/commit shape, without a claim column — a move
// holds nothing between its read and its write that a stale claim could
// block): READ COMMITTED re-checks the predicate on the row a concurrent
// writer left, so the loser of a race updates nothing rather than
// overwriting the winner, and a concurrent clock correction is read, not
// overwritten, because every SET expression is evaluated against that row.
import { Chess, type Square } from "chess.js";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { publishRoomBroadcast, type RoomBroadcast } from "@/lib/realtime";
import {
  abortGame as realAbortGame,
  offerOrAcceptDraw as realOfferOrAcceptDraw,
  resignGame as realResignGame,
  submitMove as realSubmitMove,
} from "@/server/external-play/lichess/board-api";
import { assertUci, invalidUci } from "@/server/external-play/lichess/uci";
import type { BoardCall, BoardErrorCode } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { getLichessAccessToken } from "../external-accounts";
import { effectiveBridge, loadOnlinePlayFixture, loadSides, type OnlinePlayFixture, type Side, type SidePlayer } from "./guard";
import { isPlayableFixtureStatus, playGrantRefusal, type GrantRefusal } from "./preflight";
import type { Colour } from "./invite";
import { holdForOrganiser } from "./result";
import type { SubmittedMove } from "./reconcile";
import { deferred } from "@/lib/deferred";

export type PlayAction =
  | { kind: "move"; uci: string }
  | { kind: "resign" }
  /** `accept: true` is lila's `/draw/yes` — it OFFERS, or ACCEPTS a standing
   *  offer; `accept: false` is `/draw/no` — it only DECLINES (ruling Q1). */
  | { kind: "draw"; accept: boolean }
  | { kind: "abort" };

export type PlayResult =
  /** `applied: false` ⇒ nothing changed here: a duplicate absorbed, or a move
   *  Lichess accepted that another writer recorded first. `ended: true` ⇒
   *  the move we just recorded ENDED the game at Lichess — checkmate,
   *  stalemate, insufficient material or the fifty-move rule on the replayed
   *  board (controller rulings on review I2, round 1b). A report, not a result: T10 writes no status, and
   *  T14 calls reconcile(game_end) on it. Absent on every other answer. */
  | { ok: true; applied: boolean; ended?: true }
  /** Lichess refused, or may have acted without saying so (`unavailable` on a
   *  5xx MAY have played the move): never "not played" — reconcile (T11). */
  | { ok: false; reconcile: true; reason: BoardErrorCode }
  /** The move WAS played and IS recorded, but chess.js cannot replay the
   *  ledger, so no board was broadcast. Not a refusal and not "may not have
   *  landed" — T14 must not tell the player either; reconcile redraws it. */
  | { ok: false; reconcile: true; reason: "unreplayable" }
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
  /** T11's reconcile, run when Lichess rejects a move we submitted, told
   *  what was sent (review N1). Imported lazily by default: reconcile.ts
   *  imports this module's `fenAfter`. */
  reconcile?: (fixtureId: string, trigger: "rejected_move", submitted: SubmittedMove) => Promise<unknown>;
  /** Runs work AFTER the player's answer (review N3): the repo's `deferred`
   *  — Next's after() in a request scope, at once outside one. */
  defer?: (task: () => Promise<void>) => void;
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

/** The board after `moves`, as far as chess.js can follow them, and how
 *  many it applied. An empty list is chess.js's own start position. */
function replay(moves: readonly string[]): { board: Chess; replayed: number } {
  const board = new Chess();
  let replayed = 0;
  for (const uci of moves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    try {
      board.move(promotion === undefined ? { from, to } : { from, to, promotion });
    } catch {
      break;
    }
    replayed++;
  }
  return { board, replayed };
}

/** Replay a UCI list into a FEN. chess.js (BSD-2) is a RENDERER here, never
 *  an arbiter: Lichess decides legality (spec §1), so a move it accepted and
 *  chess.js rejects stops the replay and leaves the caller to reconcile —
 *  it must not refuse the player's move. Throws nothing. */
export function fenAfter(moves: readonly string[]): { fen: string; replayed: number; san: string[] } {
  const { board, replayed } = replay(moves);
  // The replayed plies in standard notation — the spectators' move list (T16 fix round 1, I4).
  return { fen: board.fen(), replayed, san: board.history() };
}

// lila source, not measured — live measurement owed (T17). Two well-formed
// strings lila PLAYS that chess.js (and lila's own move stream) write
// differently, scalachess @ 2ab0a403d7f4a8a3a6dec2e898e6b4c301d0aaad:
//   Position.scala:401 — a standard castle takes BOTH its rook's square and
//   the king's target as the king's destination (`destInput = List(rook,
//   kingTo)`): `e1h1` is O-O, recorded by lila as `e1g1`.
//   variant/Variant.scala:112-117 `findMove` — a pawn move to the last rank
//   with no suffix is played as a QUEEN ("lichobile will send … b2a1 instead
//   of b2a1q"). The same lookup REFUSES a suffix on a move that does not
//   promote (`m.promotion == promotion`), so that form never reaches us.
// Recorded verbatim, either one stops chess.js's replay for the rest of the
// game, so no later move is ever broadcast (review I1).
/** The move string the ledger records for `uci`, judged in the position
 *  after `moves`: a king-to-rook castle is rewritten to the king's own move;
 *  a promotion with no suffix is REFUSED (400, nothing sent) — lila would
 *  pick a queen the player never chose, M5's class of surprise. Anything
 *  else is returned as it came, for Lichess to judge — and so is everything
 *  when chess.js cannot follow the ledger: a position it only half-knows is
 *  no ground for rewriting or refusing a move. */
function canonicalUci(moves: readonly string[], uci: string): string {
  const { board, replayed } = replay(moves);
  if (replayed !== moves.length || uci.length !== 4) return uci;
  const to = uci.slice(2, 4);
  for (const m of board.moves({ square: uci.slice(0, 2) as Square, verbose: true })) {
    if (m.to === to && m.promotion !== undefined) throw invalidUci();
    // A king cannot capture its own rook, so the rook's square names the
    // castle and nothing else — chess.js says whether that castle is legal.
    const rookSquare = m.isKingsideCastle() ? `h${m.from[1]}` : m.isQueensideCastle() ? `a${m.from[1]}` : null;
    if (rookSquare === to) return m.lan;
  }
  return uci;
}

const turnAt = (ply: number): Colour => (ply % 2 === 0 ? "white" : "black");
const otherColour = (c: Colour): Colour => (c === "white" ? "black" : "white");

export type Game = {
  fixture: OnlinePlayFixture;
  gameId: string;
  whiteSide: Side;
  whiteLichessId: string;
  blackLichessId: string;
  moves: string[];
  ply: number;
  /** The seats that may not act: none on a ready/live game; on a
   *  token_revoked hold, the revoked seat (both when it was not recorded). */
  frozen: readonly Colour[];
};

/** Who may not act on this bridge, or null when nobody may. Controller ruling
 *  M7 (2026-10-11): a token_revoked hold freezes ONLY the revoked seat — the
 *  other player keeps playing and can still win on the clock, since freezing
 *  the innocent side would hand the flag to the player whose token broke.
 *  Every other hold, 'finished' and 'pending' accept nothing. */
function frozenSeats(b: { status: string; needs_reason: string | null; revoked_seat: Colour | "both" | null }): readonly Colour[] | null {
  if (b.status === "ready" || b.status === "live") return [];
  if (b.status === "needs_organiser" && b.needs_reason === "token_revoked") {
    if (b.revoked_seat === "white" || b.revoked_seat === "black") return [b.revoked_seat];
    return ["white", "black"];
  }
  return null;
}

/** Broken game rows already reported by this process (review N2): the room
 *  polls this predicate every few seconds per player, so one error per board
 *  is the signal — one per poll is noise that buries it. Bounded: past the
 *  cap it starts over, and a board still broken then is reported again. */
const BROKEN_ROWS_REPORTED = new Set<string>();
const BROKEN_ROWS_REPORTED_MAX = 1_000;
function reportBrokenRowOnce(fixtureId: string, gameId: string): void {
  const key = `${fixtureId}:${gameId}`;
  if (BROKEN_ROWS_REPORTED.has(key)) return;
  if (BROKEN_ROWS_REPORTED.size >= BROKEN_ROWS_REPORTED_MAX) BROKEN_ROWS_REPORTED.clear();
  BROKEN_ROWS_REPORTED.add(key);
  log.error({ fixtureId, gameId }, "lichess: a game on file carries no recorded colours — no move can be attributed");
}

/** The game a player may act on, or null. A ready or live bridge with a
 *  game id, on a board that is still playable. Exported so the match room
 *  (room.ts) tells a player they may act by THIS predicate — one authority,
 *  never a second reading of the bridge (T14 review I2). */
export function playableGame(f: OnlinePlayFixture): Game | null {
  const b = effectiveBridge(f);
  if (!b || b.challenge_id === null) return null;
  // 'finished' and every other hold accept nothing; 'pending' has no game.
  const frozen = frozenSeats(b);
  if (frozen === null) return null;
  // A withdrawn or walked-over board still loads (guard.ts); T8's predicate
  // is the one authority for "still playable".
  if (!isPlayableFixtureStatus(f.fixtureStatus)) return null;
  // T9 writes the colours and both accounts in the SAME update as the game
  // id, so a game without them is a broken row, not a state. Colour is READ,
  // never assigned or guessed (global constraint) — without it nobody moves.
  if (b.white_side === null || b.white_lichess_id === null || b.black_lichess_id === null) {
    reportBrokenRowOnce(f.fixtureId, b.challenge_id);
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
    frozen,
  };
}

/** Why play.ts refuses a seated player's act on the game on file. */
export type ActRefusal =
  /** A token_revoked hold froze this seat (ruling M7). */
  | "frozen"
  /** The seat's linked Lichess account is not the one T9 recorded for this
   *  game — re-linked to another account, or unlinked — or the seat has no
   *  user to hold a token. That account is not a player in the game. The
   *  answer carries the RECORDED account, so the room can name it (T14
   *  re-review 6, N-2). */
  | "account";

/**
 * Whether play.ts takes this seated player's act on a playable game: the
 * seat's colour (from the colours T9 RECORDED, never the pairing) and the
 * refusal, or null with the user whose token plays it. ONE authority (T14
 * re-review 5, I-2): `act` below and the match room's `canAct` (room.ts)
 * both read THIS, so the room never offers a live board this refuses. T2's
 * grant gate is not here: it is asked per act and answered by name (the
 * room's re-link screen), between the freeze and the account (act's order).
 */
export function actAcceptance(
  game: Game,
  me: Pick<SidePlayer, "side" | "lichess" | "userId">,
):
  | { colour: Colour; refused: "frozen" }
  | { colour: Colour; refused: "account"; recorded: string }
  | { colour: Colour; refused: null; userId: string } {
  const colour: Colour = game.whiteSide === me.side ? "white" : "black";
  if (game.frozen.includes(colour)) return { colour, refused: "frozen" };
  const recorded = colour === "white" ? game.whiteLichessId : game.blackLichessId;
  if (me.lichess?.id !== recorded || me.userId === null) return { colour, refused: "account", recorded };
  return { colour, refused: null, userId: me.userId };
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
  // The seat's acceptance — the predicate the room's canAct reads too.
  const seat = actAcceptance(game, me);
  const { colour } = seat;
  // A seat a revoked token froze acts on nothing — the same 404 as a held
  // board (ruling M7); its opponent plays on.
  if (seat.refused === "frozen") throw NOT_FOUND();

  // 4. THE GRANT, as the seat asks it (T2's one play gate). Named, so T14
  //    can send the player to re-link; a downgraded grant mid-game lands here.
  const refused = await playGrantRefusal(me.userId);
  if (refused) return { ok: false, reconcile: false, reason: refused };
  // 5. THE ACCOUNT the game was created for. A player who re-linked a
  //    different Lichess account cannot move this game with it: that
  //    account is not a player in it (actAcceptance's "account").
  if (seat.refused !== null) throw NOT_FOUND();
  const userId = seat.userId;

  const now = deps.now ?? new Date();
  const publish = deps.publish ?? publishRoomBroadcast;
  const token = () => (deps.accessToken ?? getLichessAccessToken)(userId);
  const lichessRefused = (code: BoardErrorCode, what: Refused) => afterRefusal(game, colour, code, what, deps);

  switch (action.kind) {
    case "move":
      return playMove(game, colour, action.uci, { token, now, publish, refused: lichessRefused, submit: deps.submitMove ?? realSubmitMove });
    case "draw":
      return draw(game, colour, action.accept, { token, now, publish, refused: lichessRefused, call: deps.offerOrAcceptDraw ?? realOfferOrAcceptDraw });
    case "resign":
    case "abort": {
      const call = action.kind === "resign" ? (deps.resignGame ?? realResignGame) : (deps.abortGame ?? realAbortGame);
      const tok = await token();
      if (tok === null) return { ok: false, reconcile: false, reason: "lichess_link_required" };
      const sent = await call({ token: tok, gameId: game.gameId });
      // Forwarded and answered — nothing written, nothing broadcast (ruling
      // Q2). A resign at ply < 2 is an abort at Lichess (BotPlayer.scala).
      if (sent.ok) return { ok: true, applied: true };
      await lichessRefused(sent.code, { kind: action.kind });
      return { ok: false, reconcile: true, reason: sent.code };
    }
  }
}

/** What follows a refusal Lichess gave to a call we SENT (never to one of our
 *  own refusals, which reach Lichess with nothing):
 *  - `unauthorized` — the caller's token is revoked or lacks the scope: hold
 *    the board for the organiser as token_revoked, recording THIS seat, so
 *    only this seat is frozen (spec §3.6: not a no-show; ruling M7);
 *  - a MOVE refused — spec §3.5's first trigger: M6's 400 covers "not your
 *    turn" and "game over" alike, and a 5xx may have played it, so reconcile
 *    reads Lichess, never assumes (T11 review I4). Not on a 429: the limit
 *    stops every call, reconcile's read included, until it passes. It is
 *    told the move we sent, so a 5xx that DID play it is adopted as ours,
 *    never flagged as out-of-band (review N1); and it runs AFTER the answer
 *    — three Lichess reads of up to 10 s each must not hold a player's
 *    refused move (review N3). */
async function afterRefusal(
  game: Game,
  colour: Colour,
  code: BoardErrorCode,
  what: Refused,
  deps: PlayDeps,
): Promise<void> {
  const fixtureId = game.fixture.fixtureId;
  const kind = what.kind;
  if (code === "unauthorized") {
    await holdForOrganiser({
      fixtureId,
      reason: "token_revoked",
      seat: colour,
      detail: `lichess game ${game.gameId}: Lichess refused ${colour}'s token (${kind})`,
    });
  }
  if (what.kind !== "move" || code === "rate_limited") return;
  const submitted = what.submitted;
  const run =
    deps.reconcile ??
    (async (id: string, t: "rejected_move", sub: SubmittedMove) => (await import("./reconcile")).reconcile(id, t, {}, sub));
  (deps.defer ?? deferred)(async () => {
    try {
      await run(fixtureId, "rejected_move", submitted);
    } catch (err) {
      // The player's answer is the refusal either way; a reconcile that could
      // not run is the sweep's to repeat. Logged by code — never the error's
      // body, which could carry a Lichess answer.
      log.error(
        { fixtureId, gameId: game.gameId, code: err instanceof HttpError ? err.code : "unexpected" },
        "lichess: reconcile after a rejected move failed — left to the sweep",
      );
    }
  });
}

/** The act Lichess refused: a move carries what was sent, at which ply. */
type Refused = { kind: "move"; submitted: SubmittedMove } | { kind: Exclude<PlayAction["kind"], "move"> };

type Ctx<C> = {
  token: () => Promise<string | null>;
  now: Date;
  publish: (fixtureId: string, body: RoomBroadcast) => Promise<void>;
  refused: (code: BoardErrorCode, what: Refused) => Promise<void>;
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

/** The row, AS IT STANDS at the write, still takes `colour`'s act: a running
 *  game, or a token_revoked hold that froze the OTHER seat only (ruling M7).
 *  Re-checked in SQL, so a hold landing between our read and our write — or
 *  widening to this seat — refuses the write. */
const actable = (colour: Colour) =>
  sql`(status in ('ready', 'live')
       or (status = 'needs_organiser' and needs_reason = 'token_revoked' and revoked_seat = ${otherColour(colour)}))`;

async function playMove(
  game: Game,
  colour: Colour,
  sent: string,
  ctx: Ctx<{ submit: NonNullable<PlayDeps["submitMove"]> }>,
): Promise<PlayResult> {
  const { fixture: f, gameId, ply } = game;
  // TURN, from OUR accepted-move count. M6 collapses "not your turn" and
  // "game already over" into one 400 we could not read, so we answer it here.
  if (turnAt(ply) !== colour) {
    // ABSORB: the tab one move behind re-sends the move already on file.
    // Only while it is NOT the caller's turn — the last move on file is then
    // theirs — so their genuinely different next move is never eaten.
    // Canonical against canonical, judged where it was played: before the
    // last move on file, so `e1h1` re-sent is the `e1g1` it became.
    if (canonicalUci(game.moves.slice(0, -1), sent) === game.moves.at(-1)) return { ok: true, applied: false };
    return { ok: false, reconcile: true, reason: "not_your_turn_or_over" };
  }
  // Everything below — the submit, the twin-tab and lost-append compares,
  // the ledger and the broadcast — speaks the canonical form only.
  const uci = canonicalUci(game.moves, sent);

  const tok = await ctx.token();
  if (tok === null) return { ok: false, reconcile: false, reason: "lichess_link_required" };
  // T13 fix round 1, ruling I4: the submission goes on file BEFORE Lichess
  // hears it, so a reconcile landing between Lichess's 200 and the append
  // below — the 5-minute sweep reads every live game — adopts this very move
  // as ours, never as out-of-band play. Cleared by the append; a refusal or a
  // 5xx leaves it (a 5xx may have played it). It excuses only this ply with
  // this move, so it can never whitewash a different one. Recorded only while
  // the ledger is still at this ply (V436's CHECK: a submission is for the
  // NEXT ply only) — a stale tab records nothing, and never erases the next
  // mover's; Lichess judges its move as before.
  await sql`
    update fixture_external_play
       set pending_move_ply = ${ply}, pending_move_uci = ${uci}, pending_move_at = ${ctx.now}, updated_at = now()
     where fixture_id = ${f.fixtureId} and challenge_id = ${gameId} and move_count = ${ply}`;
  const answer = await ctx.submit({ token: tok, gameId, uci });
  if (!answer.ok) {
    // A twin tab's identical move won the race at Lichess and ours was
    // refused as out of turn: the move the player chose IS played.
    if (answer.code === "not_your_turn_or_over" && (await ledgerOnFile(f.fixtureId, gameId))?.[ply] === uci) {
      return { ok: true, applied: false };
    }
    // Nothing is written on a refusal — and `unavailable` (a 5xx, a timeout)
    // MAY have played the move, so it is never recorded as "not played".
    await ctx.refused(answer.code, { kind: "move", submitted: { ply, uci } });
    return { ok: false, reconcile: true, reason: answer.code };
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
           status = case when status = 'needs_organiser' then status else 'live' end,
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
           -- I4: the only submission the row can hold is this ply's (V436),
           -- and the ledger now holds this ply.
           pending_move_ply = null, pending_move_uci = null, pending_move_at = null,
           updated_at = now()
     where fixture_id = ${f.fixtureId}
       and challenge_id = ${gameId}
       and ${actable(colour)}
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
  const after = replay(row.moves_uci);
  if (after.replayed !== row.moves_uci.length) {
    log.error(
      { fixtureId: f.fixtureId, gameId, replayed: after.replayed, moveCount: row.move_count },
      "lichess: an accepted move does not replay — nothing broadcast, left to reconcile",
    );
    return { ok: false, reconcile: true, reason: "unreplayable" };
  }
  await ctx.publish(f.fixtureId, {
    fen: after.board.fen(),
    lastMove: uci,
    turn: turnAt(row.move_count),
    whiteMs: row.white_ms,
    blackMs: row.black_ms,
    status: "started",
    drawOfferBy: row.draw_offer_by,
  });
  return endsOnTheMove(after.board) ? { ok: true, applied: true, ended: true } : { ok: true, applied: true };
}

// lila source, not measured — T17. scalachess @ 2ab0a403 Position.scala:80
// `end = checkMate || staleMate || autoDraw || variantEnd`: lila ends the
// game ON the move for these. variant/Variant.scala:146-147 `autoDraw =
// isInsufficientMaterial || fiftyMoves(history) || fivefoldRepetition`, and
// :172-173 `fiftyMoves = halfMoveClock >= 100` — chess.js's
// isDrawByFiftyMoves is the same count (half-moves >= 100). FIVEFOLD
// repetition is NOT reported here: chess.js has no predicate for it, so it
// stays with T13's sweep, as do flag falls. Threefold repetition is a CLAIM
// at lila (Drawer `yes`), not an end, though chess.js's isGameOver counts it.
const endsOnTheMove = (b: Chess) =>
  b.isCheckmate() || b.isStalemate() || b.isInsufficientMaterial() || b.isDrawByFiftyMoves();

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
  if (!sent.ok) {
    await ctx.refused(sent.code, { kind: "draw" });
    return { ok: false, reconcile: true, reason: sent.code };
  }

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
           and ${actable(colour)}
           and draw_offer_by is null
           and move_count >= ${DRAW_MIN_PLY}
           and (${sql(offerPlyCol)} is null or ${sql(offerPlyCol)} < move_count - ${DRAW_REOFFER_PLIES})
         returning moves_uci, move_count, white_ms, black_ms, last_move_at, draw_offer_by`
    : await sql<DrawRow[]>`
        update fixture_external_play
           set draw_offer_by = null, updated_at = now()
         where fixture_id = ${f.fixtureId} and challenge_id = ${gameId}
           and ${actable(colour)}
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
  // Every draw broadcast is at ply >= 2, where scalachess's clock runs: a yes
  // is recorded only from ply 2 (its WHERE), and a no needs a standing
  // offer, which V436's draw_offer_by CHECK refuses below ply 2.
  if (row.last_move_at !== null) {
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
