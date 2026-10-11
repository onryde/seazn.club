import "server-only";
// Reconcile (chess in-page board design §3.5, Task 11). The ONE read that
// brings our bridge row in line with Lichess's truth, on exactly five
// triggers; it closes a finished game and hands its result to T12's writer.
//
// THE READ (spec §3.5 as amended in 5903962d4): the Board API stream's first
// line, `gameFull`, opened with a PLAYER's token and closed at once — moves,
// both clocks, status, winner and any standing draw offer. The export STALLS
// mid-game (M16; re-measured 2026-10-11: 5 plies against the stream's 8 at the
// same instant), so it is read only when neither player's token can open the
// stream, and trusted only for a status other than `created`/`started`. Its
// clocks (M11) are never used.
//
// Design ruling M2, kept here verbatim:
//   "M2. The flag spike cannot distinguish "Lichess auto-flags" from "our
//   export read finalises it" — the flag appeared on the first poll after
//   expiry, which is consistent with both. The design says a READ SETTLES THE
//   FLAG. It never says Lichess pushes to us."
// Nothing in this module may be built on a push that was never observed, and
// nothing in this file may declare a flag from our own arithmetic.
//
// MEASURED 2026-10-11 (fixtures README, game Rc11Game): with no read for
// ~3.5 min after the last move (~33 s past White's expiry), the first stream
// read still said `started`
// with `wtime: 0`; a second read 3 s later said `outoftime`, winner Black. A
// read settles the flag, visible on the NEXT read. So on a local clock zero
// we read, and if Lichess still says `started` with the mover's clock at zero
// we read ONCE more after FLAG_REREAD_MS — then leave it to the sweep.
//
// Who writes what on the bridge row: T9 pending → ready; T10 ready → live
// (first accepted move); THIS FILE ready/live → finished (+ finished_at). T12
// writes the ledger result and the needs_organiser holds; T10 and T12 never
// write `finished`.
import { Chess, type Move, type Square } from "chess.js";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { publishRoomBroadcast, type RoomBroadcast } from "@/lib/realtime";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import {
  exportGame as realExportGame,
  readGameStream as realReadGameStream,
  type GameStreamRead,
} from "@/server/external-play/lichess/board-api";
import type { BoardGameFull, GameSnapshot, LichessStatus } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { getLichessAccessToken } from "../external-accounts";
import { effectiveBridge, loadOnlinePlayFixture, loadSides, type BridgeRow, type OnlinePlayFixture, type Side } from "./guard";
import { fenAfter } from "./play";
import { isPlayableFixtureStatus } from "./preflight";
import { holdForOrganiser, writeResultFrom, type HoldReason, type ResultWrite, type RevokedSeat } from "./result";

/** Spec §3.5's five triggers — the domain as a VALUE so a sweep can
 *  cross-product it. Add a trigger here and the enumeration test fails until
 *  it is covered. */
export const RECONCILE_TRIGGERS = ["rejected_move", "clock_zero", "game_end", "organiser", "sweep"] as const;
export type ReconcileTrigger = (typeof RECONCILE_TRIGGERS)[number];

/** MEASURED 2026-10-11 (record.log: read 1 at 10:13:17Z `started`, read 2 at
 *  10:13:20Z `outoftime`). Not the 2 s the spec guessed before the measurement
 *  (controller ruling, addendum 3). */
export const FLAG_REREAD_MS = 3_000;

