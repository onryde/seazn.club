// The match room's wire shape and the pure derivations both ends share.
//
// Isomorphic on purpose: the room usecase (server) composes a RoomSnapshot
// from these helpers and the room shell (client) reads the same type, so a
// field cannot mean one thing on each side. Nothing here touches the DB, a
// token or Lichess; `@/server/external-play/window` is a pure module, and so
// is the engine's boardgame fold.
import { foldMatchWithStoppage, outcomeOf, summaryOf } from "@seazn/engine/core";
import { boardgame, BoardgameMethod } from "@seazn/engine/sports/boardgame";
import { roomPhase, windowFor } from "@/server/external-play/window";

/** Fix round 4b: GET and POST room's answer (409) while the organiser re-pairs the board's round — the board names
 *  nobody for now. The open room reads on through it (room-state), where the room's one 404 stops it for good. */
export const ROOM_BEING_REPAIRED = "ROOM_BEING_REPAIRED";

export type Colour = "white" | "black";
export type RoomPhaseWire = "not_opened" | "before" | "open" | "closed";
export type CameraPolicyWire = "off" | "optional" | "required";

/** Why a seat was refused, as the client renders it — preflight's
 *  SEAT_REFUSAL_REASONS. The four camera refusals carry the caller's own
 *  participant token in the POST answer, never in the snapshot. */
export type SeatRefusal =
  | "camera_required"
  | "camera_lost"
  | "camera_starting"
  | "camera_blocked"
  | "window_closed"
  | "not_a_player"
  | "round_not_open"
  | "fixture_not_playable"
  | "video_unavailable"
  | "lichess_link_required"
  | "lichess_reconsent_required";

/** T17B fix 2 (D2): a seat under `required` waits for the current peer's
 *  own camera report — `media_permission` ACCEPTED and `video_on` — and
 *  answers `camera_starting` until it is there. Sized from the one live
 *  measurement (2026-10-14): `media_permission` was on the report 1.4 s after
 *  PEER_JOINING. The room re-asks on CAMERA_EVIDENCE_BACKOFF_MS (below); the
 *  server stops waiting CAMERA_EVIDENCE_DEADLINE_MS after the peer joined
 *  (about ten times the measured 1.4 s) and answers the camera refusal — or,
 *  when the report itself could not be read, `video_unavailable`. */
export const CAMERA_EVIDENCE_DEADLINE_MS = 15_000;

/** D21 (T17B fix 2, review I2): the re-ask SCHEDULE, which is also the server's minimum interval between vendor reads of
 *  one participant. Every read of a starting camera costs the vendor four calls (a token refresh, the live session, its
 *  participants, the peer report) against an account limit of 1,200 per five minutes, past which EVERY call is refused
 *  for five minutes; polling once a second put 50 boards checking in at once at ~6,000. So the wait between reads grows —
 *  1, 2, 4, 8 s, held at 8 — which reads a camera that is up in the measured ~1.4 s within about a second of it, and
 *  costs a camera that never comes five reads, not twenty. Owner-set (controller ruling, 2026-10-15); never below a
 *  second. */
export const CAMERA_EVIDENCE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

/** The wait after the `readsDone`-th read of a starting camera (1-based: the read that just answered counts), before the
 *  next may be made. The room's timer and the server's per-participant cache (preflight.ts) both come here, so the two
 *  can never disagree about how soon a re-ask is welcome. */
export function cameraEvidenceDelayMs(readsDone: number): number {
  if (!Number.isInteger(readsDone) || readsDone < 1) {
    throw new RangeError(`cameraEvidenceDelayMs needs a read count of 1 or more, got ${readsDone}`);
  }
  return CAMERA_EVIDENCE_BACKOFF_MS[Math.min(readsDone, CAMERA_EVIDENCE_BACKOFF_MS.length) - 1]!;
}

