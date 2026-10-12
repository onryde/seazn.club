// The match room's client state: ONE reducer over everything that can reach
// the room — a snapshot (GET, or a seat POST's answer), a realtime broadcast
// of a move, the seat and act round trips, and a failed read. Pure, so its
// transitions and its invariants are tested without a browser
// (room-state.test.ts: every transition, and a fast-check sequence property).
//
// Ordering is the whole difficulty. A GET fired before a move can answer
// after that move's broadcast; a broadcast can arrive twice; a seat answer
// can land after the game began. So:
//   - a snapshot older than the one held (by the SERVER's clock) is dropped;
//   - the board never moves backwards: a snapshot or broadcast whose ply is
//     below the held ply leaves the held game as it is;
//   - a game seen over stays over;
//   - polling, once stopped (online chess off for the club, or the room not
//     found), stays stopped — T20 re-review n1: with the flag off, every read
//     re-runs token, seat and Lichess reads, so the poll must stop on it.
import type { RoomActAnswer, RoomActBody, RoomClaimAnswer, SeatAnswer } from "./room-api";
import type { Colour, RoomGame, RoomSnapshot } from "./room-snapshot";

/** Lichess statuses past which the game is over (LICHESS_STATUSES minus the
 *  two live ones: `created`, `started`). */
const LIVE_STATUSES = new Set(["created", "started"]);

export type RoomBroadcastWire = {
  fen: string;
  lastMove: string | null;
  turn: Colour;
  whiteMs: number;
  blackMs: number;
  status: string;
  drawOfferBy: Colour | null;
};

const COLOURS = new Set(["white", "black"]);

/** A realtime payload is untrusted input: anything not shaped like a room
 *  broadcast is dropped (the next read carries the truth), never applied. */
export function parseRoomBroadcast(raw: unknown): RoomBroadcastWire | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ms = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (typeof r.fen !== "string" || r.fen.split(" ").length !== 6) return null;
  if (!(r.lastMove === null || (typeof r.lastMove === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(r.lastMove)))) return null;
  if (typeof r.turn !== "string" || !COLOURS.has(r.turn)) return null;
  if (!ms(r.whiteMs) || !ms(r.blackMs)) return null;
  if (typeof r.status !== "string") return null;
  if (!(r.drawOfferBy === null || (typeof r.drawOfferBy === "string" && COLOURS.has(r.drawOfferBy)))) return null;
  return {
    fen: r.fen,
    lastMove: r.lastMove as string | null,
    turn: r.turn as Colour,
    whiteMs: r.whiteMs as number,
    blackMs: r.blackMs as number,
    status: r.status,
    drawOfferBy: r.drawOfferBy as Colour | null,
  };
}

export type RoomError = "relink" | "network" | "refused" | "invalid";

/** The in-room notice an error shows on the live board (Seams A/B/C, the
 *  owner-approved canvas): C1 offline, C2 a move Lichess refused, C3 a move
 *  our server refused. */
export type MoveNotice = "offline" | "refused" | "invalid";

export type RoomState = {
  snap: RoomSnapshot;
  /** serverNow − clientNow at the last snapshot, ms. Clocks run on the
   *  server's time, so the client derives a tick from this, never from its
   *  own wall clock alone. */
  skewMs: number;
  /** The last seat answer — its refusal reason picks the state card. */
  seat: SeatAnswer | null;
  pending: null | { kind: "seat" } | { kind: "act"; action: RoomActBody };
  error: RoomError | null;
  /** The kind of act whose answer raised a `refused` or `invalid` error —
   *  set with it, in the same transition, so the notice can tell a move
   *  from a resign or an offer (the drawn copy is a move's). */
  failedAct: RoomActBody["kind"] | null;
  /** Bumped whenever the board must be put back on the held position. */
  syncKey: number;
  polling: boolean;
  notFound: boolean;
};