export type ReconcileDeps = {
  now?: Date;
  readStream?: (a: { token: string; gameId: string }) => Promise<GameStreamRead>;
  exportGame?: (gameId: string) => Promise<GameSnapshot | null>;
  writeResult?: typeof writeResultFrom;
  publish?: (fixtureId: string, body: RoomBroadcast) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

export type ReconcileOutcome = {
  /** Where the truth came from: the board stream, or — only for a terminal
   *  status, when no token opened the stream — the export. */
  source: "stream" | "export";
  snapshot: GameSnapshot;
  /** T12's answer for a terminal status, or the hold this call placed; null
   *  while the game runs and nothing was held. */
  result: ResultWrite | null;
  /** THIS call marked the bridge finished. */
  finished: boolean;
  /** Plies this call added to the ledger. */
  adopted: number;
};

type Colour = "white" | "black";

/** Terminal = any status but `created`/`started` (spec §3.5). A Record over
 *  the whole union, so a status added to LICHESS_STATUSES does not compile
 *  until it is placed here. */
const IS_TERMINAL: Record<LichessStatus | "unrecognised", boolean> = {
  created: false,
  started: false,
  aborted: true,
  mate: true,
  resign: true,
  stalemate: true,
  timeout: true,
  draw: true,
  outoftime: true,
  cheat: true,
  noStart: true,
  unknownFinish: true,
  insufficientMaterialClaim: true,
  variantEnd: true,
  unrecognised: true,
};

/** The holds whose game may still be running — T12's mid-game diagnoses
 *  (result.ts MID_GAME_REASONS), which a final snapshot replaces. Every other
 *  held row is the organiser's: its game is over (aborted, fair_play, a
 *  tie-break owed) or never ran (no-shows, not_started, a blocked double
 *  walkover, an unknown create), so reconcile neither reads nor writes it. */
export const RECONCILED_WHILE_HELD = ["token_revoked", "provider_error"] as const satisfies readonly HoldReason[];

/** lila registers no draw offer before ply 2 (Game.scala `playerCanOfferDraw`,
 *  lila 3747530a1 — source, as T10 cites it); V436's CHECKs refuse one. */
const DRAW_MIN_PLY = 2;

/** A T12 answer after which the game is closed on our side: a result written
 *  (decided / draw / forfeit), or nothing owed (`none` — controller carry: a
 *  final status T12 answers `none` for still finishes the bridge). A hold
 *  (`needs_organiser`, `aborted`) keeps the row held — never finished, so a
 *  tie-break owed is never closed over. */
function closesTheBridge(r: ResultWrite): boolean {
  return r.wrote === "decided" || r.wrote === "draw" || r.wrote === "forfeit" || r.wrote === "none";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** chess.js plays `uci` on `board`, or null. lila also plays a castle written
 *  king-to-rook (scalachess Position.scala:401) and a suffixless promotion as
 *  a queen (Variant.scala:116) — both read here as the move lila made, so
 *  the comparison below is canonical against canonical (T10's ledger form). */
function playUci(board: Chess, uci: string): Move | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
  try {
    return board.move(promotion === undefined ? { from, to } : { from, to, promotion });
  } catch {
    // fall through to lila's two other spellings
  }
  for (const m of board.moves({ square: from as Square, verbose: true })) {
    const rookSquare = m.isKingsideCastle() ? `h${m.from[1]}` : m.isQueensideCastle() ? `a${m.from[1]}` : null;
    if (rookSquare === to || (promotion === undefined && m.to === to && m.promotion === "q")) {
      return board.move({ from: m.from, to: m.to, promotion: m.promotion });
    }
  }
  return null;
}

/** A move list in the ledger's canonical form, as far as chess.js can follow
 *  it (the rest stays verbatim — Lichess, not chess.js, is the authority on
 *  legality), and the SAN of the part it followed. */
function canonicalLine(moves: readonly string[]): { line: string[]; san: string[] } {
  const board = new Chess();
  const line: string[] = [];
  const san: string[] = [];
  for (const uci of moves) {
    const m = playUci(board, uci);
    if (m === null) break;
    line.push(m.lan);
    san.push(m.san);
  }
  return { line: [...line, ...moves.slice(line.length)], san };
}

/** SAN from the export → our UCI vocabulary, for a terminal export's line.
 *  Stops at the first SAN chess.js cannot replay and says how many it did. */
export function uciFromSan(movesSan: readonly string[]): { uci: string[]; replayed: number } {
  const board = new Chess();
  const uci: string[] = [];
  for (const san of movesSan) {
    try {
      uci.push(board.move(san).lan);
    } catch {
      break;
    }
  }
  return { uci, replayed: uci.length };
}

const isPrefix = (short: readonly string[], long: readonly string[]) =>
  short.length <= long.length && short.every((m, i) => long[i] === m);

/** The first ply at which two lines differ (1-based), for the organiser. */
function firstDifference(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i + 1;
  return n + 1;
}

/** One stream read as T12's GameSnapshot. `movesSan` is the replayed part
 *  of Lichess's line (T12 reads status, winner and id only). */
function snapshotOf(g: BoardGameFull): GameSnapshot {
  const common = {
    gameId: g.gameId,
    winner: g.winner,
    movesSan: canonicalLine(g.movesUci).san,
    whiteMs: g.whiteMs,
    blackMs: g.blackMs,
    increment: g.incrementMs / 1000,
  };
  return g.status === "unrecognised"
    ? { ...common, status: "unrecognised", rawStatus: g.rawStatus }
    : { ...common, status: g.status };
}

/** A clock Lichess reads at zero while the game is still `started`: the flag
 *  is due and the NEXT read will show it (measured 2026-10-11). Read from
 *  Lichess's own clock for the side to move — never from ours. */
function flagDue(g: BoardGameFull): boolean {
  const moverMs = g.movesUci.length % 2 === 0 ? g.whiteMs : g.blackMs;
  return g.status === "started" && moverMs === 0;
}

/** A Lichess id the stream reports for a seat agrees with the one T9
 *  recorded (both are Lichess's own lowercase ids). An absent id (lila
 *  writes none when its light-user cache misses) cannot be checked, and is
 *  not read as a mismatch. */
const samePlayer = (read: string | null, onFile: string) => read === null || read === onFile;

type Game = {
  fixture: OnlinePlayFixture;
  bridge: BridgeRow;
  gameId: string;
  whiteSide: Side;
  whiteId: string;
  blackId: string;
  /** The move T10 sent, when this read follows Lichess refusing it. */
  submitted: SubmittedMove | null;
};

/** A move T10 SENT to Lichess and was refused (or got no answer to): its ply
 *  — the ledger's length when it was sent — and the canonical UCI the ledger
 *  would have recorded. Review N1: a 5xx or a timeout may have played it. */
export type SubmittedMove = { ply: number; uci: string };

type Truth =
  | { source: "stream"; game: BoardGameFull; at: Date; revoked: Colour[] }
  | { source: "export"; snapshot: GameSnapshot; at: Date; revoked: Colour[] }
  | { source: "none"; revoked: Colour[] };

/** Read Lichess: the stream through White's token, else Black's; the export
 *  only when neither opens, and only for a terminal status. A token that
 *  cannot be decrypted (503 LICHESS_TOKEN_UNAVAILABLE — an operator's key) is
 *  never swallowed: the export may still settle a finished game, and if it
 *  cannot, that error is what the caller gets. 429 stops every call. */
async function readTruth(g: Game, deps: ReconcileDeps): Promise<Truth> {
  const { home, away } = await loadSides(g.fixture);
  const seats: { colour: Colour; userId: string | null; linkedId: string | null; onFile: string }[] = [
    { colour: "white", ...seatOf(g.whiteSide === "home" ? home : away), onFile: g.whiteId },
    { colour: "black", ...seatOf(g.whiteSide === "home" ? away : home), onFile: g.blackId },
  ];
  const readStream = deps.readStream ?? realReadGameStream;
  const revoked: Colour[] = [];
  let unopenable: HttpError | null = null;
  for (const seat of seats) {
    // Only the account the game was created for can open it (T10's check):
    // a player who re-linked another account is not a player in this game.
    if (seat.userId === null || seat.linkedId !== seat.onFile) continue;
    let token: string | null;
    try {
      token = await getLichessAccessToken(seat.userId);
    } catch (err) {
      if (err instanceof HttpError && err.code === "LICHESS_TOKEN_UNAVAILABLE") {
        unopenable = err;
        continue;
      }
      throw err;
    }
    if (token === null) continue; // no link, or a legacy identity-only one
    const read = await readStream({ token, gameId: g.gameId });
    // The line must be THIS game's: T12 answers `none` for a foreign game,
    // and `none` closes the bridge — so another game's line is no read.
    if (read.ok && read.game.gameId === g.gameId) {
      return { source: "stream", game: read.game, at: deps.now ?? new Date(), revoked };
    }
    if (read.ok) {
      log.error({ fixtureId: g.fixture.fixtureId, gameId: g.gameId }, "lichess reconcile: the board stream answered with another game");
      continue;
    }
    log.warn(
      { fixtureId: g.fixture.fixtureId, gameId: g.gameId, colour: seat.colour, code: read.code },
      "lichess reconcile: the board stream did not open with this player's token",
    );
    if (read.code === "unauthorized") revoked.push(seat.colour);
    if (read.code === "rate_limited") {
      // 429 stops every call — but never swallows an operator's key fault
      // already met on the other seat (review M1).
      if (unopenable) throw unopenable;
      return { source: "none", revoked };
    }
  }
  const snap = await (deps.exportGame ?? realExportGame)(g.gameId);
  if (snap !== null && snap.gameId === g.gameId && IS_TERMINAL[snap.status]) {
    return { source: "export", snapshot: snap, at: deps.now ?? new Date(), revoked };
  }
  if (unopenable) throw unopenable;
  return { source: "none", revoked };
}

function seatOf(s: { userId: string | null; lichess: { id: string } | null }) {
  return { userId: s.userId, linkedId: s.lichess?.id ?? null };
}

/**
 * Reconcile one fixture's game with Lichess. `null` when nothing was read:
 * no game on file, a game the organiser holds, a fixture no longer playable
 * (its bridge is closed instead — a withdrawal or a void ends our interest in
 * the game, and nothing is written for it), or a read that told us nothing we
 * trust (a refused stream and a non-terminal export).
 */
export async function reconcile(
  fixtureId: string,
  trigger: ReconcileTrigger,
  deps: ReconcileDeps = {},
  /** rejected_move only: what T10 sent (review N1). */
  submitted: SubmittedMove | null = null,
): Promise<ReconcileOutcome | null> {
  // An assumption is a guard: a trigger outside the five is refused, never
  // reconciled on a guess.
  if (!(RECONCILE_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new HttpError(400, "Unknown reconcile trigger", "UNKNOWN_RECONCILE_TRIGGER");
  }
  // Only a move Lichess refused has a submission; on any other trigger one
  // would excuse plies nobody here sent.
  if (submitted !== null && trigger !== "rejected_move") {
    throw new HttpError(500, `a submitted move is evidence for rejected_move only, not ${trigger}`, "SUBMITTED_WITHOUT_REJECTED_MOVE");
  }
  const f = await loadOnlinePlayFixture(fixtureId);
  if (f === null || !isPlayableFixtureStatus(f.fixtureStatus)) {
    await closeUnplayable(fixtureId, deps.now ?? new Date());
    return null;
  }
  const b = effectiveBridge(f);
  if (b === null || b.challenge_id === null || !readable(b)) return null;
  // T9 writes the colours and both accounts with the game id, so a game
  // without them is a broken row: no read can be attributed to a seat.
  if (b.white_side === null || b.white_lichess_id === null || b.black_lichess_id === null) {
    log.error({ fixtureId, gameId: b.challenge_id }, "lichess reconcile: a game on file carries no recorded colours");
    return null;
  }
  const game: Game = {
    fixture: f,
    bridge: b,
    gameId: b.challenge_id,
    whiteSide: b.white_side,
    whiteId: b.white_lichess_id,
    blackId: b.black_lichess_id,
    submitted,
  };

  let truth = await readTruth(game, deps);
  if (trigger === "clock_zero" && truth.source === "stream" && flagDue(truth.game)) {
    await (deps.sleep ?? sleep)(FLAG_REREAD_MS);
    const again = await readTruth(game, deps);
    if (again.source !== "none") truth = again;
  }

  if (truth.source === "stream") return applyStream(game, truth, deps);
  if (truth.source === "export") return applyExport(game, truth, deps);
  if (truth.revoked.length > 0) await holdRevoked(game, truth.revoked);
  return null;
}

function readable(b: BridgeRow): boolean {
  if (b.status === "ready" || b.status === "live") return true;
  if (b.status === "needs_organiser") {
    return b.needs_reason !== null && (RECONCILED_WHILE_HELD as readonly string[]).includes(b.needs_reason);
  }
  return false; // pending: no game yet; finished: closed
}

/** A withdrawal, a void, a result by hand, W2a's needs_decision, a
 *  finalized or cancelled fixture: the organiser's decision stands, so the
 *  bridge closes with no read and no result (T12 review carry — otherwise a
 *  withdrawn board's bridge stays `live` forever and the sweep keeps it).
 *  A held row is left in the organiser's queue. */
async function closeUnplayable(fixtureId: string, at: Date): Promise<void> {
  const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  if (!fx || isPlayableFixtureStatus(fx.status)) return;
  // A closed bridge holds no standing offer (an offer means something only
  // while the game is played — review M2).
  const closed = await sql`
    update fixture_external_play
       set status = 'finished', finished_at = ${at}, draw_offer_by = null, updated_at = now()
     where fixture_id = ${fixtureId} and status in ('ready', 'live')
     returning fixture_id`;
  if (closed.length > 0) {
    log.info({ fixtureId, fixtureStatus: fx.status }, "lichess reconcile: fixture no longer playable — bridge closed, nothing written");
  }
}

/** The seat a list of refused tokens names (ruling M7). An empty list names
 *  no seat — refused by name rather than read as Black (review N4). */
export function revokedSeatOf(revoked: readonly Colour[]): RevokedSeat {
  const white = revoked.includes("white");
  const black = revoked.includes("black");
  if (white && black) return "both";
  if (white) return "white";
  if (black) return "black";
  throw new HttpError(500, "a token_revoked hold needs the seat whose token was refused", "REVOKED_SEAT_EMPTY");
}

async function holdRevoked(g: Game, revoked: readonly Colour[]): Promise<ResultWrite> {
  // Spec §3.6: a token revoked or rejected mid-match is not a no-show. Ruling
  // M7: the hold records the seat, and freezes only that seat (T10).
  return holdForOrganiser({
    fixtureId: g.fixture.fixtureId,
    reason: "token_revoked",
    seat: revokedSeatOf(revoked),
    detail: `lichess game ${g.gameId}: the board stream refused ${revoked.join(" and ")}'s token`,
  });
}

/** Review I5, controller ruling: OUR server is the only mover, so a ply a
 *  read ADOPTS reached Lichess without us — out-of-band play — unless it is
 *  the very move T10 sent at that ply, which a 5xx or a timeout may have
 *  played (review N1: our own move is never fair-play evidence against the
 *  player). Spec §3.6 makes it a flag for the organiser, never a sanction.
 *  The evidence: the plies, and whether the camera was Required; null when
 *  no adopted ply is out-of-band. T10's move is known two ways: the refusal
 *  that triggered this read (`submitted`), and the submission T10 put on
 *  file BEFORE sending it (ruling I4, `submissionOnFile`) — so a read landing
 *  between Lichess's 200 and T10's append (the 5-minute sweep reads every
 *  live game) adopts our move as ours. Either excuses ONLY the first adopted
 *  ply and only that move: a different move there, or any later ply, is
 *  still flagged. Written in the SAME statement as the ledger write that
 *  adopts, so one adoption is one flag: a re-read adopts nothing, and a
 *  racing read loses the CAS. */
/** Ruling I4: the submission on file NOW — read AFTER Lichess was, never
 *  the one this read loaded, so a submission T10 records while Lichess is
 *  being read still excuses its own move (the read adopts it, and T10's
 *  append absorbs). One recorded after THIS read was sent to Lichess after
 *  Lichess was read, so the line in hand cannot hold its move: nothing it
 *  could excuse is missed. No lock is owed for that ordering, and the write
 *  spends it anyway once the ledger passes its ply (V436: next ply only). */
async function submissionOnFile(fixtureId: string): Promise<SubmittedMove | null> {
  const [row] = await sql<{ ply: number | null; uci: string | null }[]>`
    select pending_move_ply as ply, pending_move_uci as uci
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return row && row.ply !== null && row.uci !== null ? { ply: row.ply, uci: row.uci } : null;
}

async function outOfBandEvidence(
  fixtureId: string,
  ours: number,
  line: readonly string[],
  excuses: readonly (SubmittedMove | null)[],
): Promise<string | null> {
  const ourMoveFirst = excuses.some((e) => e !== null && e.ply === ours && line[ours] === e.uci);
  const from = ourMoveFirst ? ours + 1 : ours;
  if (from >= line.length) return null;
  const policy = await fixtureCameraPolicy(fixtureId);
  const plies = line.length - from === 1 ? `ply ${from + 1}` : `plies ${from + 1}-${line.length}`;
  const camera = policy === "required" ? "camera required" : `camera not required (policy ${policy})`;
  return `${plies} (${line.slice(from).join(" ")}) played at Lichess, not through Seazn; ${camera}`;
}

/** Mark the bridge finished — only from ready/live, so a held row keeps its
 *  reason (controller carry) and a finished row keeps its first finished_at.
 *  The game is over, so no offer stands (review M2: the stream read that
 *  ended it may have lost its write to an offer T10 recorded meanwhile). */
async function finish(g: Game, at: Date): Promise<boolean> {
  const rows = await sql`
    update fixture_external_play
       set status = 'finished', finished_at = ${at}, draw_offer_by = null, updated_at = now()
     where fixture_id = ${g.fixture.fixtureId} and challenge_id = ${g.gameId}
       and status in ('ready', 'live')
     returning fixture_id`;
  return rows.length > 0;
}

/** The standing offer after this read, as lila holds it (`wdraw`/`bdraw`).
 *  An adopted offer stamps its side's ply at Lichess's ply (T10 carry: the
 *  re-offer rule reads it); the one already standing keeps its ply. */
function offerAfter(b: BridgeRow, g: BoardGameFull, ply: number) {
  const keep = { by: b.draw_offer_by, whitePly: b.white_draw_offer_ply, blackPly: b.black_draw_offer_ply };
  const { white, black } = g.drawOffer;
  // lila holds at most one offer — the opponent's yes IS the draw (Drawer.scala).
  if (white && black) {
    log.warn({ gameId: g.gameId }, "lichess reconcile: both sides read as offering a draw — the offer on file stands");
    return keep;
  }
  const by: Colour | null = white ? "white" : black ? "black" : null;
  if (by === null) return { ...keep, by: null };
  if (by === b.draw_offer_by) return keep;
  if (ply < DRAW_MIN_PLY) {
    log.warn({ gameId: g.gameId, ply }, "lichess reconcile: a draw offer before ply 2 — not adopted");
    return keep;
  }
  return by === "white" ? { ...keep, by, whitePly: ply } : { ...keep, by, blackPly: ply };
}

/** The row's clocks after this read, in the row's own terms (V436, T10's
 *  append): `white_ms`/`black_ms` are each side's time AS AT `last_move_at`,
 *  and every renderer counts the side to move down from `last_move_at`
 *  (once both sides have moved — scalachess Clock.step). Lichess reports
 *  each clock AT THE READ. So a read that extends the ledger moves
 *  `last_move_at` to the read and takes Lichess's clocks as they are (T10
 *  carry: extending the ledger sets last_move_at); a read that does not
 *  keeps `last_move_at` — it is still when the last move was recorded — and
 *  adds back to the running clock the time it ran since then, so the
 *  renderer's countdown lands on Lichess's reading at the read. Lichess's
 *  own clock, re-expressed: nothing here decides a flag. */
function clocksAt(b: BridgeRow, g: BoardGameFull, ply: number, adopted: number, at: Date) {
  if (adopted > 0 || (b.last_move_at === null && ply > 0)) {
    return { whiteMs: g.whiteMs, blackMs: g.blackMs, lastMoveAt: at };
  }
  const last = b.last_move_at;
  if (last === null || g.status !== "started" || ply < 2) return { whiteMs: g.whiteMs, blackMs: g.blackMs, lastMoveAt: last };
  const since = Math.max(0, at.getTime() - last.getTime());
  return ply % 2 === 0
    ? { whiteMs: g.whiteMs + since, blackMs: g.blackMs, lastMoveAt: last }
    : { whiteMs: g.whiteMs, blackMs: g.blackMs + since, lastMoveAt: last };
}

async function applyStream(
  g: Game,
  t: Extract<Truth, { source: "stream" }>,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  const fixtureId = g.fixture.fixtureId;
  const lichess = t.game;
  const snapshot = snapshotOf(lichess);
  const out = (o: Partial<ReconcileOutcome>): ReconcileOutcome =>
    ({ source: "stream", snapshot, result: null, finished: false, adopted: 0, ...o });

  // 1. The game's players are the ones T9 recorded — a winner is mapped to an
  //    entrant through those colours, so a game that disagrees writes nothing.
  if (!samePlayer(lichess.whiteId, g.whiteId) || !samePlayer(lichess.blackId, g.blackId)) {
    return out({
      result: await holdForOrganiser({
        fixtureId,
        reason: "provider_error",
        detail: `lichess game ${g.gameId}: its players are not the ones on file — nothing written`,
      }),
    });
  }

  // 2. The ledger follows Lichess FORWARD only. Ours was read before the
  //    stream, and holds only moves Lichess accepted, so a stream that does
  //    not extend it is a takeback or a divergence at Lichess: never rewound
  //    automatically (a rewind erases accepted moves). A game still running
  //    is held for the organiser; a game that has ENDED still gets its
  //    result — Lichess's status does not depend on our board.
  const ours = canonicalLine(g.bridge.moves_uci).line;
  const theirs = canonicalLine(lichess.movesUci).line;
  if (!isPrefix(ours, theirs)) {
    const at = firstDifference(ours, theirs);
    log.warn({ fixtureId, gameId: g.gameId, ours: ours.length, theirs: theirs.length, at }, "lichess reconcile: the move list diverged");
    if (IS_TERMINAL[lichess.status]) {
      await broadcast(g, deps, { line: theirs, whiteMs: lichess.whiteMs, blackMs: lichess.blackMs, status: lichess.status, drawOfferBy: null });
      return settle(g, snapshot, t.at, deps, 0, "stream");
    }
    return out({
      result: await holdForOrganiser({
        fixtureId,
        reason: "provider_error",
        detail: `lichess game ${g.gameId}: Lichess's move list (${theirs.length} plies) does not extend ours (${ours.length}) — first difference at ply ${at}`,
      }),
    });
  }
  const ply = theirs.length;
  const adopted = ply - ours.length;
  const clocks = clocksAt(g.bridge, lichess, ply, adopted, t.at);
  // A game that has ended has no standing offer (an offer means something
  // only while the game is played); the plies stay, as T10 leaves them.
  const offer = IS_TERMINAL[lichess.status]
    ? { by: null, whitePly: g.bridge.white_draw_offer_ply, blackPly: g.bridge.black_draw_offer_ply }
    : offerAfter(g.bridge, lichess, ply);
  const incrementS = Math.round(lichess.incrementMs / 1000);
  const b = g.bridge;
  const changed =
    adopted > 0 ||
    (b.status === "ready" && ply > 0) ||
    (b.started_at === null && ply > 0) ||
    clocks.whiteMs !== b.white_ms ||
    clocks.blackMs !== b.black_ms ||
    (clocks.lastMoveAt?.getTime() ?? null) !== (b.last_move_at?.getTime() ?? null) ||
    incrementS !== b.clock_increment_s ||
    offer.by !== b.draw_offer_by ||
    offer.whitePly !== b.white_draw_offer_ply ||
    offer.blackPly !== b.black_draw_offer_ply;
  // Conditional on the ledger and the offer we read: a move T10 appended, or
  // an offer it recorded, since our read wins — this read is then older than
  // the row, and the next reconcile catches up.
  const evidence =
    changed && adopted > 0
      ? await outOfBandEvidence(fixtureId, ours.length, theirs, [g.submitted, await submissionOnFile(fixtureId)])
      : null;
  const wrote = !changed
    ? []
    : await sql`
    with up as (
    update fixture_external_play
       set moves_uci = ${sql.json(theirs)}, move_count = ${ply},
           status = case when status = 'ready' and ${ply}::int > 0 then 'live' else status end,
           started_at = coalesce(started_at, case when ${ply}::int > 0 then ${t.at}::timestamptz end),
           last_move_at = ${clocks.lastMoveAt},
           white_ms = ${clocks.whiteMs}, black_ms = ${clocks.blackMs},
           clock_increment_s = ${incrementS},
           draw_offer_by = ${offer.by},
           white_draw_offer_ply = ${offer.whitePly}, black_draw_offer_ply = ${offer.blackPly},
           -- I4: a submission whose ply the ledger now holds is spent; one
           -- still for the next ply stands (a read that adopted nothing).
           pending_move_ply = case when pending_move_ply < ${ply}::int then null else pending_move_ply end,
           pending_move_uci = case when pending_move_ply < ${ply}::int then null else pending_move_uci end,
           pending_move_at = case when pending_move_ply < ${ply}::int then null else pending_move_at end,
           updated_at = now()
     where fixture_id = ${fixtureId} and challenge_id = ${g.gameId}
       and status in ('ready', 'live', 'needs_organiser')
       and move_count = ${b.move_count}
       and draw_offer_by is not distinct from ${b.draw_offer_by}
     returning fixture_id, org_id
    ), flagged as (
      insert into fixture_play_flags (fixture_id, org_id, kind, note)
      select fixture_id, org_id, 'out_of_band_play', ${evidence}::text from up where ${evidence}::text is not null
    )
    select fixture_id from up`;
  // The room hears of a row this read changed, and of every game end it reads
  // (the end may change nothing on the row, yet the boards must stop); the
  // clocks it sees are Lichess's, at the read.
  if (wrote.length > 0 || IS_TERMINAL[lichess.status]) {
    await broadcast(g, deps, {
      line: theirs,
      whiteMs: lichess.whiteMs,
      blackMs: lichess.blackMs,
      status: lichess.status,
      drawOfferBy: IS_TERMINAL[lichess.status] ? null : offer.by,
    });
  }
  const applied = wrote.length > 0 ? adopted : 0;

  if (!IS_TERMINAL[lichess.status]) {
    const held = t.revoked.length > 0 ? await holdRevoked(g, t.revoked) : null;
    return out({ result: held, adopted: applied });
  }
  return settle(g, snapshot, t.at, deps, applied, "stream");
}