/** The room's own bound on that wait: enough re-asks to reach past the server's deadline by one full last step (the
 *  deadline's verdict needs a read AFTER it), and no more — a server whose clock disagrees with the vendor's can never
 *  make the room poll for ever. Past it the check-in button is offered again. */
export const CAMERA_EVIDENCE_MAX_POLLS = (() => {
  const margin = cameraEvidenceDelayMs(CAMERA_EVIDENCE_BACKOFF_MS.length);
  let elapsed = 0;
  let polls = 0;
  while (elapsed < CAMERA_EVIDENCE_DEADLINE_MS + margin) {
    polls += 1;
    elapsed += cameraEvidenceDelayMs(polls);
  }
  return polls;
})();

export type RoomGame = {
  gameId: string;
  /** The ledger: every move Lichess accepted, UCI. */
  moves: string[];
  fen: string;
  lastMove: [string, string] | null;
  turn: Colour;
  whiteMs: number;
  blackMs: number;
  /** When the two clock values were true (the last accepted move), ISO;
   *  null before any move. The client counts down from here. */
  clockAsOf: string | null;
  /** Lichess starts the clocks once BOTH players have moved (ply 2). */
  clockRunning: boolean;
  drawOfferBy: Colour | null;
  /** The game is over at Lichess (the bridge says finished, or reconcile
   *  stamped game_over_at). Never derived from a clock reaching zero. */
  over: boolean;
};

export type RoomResult = {
  /** The engine's outcome, from the viewer's side: a win (or, W2b, a
   *  forfeit's award) is won/lost; a draw; or no result (a double forfeit —
   *  chess.md §7 — which W2b folds to a double walkover; or, I-3, a VOID
   *  board, abandoned, which has no method and no score). */
  outcome: "won" | "lost" | "draw" | "no_result";
  /** boardgame.result's method, when one was recorded. */
  method: string | null;
  /** White's score first, the way a chess result is written ("1–0",
   *  "½–½", "0–0") — the engine's own points for each side. */
  score: string;
  /** Final review M-1: a level knockout game the organiser settled (`core.settle`, resolve.ts) — who goes through,
   *  from the viewer's side. Absent on every other result, and when the settle names neither seat. */
  through?: "me" | "opponent";
};