export type RoomEvent =
  | { type: "snapshot"; snap: RoomSnapshot; receivedAt: number }
  | { type: "broadcast"; b: RoomBroadcastWire; receivedAt: number }
  | { type: "seat_sent" }
  | { type: "seat_answered"; answer: RoomClaimAnswer; receivedAt: number }
  | { type: "seat_failed"; status: number }
  | { type: "act_sent"; action: RoomActBody }
  | { type: "act_answered"; answer: RoomActAnswer }
  | { type: "act_failed"; status: number }
  | { type: "fetch_failed"; status: number };

/** Plies played, from the FEN (fullmove number and side to move) — the one
 *  measure both a snapshot and a broadcast carry. */
export function plyOfFen(fen: string): number {
  const parts = fen.split(" ");
  const full = Number(parts[5]);
  if (!Number.isFinite(full) || full < 1) return 0;
  return (full - 1) * 2 + (parts[1] === "b" ? 1 : 0);
}

export function plyOf(game: RoomGame | null): number {
  return game === null ? -1 : plyOfFen(game.fen);
}

function stopsPolling(snap: RoomSnapshot): boolean {
  return snap.onlineChessOff;
}

export function initialRoomState(snap: RoomSnapshot, receivedAt: number): RoomState {
  return {
    snap,
    skewMs: Date.parse(snap.serverNow) - receivedAt,
    seat: null,
    pending: null,
    error: null,
    failedAct: null,
    syncKey: 0,
    polling: !stopsPolling(snap),
    notFound: false,
  };
}

/** Merge a fresher snapshot, keeping the held game when the snapshot's is
 *  behind it, and keeping a game seen over, over. */
function mergeSnapshot(s: RoomState, snap: RoomSnapshot, receivedAt: number): RoomState {
  if (Date.parse(snap.serverNow) < Date.parse(s.snap.serverNow)) return s; // stale answer
  const held = s.snap.game;
  let game = snap.game;
  // Monotonic within ONE game: a game on file never disappears, and a
  // snapshot behind the held ply keeps the held board. A different gameId is
  // a different game, and the fresher read wins outright.
  const sameGame = held !== null && (game === null || game.gameId === held.gameId);
  if (sameGame && (game === null || plyOf(game) < plyOf(held))) game = held;
  if (sameGame && game !== null && held.over && !game.over) game = { ...game, over: true, clockRunning: false };
  const next: RoomSnapshot = { ...snap, game };
  return {
    ...s,
    snap: next,
    skewMs: Date.parse(snap.serverNow) - receivedAt,
    polling: s.polling && !stopsPolling(snap),
  };
}

function applyBroadcast(s: RoomState, b: RoomBroadcastWire, receivedAt: number): RoomState {
  const held = s.snap.game;
  if (held === null) return s; // no game on file here yet: the next read brings it
  const ply = plyOfFen(b.fen);
  const heldPly = plyOf(held);
  if (ply < heldPly) return s;
  const over = held.over || !LIVE_STATUSES.has(b.status);
  // One ply on: the ledger grows by the broadcast move. The same ply (a
  // duplicate, or an offer/clock change) keeps it. A jump of more than one
  // ply (a dropped broadcast) keeps the ledger short until the next read.
  const moves = ply === heldPly + 1 && b.lastMove !== null ? [...held.moves, b.lastMove] : held.moves;
  const game: RoomGame = {
    ...held,
    fen: b.fen,
    moves,
    lastMove: b.lastMove ? [b.lastMove.slice(0, 2), b.lastMove.slice(2, 4)] : held.lastMove,
    turn: b.turn,
    whiteMs: b.whiteMs,
    blackMs: b.blackMs,
    // The broadcast carries no instant (T10): its values are true as of its
    // arrival, on the server's clock.
    clockAsOf: new Date(receivedAt + s.skewMs).toISOString(),
    clockRunning: ply >= 2 && !over,
    drawOfferBy: b.drawOfferBy,
    over,
  };
  return { ...s, snap: { ...s.snap, game } };
}