async function applyExport(
  g: Game,
  t: Extract<Truth, { source: "export" }>,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  const fixtureId = g.fixture.fixtureId;
  // A terminal export's line only ever EXTENDS ours: shorter is a stalled
  // read (M16), never a rewind; its clocks are never read (§3.5).
  const ours = canonicalLine(g.bridge.moves_uci).line;
  const { uci } = uciFromSan(t.snapshot.movesSan);
  let adopted = 0;
  let line = ours;
  if (uci.length > ours.length && isPrefix(ours, uci)) {
    const evidence = await outOfBandEvidence(fixtureId, ours.length, uci, [g.submitted, await submissionOnFile(fixtureId)]);
    const wrote = await sql`
      with up as (
      update fixture_external_play
         set moves_uci = ${sql.json(uci)}, move_count = ${uci.length},
             status = case when status = 'ready' then 'live' else status end,
             started_at = coalesce(started_at, ${t.at}::timestamptz),
             last_move_at = ${t.at},
             -- I4: this write adopts at least one ply, so it passes the only
             -- submission the row can hold (V436: the next ply's) — spent.
             pending_move_ply = null, pending_move_uci = null, pending_move_at = null,
             updated_at = now()
       where fixture_id = ${fixtureId} and challenge_id = ${g.gameId}
         and status in ('ready', 'live', 'needs_organiser')
         and move_count = ${g.bridge.move_count}
       returning fixture_id, org_id
      ), flagged as (
        insert into fixture_play_flags (fixture_id, org_id, kind, note)
        select fixture_id, org_id, 'out_of_band_play', ${evidence}::text from up where ${evidence}::text is not null
      )
      select fixture_id from up`;
    if (wrote.length > 0) {
      adopted = uci.length - ours.length;
      line = uci;
    }
  }
  // The export is read only for a game that has ENDED, so no offer stands —
  // held or not (the stream path's rule, review M2).
  await sql`
    update fixture_external_play set draw_offer_by = null, updated_at = now()
     where fixture_id = ${fixtureId} and challenge_id = ${g.gameId}
       and status in ('ready', 'live', 'needs_organiser') and draw_offer_by is not null`;
  const outcome = await settle(g, t.snapshot, t.at, deps, adopted, "export");
  // The board's last state for the room: the line we now hold, and the clocks
  // as our row last knew them (the export's are never used).
  if (t.snapshot.status !== "unrecognised") {
    const limitMs = g.fixture.clock.limit * 1000;
    await broadcast(g, deps, {
      line,
      whiteMs: g.bridge.white_ms ?? limitMs,
      blackMs: g.bridge.black_ms ?? limitMs,
      status: t.snapshot.status,
      drawOfferBy: null,
    });
  }
  return outcome;
}