export type RoomSnapshot = {
  fixtureId: string;
  /** The server's clock when this was composed — the client derives its
   *  skew from it, never from its own wall clock alone. */
  serverNow: string;
  phase: RoomPhaseWire;
  scheduledAt: string | null;
  roundOpenedAt: string | null;
  opensAt: string | null;
  deadline: string | null;
  links: { fixture: string; standings: string };
  meta: {
    divisionName: string;
    roundNo: number;
    boardNo: number;
    limitSeconds: number;
    incrementSeconds: number;
  };
  orgSlug: string;
  you: { colour: Colour; name: string; checkedIn: boolean };
  opponent: { colour: Colour; name: string; checkedIn: boolean };
  cameraPolicy: CameraPolicyWire;
  /** Where the opponent's presence pill may show, and who the opponent is in
   *  the meeting: their RealtimeKit participant id, or null when they hold no
   *  seat in it (absent by construction). The pill's answer is the viewer's
   *  OWN client's (review I8: opponent-presence.ts) — the server never asks
   *  the vendor for it. null ⇒ no pill (policy off, an override, a board
   *  nobody may play on). */
  opponentPresence: { participantId: string | null } | null;
  /** Final re-review 3, R3-1: the VIEWER's own player participant in the board's meeting, as the server holds it
   *  (preflight's one rule, ended meeting or not), or null with none on file. Never a token. The room compares it
   *  with the participant its camera joined with: the R2-2 retire deletes a re-paired board's meeting with its
   *  participants, so the player who stayed reads null (then the new meeting's id) and re-claims the seat. A drop,
   *  an arbiter's removal or the sweep's end of the meeting leaves it as it was. */
  ownParticipantId: string | null;
  /** Which seat a seat hold (token_revoked, account_changed) froze, from the VIEWER's side. null
   *  once a result is written (the result outranks the freeze — review I1). */
  frozen: "you" | "opponent" | "both" | null;
  /** The server would accept an act from YOU on the game on file — T10's
   *  own predicate (play.ts `playableGame` and its frozen seats), not a
   *  second reading. false with no game. A game on file you may not act on
   *  is a held board: never rendered live and movable (review I2). */
  canAct: boolean;
  /** You may not act because your linked Lichess account is not the one
   *  this game was created on (re-linked to another, or unlinked) — play.ts's
   *  own acceptance (`actAcceptance`), never a second reading (T14 re-review
   *  5, I-2). The value is the account the game IS on: T9's recorded Lichess
   *  id for your seat (Lichess's lowercased username, which it signs in by),
   *  read by the server — the room names it (re-review 6, N-2). The room
   *  shows A with that line; re-linking that account is the remedy. null
   *  whenever you may act, or another reason comes first (a frozen seat, a
   *  held, finished or withdrawn board). */
  otherAccount: string | null;
  /** No game on file and the club is not offered online chess (T20). The
   *  client renders a plain state and STOPS polling. */
  onlineChessOff: boolean;
  /** T17B fix 2 (D10): our side closed this board's bridge (`finished`)
   *  before any game was on file, and no result stands — the organiser's
   *  "No result" then voided, say. No game will ever be created on it (T9
   *  claims only a pending bridge), so the room says the board is closed,
   *  never "setting up". A Swiss re-pair deletes the row (M-10) and the room
   *  reads open again. */
  boardClosed: boolean;
  /** Both in, no game yet: being created, or held back by Lichess's rate
   *  limit until `retryAt`. null otherwise (and always null when
   *  `boardClosed`). */
  creation: null | { state: "creating" } | { state: "busy"; retryAt: string | null };
  game: RoomGame | null;
  /** Held for the organiser (needs_organiser) with no result written. */
  held: boolean;
  result: RoomResult | null;
  watchUrl: string | null;
  realtime: { topic: string; token: string; expiresAt: string } | null;
};

/** D12 (spec §3.2): a fixture with no `round_opened_at` is NOT yet playable
 *  and must say so — it is not "before the window", because no window
 *  exists. Once opened, T−10/T+20 are measured from the open, so the shipped
 *  `roomPhase` is reused unchanged with `round_opened_at` in the argument
 *  slot its parameter name still calls `scheduledAt`. The schedule is what
 *  players are SHOWN; it never reaches this function. */
export function roomPhaseWire(a: { now: Date; roundOpenedAt: Date | null }): RoomPhaseWire {
  if (a.roundOpenedAt === null) return "not_opened";
  return roomPhase(a.now, a.roundOpenedAt);
}

/** The open's window, or nulls while the round is unopened. */
export function windowWire(roundOpenedAt: Date | null): { opensAt: string | null; deadline: string | null } {
  if (roundOpenedAt === null) return { opensAt: null, deadline: null };
  const w = windowFor(roundOpenedAt);
  return { opensAt: w.opensAt.toISOString(), deadline: w.deadline.toISOString() };
}

/** A token_revoked hold's frozen seat, as the viewer reads it. */
export function frozenFor(revokedSeat: Colour | "both" | null, mine: Colour): RoomSnapshot["frozen"] {
  if (revokedSeat === null) return null;
  if (revokedSeat === "both") return "both";
  return revokedSeat === mine ? "you" : "opponent";
}

/** The two clock values the board shows and how they run.
 *
 *  Before the first move the bridge has no clock values: both sides show the
 *  division's own limit. Lichess starts the clocks once both have moved, so
 *  `running` is ply ≥ 2 and the game not over. The values are as of
 *  `lastMoveAt` (T10 stores them that way). */