/** The notices' endings that no request of the player's causes: a read
 *  that got an answer ends "offline" (even a stale one — the connection is
 *  back), and a board that moved past the refused position ends C2/C3 (it
 *  speaks of a position that no longer stands). */
function endNotices(before: RoomState, after: RoomState, answered: boolean): RoomState {
  const offlineEnds = answered && after.error === "network";
  const movedOn =
    (after.error === "refused" || after.error === "invalid") && plyOf(after.snap.game) > plyOf(before.snap.game);
  return offlineEnds || movedOn ? { ...after, error: null, failedAct: null } : after;
}

export function roomReducer(s: RoomState, e: RoomEvent): RoomState {
  switch (e.type) {
    case "snapshot": {
      const merged = mergeSnapshot(s, e.snap, e.receivedAt);
      return endNotices(s, merged === s ? s : { ...merged, notFound: false }, true);
    }
    case "broadcast":
      return endNotices(s, applyBroadcast(s, e.b, e.receivedAt), false);
    case "seat_sent":
      if (s.pending !== null) return s;
      return { ...s, pending: { kind: "seat" }, error: null, failedAct: null };
    case "seat_answered": {
      const merged = mergeSnapshot(s, e.answer.snapshot, e.receivedAt);
      const seat = e.answer.seat;
      const relink = seat !== null && !seat.seated && (seat.reason === "lichess_link_required" || seat.reason === "lichess_reconsent_required");
      return {
        ...merged,
        seat,
        pending: s.pending?.kind === "seat" ? null : s.pending,
        error: relink ? "relink" : null,
        failedAct: null,
      };
    }
    case "seat_failed":
      return {
        ...s,
        pending: s.pending?.kind === "seat" ? null : s.pending,
        notFound: s.notFound || e.status === 404,
        polling: s.polling && e.status !== 404,
        error: e.status === 0 ? "network" : s.error,
      };
    case "act_sent":
      if (s.pending !== null) return s;
      return { ...s, pending: { kind: "act", action: e.action }, error: null, failedAct: null };
    case "act_answered": {
      if (s.pending?.kind !== "act") return s;
      const a = e.answer;
      if (a.ok) return { ...s, pending: null, error: null, failedAct: null };
      return {
        ...s,
        pending: null,
        error: a.reconcile ? "refused" : "relink",
        failedAct: s.pending.action.kind,
        syncKey: s.syncKey + 1,
      };
    }
    case "act_failed":
      // Never "gone" and never a stop (review I2): play's 404 is T10 refusing
      // a board it will not accept, not the room vanishing. The hook re-reads
      // and the read says what the board is; only GET room's own 404 stops.
      if (s.pending?.kind !== "act") return s;
      return {
        ...s,
        pending: null,
        error: e.status === 0 ? "network" : "invalid",
        failedAct: s.pending.action.kind,
        syncKey: s.syncKey + 1,
      };
    case "fetch_failed":
      return {
        ...s,
        notFound: s.notFound || e.status === 404,
        polling: s.polling && e.status !== 404,
        error: e.status === 0 ? "network" : s.error,
      };
  }
}

/** The notice the live board shows for the room's error (C1–C3), or none.
 *  Offline is offline whatever was sent; C2/C3 say "that move", so they are
 *  a MOVE's — a refused resign, offer or abort keeps its error (the re-read
 *  shows the truth) but no move notice. A re-link is a screen, not this. */
export function moveNotice(s: RoomState): MoveNotice | null {
  if (s.error === "network") return "offline";
  if ((s.error === "refused" || s.error === "invalid") && s.failedAct === "move") return s.error;
  return null;
}

/** May the viewer move right now? The server's `canAct` (T10's own
 *  predicate — a frozen seat, every hold, a finished board) gates it; the
 *  rest is the turn and what this client already knows. */
export function canMove(s: RoomState): boolean {
  const g = s.snap.game;
  return (
    g !== null &&
    !g.over &&
    s.snap.result === null &&
    s.pending === null &&
    s.snap.canAct &&
    g.turn === s.snap.you.colour
  );
}