/** A terminal status: T12 writes (or holds), then we close the bridge unless
 *  T12 held it. */
async function settle(
  g: Game,
  snapshot: GameSnapshot,
  at: Date,
  deps: ReconcileDeps,
  adopted: number,
  source: ReconcileOutcome["source"],
): Promise<ReconcileOutcome> {
  // T13 fix round 1, ruling I1: the GAME's end, on file whatever T12 writes
  // next. `finished_at` is stamped only when the bridge closes, so a held
  // ending (a tie-break owed, an abort, a mid-game hold whose game ended)
  // would otherwise have none, and the sweep's camera evidence would run on to
  // the room's end. The first read that saw the game over is its end.
  await sql`
    update fixture_external_play set game_over_at = ${at}, updated_at = now()
     where fixture_id = ${g.fixture.fixtureId} and challenge_id = ${g.gameId} and game_over_at is null`;
  const write = deps.writeResult ?? writeResultFrom;
  let result: ResultWrite;
  try {
    result = await write(snapshot, g.fixture.fixtureId);
  } catch (err) {
    // Two reconciles of one game end (both players' game_end, the sweep) can
    // race inside T12: the loser reads the fixture `in_play`, then a fold the
    // winner has just closed, and T12 refuses that pair as FOLD_STATUS_MISMATCH
    // (measured here, three concurrent reconciles). Asked again, T12's replay
    // check finds the winner's keyed result and answers it. ONCE — a second
    // refusal is a damaged row, and is raised.
    if (!(err instanceof HttpError && err.code === "FOLD_STATUS_MISMATCH")) throw err;
    log.warn({ fixtureId: g.fixture.fixtureId, gameId: g.gameId }, "lichess reconcile: the result write lost a race — asking once more");
    result = await write(snapshot, g.fixture.fixtureId);
  }
  const finished = closesTheBridge(result) ? await finish(g, at) : false;
  return { source, snapshot, result, finished, adopted };
}

/** Push the board as Lichess now has it. As T10 does: a line chess.js cannot
 *  replay is never broadcast, and neither is a status the room's vocabulary
 *  has no word for (`unrecognised` — the organiser sees T12's hold). */
async function broadcast(
  g: Game,
  deps: ReconcileDeps,
  s: { line: string[]; whiteMs: number; blackMs: number; status: LichessStatus | "unrecognised"; drawOfferBy: Colour | null },
): Promise<void> {
  if (s.status === "unrecognised") return;
  const replay = fenAfter(s.line);
  if (replay.replayed !== s.line.length) return;
  await (deps.publish ?? publishRoomBroadcast)(g.fixture.fixtureId, {
    fen: replay.fen,
    lastMove: s.line.at(-1) ?? null,
    turn: s.line.length % 2 === 0 ? "white" : "black",
    whiteMs: s.whiteMs,
    blackMs: s.blackMs,
    status: s.status,
    drawOfferBy: s.drawOfferBy,
  });
}