export function gameClocks(a: {
  limitMs: number;
  whiteMs: number | null;
  blackMs: number | null;
  lastMoveAt: Date | null;
  moveCount: number;
  over: boolean;
}): { whiteMs: number; blackMs: number; clockAsOf: string | null; clockRunning: boolean } {
  return {
    whiteMs: a.whiteMs ?? a.limitMs,
    blackMs: a.blackMs ?? a.limitMs,
    clockAsOf: a.lastMoveAt?.toISOString() ?? null,
    clockRunning: a.moveCount >= 2 && !a.over,
  };
}

/** Whose move a ledger of `moveCount` plies leaves. */
export function turnAfter(moveCount: number): Colour {
  return moveCount % 2 === 0 ? "white" : "black";
}

const ENGINE_METHODS: ReadonlySet<string> = new Set(BoardgameMethod.options);
/** The engine's default boardgame scoring IS the FIDE game score (a win 1, a
 *  draw ½, in half-points) — the division's tournament points never change
 *  how a chess result is written. */
const GAME_SCORE_CFG = boardgame.configSchema.parse({});

type Seats = { myEntrantId: string; opponentEntrantId: string; myColour: Colour };

/** The card's facts from a short ledger, as the ENGINE folds it (review I7): its outcome kind from the viewer's side
 *  and its points for each side, White first. Only the kinds the card can word are worded — a win or (W2b) a forfeit's
 *  award is won/lost, a draw a draw, and a double forfeit (W2b BG-DW-1: a double walkover, whatever shape recorded it)
 *  no result; anything else is null, never worded as one of those. */
function foldedResult(
  a: Seats,
  decisive: { type: string; payload: unknown },
  methodOf: (summaryMethod: string | null) => string | null,
): RoomResult | null {
  const white = a.myColour === "white" ? a.myEntrantId : a.opponentEntrantId;
  const black = a.myColour === "white" ? a.opponentEntrantId : a.myEntrantId;
  const at = "1970-01-01T00:00:00.000Z";
  // W2b PF-1: the fold's outcome and headline through the kernel's own readers (outcomeOf/summaryOf), never the
  // module's bare outcome/summary of its state — the one rule every fold reader keeps (outcome-readers.test.ts).
  const folded = foldMatchWithStoppage(
    boardgame,
    GAME_SCORE_CFG,
    { home: { entrantId: white, slots: [] }, away: { entrantId: black, slots: [] } },
    [
      { id: "start", fixtureId: "room", seq: 0, type: "core.start", payload: {}, recordedAt: at, recordedBy: null },
      { id: "decisive", fixtureId: "room", seq: 1, type: decisive.type, payload: decisive.payload, recordedAt: at, recordedBy: null },
    ],
  );
  const o = outcomeOf(boardgame, folded);
  if (o === null) return null;
  const summary = summaryOf(boardgame, folded);
  const line = (entrant: string) => summary.perSide.find((p) => p.entrantId === entrant)?.line ?? "";
  // The sweeps in room-snapshot.test.ts walk every method and every forfeit
  // reason through the engine and reach exactly these kinds.
  const outcome: RoomResult["outcome"] | null =
    o.kind === "win" || o.kind === "award"
      ? o.winner === a.myEntrantId
        ? "won"
        : "lost"
      : o.kind === "draw"
        ? "draw"
        : o.kind === "no_result" || o.kind === "double_walkover"
          ? "no_result"
          : null;
  if (outcome === null) return null;
  const summaryMethod = (summary.detail as { method?: unknown } | undefined)?.method;
  return { outcome, method: methodOf(typeof summaryMethod === "string" ? summaryMethod : null), score: `${line(white)}–${line(black)}` };
}

const holdsASeat = (entrant: string, a: Seats) => entrant === a.myEntrantId || entrant === a.opponentEntrantId;

