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
import { optimisticAfterDrop, type OptimisticClock } from "./clock-math";
import { ROOM_BEING_REPAIRED, type Colour, type RoomGame, type RoomSnapshot } from "./room-snapshot";

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
 *  owner-approved canvas, and the notice routing ruling of 2026-10-12): C1
 *  offline; C2 a move that didn't go through (Lichess refused it, or our
 *  server failed); C3 a move a RULE refused; and `failed`, the generic C2
 *  for anything else — an offer, an answer, a resign or an abort. */
export type MoveNotice = "offline" | "refused" | "invalid" | "failed";

/** The act route's answers that are a RULE refusing the act, not a failure
 *  (notice routing ruling): 400 — the move string itself (T3's INVALID_UCI,
 *  a promotion with no piece, a malformed body); 422 — semantically invalid.
 *  Any other status — a 5xx, a 401, a 409, a 429 — is a failure: the act
 *  "didn't go through", and never "isn't allowed". So is play's 404 (T14
 *  re-review 5, I-1): its every cause — no playable game, a hold, a frozen
 *  seat, a linked account that is not the game's — is the board, the seat or
 *  the account, never a rule; the re-read that follows says which. */
export const ACT_RULE_REFUSAL_STATUSES: readonly number[] = [400, 422];

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
  /** The kind of the last act whose answer failed — set in the SAME
   *  transition as its `refused`/`invalid` error (the only two that raise
   *  those), so the notice can tell a move from a resign or an offer (the
   *  drawn copy is a move's). Read only beside such an error: once the
   *  error is gone, a stale value here means nothing. */
  failedAct: RoomActBody["kind"] | null;
  /** Bumped whenever the board must be put back on the held position. */
  syncKey: number;
  polling: boolean;
  notFound: boolean;
  /** Final review P10: Lichess said, when the page loaded, that the player's grant no longer plays (narrowed or
   *  revoked at lichess.org). Asked ONCE per page load by the room page and kept for the page: no event changes it.
   *  Re-linking leaves the page, and the page it returns to asks again. */
  grantRefused: boolean;
  /** T17B fix 2, D24: the player's own clock as their dropped move leaves it (the increment added at once). A guess —
   *  clock-math `optimisticOwnMs` says when it applies, and the server's number replaces it the moment the ply is on the
   *  ledger. Set by a move's `act_sent`; removed by a refusal or a failure. */
  optimistic: OptimisticClock | null;
  /** Fix round 4b: the last read (or seat call) found the board being re-paired — it names nobody for now. The
   *  room reads on; the next answered read or seat call says where the player stands. */
  repairing: boolean;
};

export type RoomEvent =
  | { type: "snapshot"; snap: RoomSnapshot; receivedAt: number }
  | { type: "broadcast"; b: RoomBroadcastWire; receivedAt: number }
  | { type: "seat_sent" }
  | { type: "seat_answered"; answer: RoomClaimAnswer; receivedAt: number }
  | { type: "seat_failed"; status: number; code?: string | null }
  /** `at` is the sender's wall clock (Date.now()) when the act was sent: the reducer stays pure, so the instant arrives
   *  with the event, and the viewer's skew turns it into the server's clock. */
  | { type: "act_sent"; action: RoomActBody; at: number }
  | { type: "act_answered"; answer: RoomActAnswer }
  | { type: "act_failed"; status: number }
  | { type: "fetch_failed"; status: number; code?: string | null };

export { plyOf, plyOfFen } from "./ply";
import { plyOf, plyOfFen } from "./ply";

function stopsPolling(snap: RoomSnapshot): boolean {
  return snap.onlineChessOff;
}