/** The game-over card's facts from the recorded boardgame.result (winner an
 *  entrant id or null), as the ENGINE folds it (review I7). A method the
 *  engine does not know is carried for the record and folded as none. A
 *  winner who is neither seat is no result this room can state: null, and the
 *  screen says the result is on its way. A result the engine's own schema
 *  refuses (W2b f-w2: a double forfeit with a winner) throws, as the engine
 *  does — a stored ledger never holds one. */
export function resultFor(a: Seats & { winnerEntrantId: string | null; method: string | null }): RoomResult | null {
  if (a.winnerEntrantId !== null && !holdsASeat(a.winnerEntrantId, a)) return null;
  const method = a.method !== null && ENGINE_METHODS.has(a.method) ? a.method : undefined;
  return foldedResult(
    a,
    { type: "boardgame.result", payload: { winner: a.winnerEntrantId, ...(method === undefined ? {} : { method }) } },
    () => a.method,
  );
}

/** The game-over card's facts from a recorded `core.forfeit` — how W2b records every chess forfeit (spec §5.2): a
 *  no-show's walkover, the organiser's default win, the organiser's No result (`by: "both"`). Folded by the engine
 *  after a Start (chess admits every forfeit reason there, ruling 118), its method the engine's own summary method
 *  ("forfeit", "double_forfeit"). `by` naming neither seat nor "both" is null, like a stranger's win. */
export function forfeitResultFor(a: Seats & { by: string; reason: string }): RoomResult | null {
  if (a.by !== "both" && !holdsASeat(a.by, a)) return null;
  return foldedResult(a, { type: "core.forfeit", payload: { by: a.by, reason: a.reason } }, (m) => m);
}

/** A ledger event that decides a board, as its readers select it (room.ts, arbiter.ts): the latest unvoided
 *  `boardgame.result` or `core.forfeit`. */
export type DecisiveEvent =
  | { type: "boardgame.result"; payload: { winner?: string | null; method?: string } }
  | { type: "core.forfeit"; payload: { by?: string; reason?: string } };

/** The card's facts from whichever event decided the board. A stored forfeit always names `by` and `reason`
 *  (CoreForfeit is strict); one that does not names no seat, and is null. */
export function decisiveResultFor(e: DecisiveEvent, seats: Seats): RoomResult | null {
  if (e.type === "core.forfeit") {
    if (e.payload.by === undefined || e.payload.reason === undefined) return null;
    return forfeitResultFor({ ...seats, by: e.payload.by, reason: e.payload.reason });
  }
  return resultFor({ ...seats, winnerEntrantId: e.payload.winner ?? null, method: e.payload.method ?? null });
}

/** M-1: a drawn game's card, with who the organiser's settle sent through. Only a DRAW takes it (a settle follows a
 *  level game, W2a), and only a winner holding a seat: anything else is the result as it was. */
export function withSettle(result: RoomResult | null, settleWinner: string | null, seats: Seats): RoomResult | null {
  if (result === null || result.outcome !== "draw" || settleWinner === null || !holdsASeat(settleWinner, seats)) return result;
  return { ...result, through: settleWinner === seats.myEntrantId ? "me" : "opponent" };
}

/** I-3: the card for an ABANDONED board — VOID, nobody's result. The engine folds an abandon to no outcome (the
 *  fixture reads `abandoned`, append-event.ts's derivation of that fold), so there is no method and no score to show:
 *  the card says No result and nothing more. */
export const ABANDONED_RESULT: RoomResult = { outcome: "no_result", method: null, score: "" };

/** How long the room's realtime subscriber token lives. It used to be the
 *  window's deadline (T+20), which cut a running game's broadcasts off
 *  mid-game (T10 review carry). Now every snapshot read mints one that lives
 *  ROOM_REALTIME_TTL_MS from the read, and the client re-reads well inside
 *  that, so the subscription outlives any game. */
export const ROOM_REALTIME_TTL_MS = 60 * 60_000;

export function realtimeExpiry(now: Date): Date {
  return new Date(now.getTime() + ROOM_REALTIME_TTL_MS);
}