export function initialRoomState(snap: RoomSnapshot, receivedAt: number, grantRefused = false): RoomState {
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
    grantRefused,
    optimistic: null,
    repairing: false,
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

/** The hold and seat state a move notice was raised on: who may act, and
 *  why not. A change of any of it ends the notice (T14 re-review 5, I-1). */
function seatState(snap: RoomSnapshot): string {
  return `${snap.canAct}|${snap.frozen}|${snap.held}`;
}

/** The notices' endings that no request of the player's causes: a read
 *  that got an answer ends "offline" (even a stale one — the connection is
 *  back), and C2/C3 end with the board they spoke of — when it moves past
 *  the refused position, when the server says nobody may act on it (a hold,
 *  a frozen seat: the screen that says so outranks the notice), and when the
 *  hold or seat state changes at all, so a stale notice never comes back
 *  once a hold lifts at the same ply (T14 re-review 5, I-1). */
function endNotices(before: RoomState, after: RoomState, answered: boolean): RoomState {
  const offlineEnds = answered && after.error === "network";
  const moveNoticeEnds =
    (after.error === "refused" || after.error === "invalid") &&
    (plyOf(after.snap.game) > plyOf(before.snap.game) || !after.snap.canAct || seatState(after.snap) !== seatState(before.snap));
  return offlineEnds || moveNoticeEnds ? { ...after, error: null } : after;
}

export function roomReducer(s: RoomState, e: RoomEvent): RoomState {
  switch (e.type) {
    case "snapshot": {
      const merged = mergeSnapshot(s, e.snap, e.receivedAt);
      return endNotices(s, merged === s ? s : { ...merged, notFound: false, repairing: false }, true);
    }
    case "broadcast":
      return endNotices(s, applyBroadcast(s, e.b, e.receivedAt), false);
    case "seat_sent":
      if (s.pending !== null) return s;
      return { ...s, pending: { kind: "seat" }, error: null };
    case "seat_answered": {
      const merged = mergeSnapshot(s, e.answer.snapshot, e.receivedAt);
      // D21: `camera_starting` with no token is the platform's RealtimeKit call budget being spent before the server could
      // refresh one — "not yet", never "no camera". The camera has already joined with the token the room holds, so the
      // answer keeps it (and ONLY this answer does: every other tokenless answer means there is none).
      const heldToken = s.seat?.participant ?? null;
      const seat =
        e.answer.seat !== null && !e.answer.seat.seated && e.answer.seat.reason === "camera_starting" && e.answer.seat.participant === null
          ? { ...e.answer.seat, participant: heldToken }
          : e.answer.seat;
      const relink = seat !== null && !seat.seated && (seat.reason === "lichess_link_required" || seat.reason === "lichess_reconsent_required");
      return { ...merged, seat, pending: s.pending?.kind === "seat" ? null : s.pending, error: relink ? "relink" : null, repairing: false };
    }
    case "seat_failed":
      return {
        ...roomCallFailed(s, e.status, e.code ?? null),
        pending: s.pending?.kind === "seat" ? null : s.pending,
      };
    case "act_sent":
      if (s.pending !== null) return s;
      return {
        ...s,
        pending: { kind: "act", action: e.action },
        error: null,
        // D24: only a MOVE earns the increment, and only where the server will add it.
        optimistic:
          e.action.kind === "move"
            ? optimisticAfterDrop({
                game: s.snap.game,
                you: s.snap.you.colour,
                incrementSeconds: s.snap.meta.incrementSeconds,
                resultWritten: s.snap.result !== null,
                atMs: e.at + s.skewMs,
              })
            : null,
      };
    case "act_answered": {
      if (s.pending?.kind !== "act") return s;
      const a = e.answer;
      if (a.ok) return { ...s, pending: null, error: null };
      return {
        ...s,
        pending: null,
        error: a.reconcile ? "refused" : "relink",
        failedAct: s.pending.action.kind,
        syncKey: s.syncKey + 1,
        optimistic: null, // D24: a refusal restores the clock the drop had advanced
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
        error: e.status === 0 ? "network" : ACT_RULE_REFUSAL_STATUSES.includes(e.status) ? "invalid" : "refused",
        failedAct: s.pending.action.kind,
        syncKey: s.syncKey + 1,
        optimistic: null, // D24: a failure restores the clock the drop had advanced
      };
    case "fetch_failed":
      return roomCallFailed(s, e.status, e.code ?? null);
  }
}

/** Fix round 4b: the GET and seat answers that refuse the CALLER for good, and stop the room — the room's one 404
 *  (not their board, their link refused or expired, a board gone or no longer online play: the server collapses them
 *  all, so a probe learns nothing), and 401/403 (no session, or one refused). A reload would show the same card. */
export const ROOM_REFUSAL_STATUSES: readonly number[] = [401, 403, 404];

/** A GET room or seat call that brought no snapshot. The board being re-paired (409 ROOM_BEING_REPAIRED: the organiser
 *  unpaired the round and has not paired it again — minutes, in real use) is never a stop: the room reads on through
 *  the gap at its cadence, and the first read of the re-paired board says where the player stands (their board again,
 *  or the 404 if the re-pair moved them off it). A refusal stops it. Anything else — the network, a 5xx, a 429, another
 *  409 — reads on, as ever. */
function roomCallFailed(s: RoomState, status: number, code: string | null): RoomState {
  if (status === 409 && code === ROOM_BEING_REPAIRED) return { ...s, repairing: true };
  const refused = ROOM_REFUSAL_STATUSES.includes(status);
  return {
    ...s,
    notFound: s.notFound || refused,
    polling: s.polling && !refused,
    error: status === 0 ? "network" : s.error,
  };
}

/** Final re-review 3, R3-1: the server no longer holds the participant this room's camera joined with — none on file,
 *  or another. Two acts delete a player's participant, each with its meeting's row (the participants cascade): the
 *  R2-2 retire — a re-pair's newcomer ends the earlier pairing's meeting under the player who stayed — and the N-2
 *  re-open (final re-review 4, m3), which re-stamps the window and drops the round's game-less meetings while their
 *  rooms are open. The room re-claims the seat, once per change (room-shell), as the re-entry claim does — after a
 *  re-open that checks the player in for the NEW window, the same act a reload's re-entry claim is, and the server
 *  re-verifies the camera — and the answer's token moves the camera to the new meeting. Not this: a dropped connection, an
 *  arbiter's removal, or the sweep ending the meeting — each leaves the participant on file. Never with no token held
 *  (nothing joined), while a seat call is in flight (its answer is the newer word), or where the re-entry claims
 *  nothing (a result, a game over, a club not offered online chess). */
export function ownMeetingRetired(s: RoomState): boolean {
  const held = s.seat?.participant?.participantId ?? null;
  const snap = s.snap;
  return (
    held !== null &&
    snap.ownParticipantId !== held &&
    s.pending === null &&
    snap.result === null &&
    snap.game?.over !== true &&
    !snap.onlineChessOff &&
    // T17B fix 2 (D10): a board the organiser closed has no game coming and no camera to move.
    !snap.boardClosed
  );
}

/** The notice the live board shows for the room's error (C1–C3), or none.
 *  Offline is offline whatever was sent. C2/C3 say "that move", so they are
 *  a MOVE's; a refused resign, offer, answer or abort is never silent — it
 *  shows the generic C2 (`failed`). A re-link is a screen, not this. */
export function moveNotice(s: RoomState): MoveNotice | null {
  if (s.error === "network") return "offline";
  if (s.error === "refused" || s.error === "invalid") return s.failedAct === "move" ? s.error : "failed";
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
