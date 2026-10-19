// Which screen the room shows — ONE pure decision over the reducer's state,
// so every state card is reachable by a test and the order of precedence is
// written down once (room-screen.test.ts walks it).
//
// The owner-approved canvas (2026-10-11) names the screens: the check-in,
// the live room, game over, and state cards 1–8 (card 9, the camera-off
// banner, sits ON the live room, never instead of it). Three states have no
// approved drawing yet — `revoked` (A), `offForClub` (B) and `held` (a game
// on file the server takes no move on, review I2): their logic is final,
// their presentation a minimal seam (room-seams.tsx).
import type { RoomState } from "./room-state";
import type { SeatRefusal } from "./room-snapshot";

export type RoomScreen =
  | { kind: "unavailable" } // card 7
  | { kind: "repairing" } // fix round 4b: the organiser is re-pairing the round
  | { kind: "offForClub" } // seam B
  | { kind: "revoked" } // seam A
  | { kind: "seatHeld" } // seam A's layout, a hold the viewer did not cause (R2-1)
  | { kind: "relink" } // card 8
  | { kind: "wrongAccount"; viewerEmail: string } // the viewer is signed in as ANOTHER account: stands where card 8 / seam A's Lichess link prompt would
  | { kind: "over" }
  | { kind: "held" } // seam: a game on file nobody may act on
  | { kind: "live" }
  | { kind: "notOpened" } // card 1
  | { kind: "batchWait" } // spec §6.1 (1): the round is open, this board's check-in batch is not yet
  | { kind: "cameraRequired" } // card 2
  | { kind: "cameraLost" } // card 3
  | { kind: "cameraBlocked" } // T17B fix 2 (D2): the browser refused the camera — reload after allowing it
  | { kind: "videoDown" } // card 4
  | { kind: "creating"; retryAt: string | null } // card 5
  | { kind: "closed" } // card 6
  | { kind: "boardClosed" } // T17B fix 2 (D10): the organiser closed the board before any game
  | { kind: "checkin" };

/** A seat refusal's card. Total over SeatRefusal: a new reason fails
 *  compilation here rather than falling through to a default. */
type CardKind = Exclude<RoomScreen, { kind: "creating" } | { kind: "wrongAccount" }>["kind"];
const REFUSAL_SCREEN: Record<SeatRefusal, CardKind> = {
  camera_required: "cameraRequired",
  camera_lost: "cameraLost",
  // T17B fix 2 (D2): joined, the camera's own report not in yet — the check-in
  // stays up while the room re-asks (room-shell); it is never a card.
  camera_starting: "checkin",
  camera_blocked: "cameraBlocked",
  video_unavailable: "videoDown",
  lichess_link_required: "relink",
  lichess_reconsent_required: "relink",
  window_closed: "closed",
  round_not_open: "notOpened",
  // Spec §3.2.1: the round is open but THIS board's batch has not opened - the card says when.
  checkin_not_open: "batchWait",
  // Spec §5.7: the call budget is holding the claim in the check-in line - the check-in card itself shows the line (§6.1).
  queued: "checkin",
  not_a_player: "unavailable",
  fixture_not_playable: "unavailable",
};

export function seatRefusalScreen(reason: SeatRefusal): CardKind {
  return REFUSAL_SCREEN[reason];
}

export type ScreenContext = {
  /** The player's camera is joining, or up while the seat is re-asked
   *  (room-shell): a camera refusal is then in hand, not yet a card. */
  cameraSettling?: boolean;
};

/** T17B fix 2 (D8a, controller ruling): the screens on which the player's camera is over — the result, the closed
 *  card, and (D10) a board the organiser closed before any game. The room leaves its meeting there (room-shell → use-own-camera). Every other screen may still have a
 *  game, or a camera owed: a held board, a frozen seat, a board being re-paired keep it. */
export function cameraEnds(s: RoomState): boolean {
  const kind = roomScreen(s).kind;
  return kind === "over" || kind === "closed" || kind === "boardClosed";
}

export function roomScreen(s: RoomState, ctx: ScreenContext = {}): RoomScreen {
  const screen = baseScreen(s, ctx);
  // Owner staging test 2026-10-19: a personal link opened while signed in as ANOTHER account. Pressing "Link Lichess"
  // there links the wrong account (the seat is never any the wiser and asks again), so the two screens that offer that
  // link - card 8 and seam A's notice - give way to the card that says whose board this is and offers to switch. Only
  // those two: every other screen (the check-in, a live board, a result) is the seat's, whoever is looking, as it was.
  const account = s.snap.account;
  if ((screen.kind === "relink" || screen.kind === "revoked") && account.state === "wrong_account") {
    return { kind: "wrongAccount", viewerEmail: account.viewerEmail };
  }
  return screen;
}

/** The screen before the account question: the precedence the room has always had. */
function baseScreen(s: RoomState, ctx: ScreenContext): RoomScreen {
  const snap = s.snap;
  if (s.notFound) return { kind: "unavailable" };
  // Fix round 4b: the board is being re-paired — the snapshot in hand is the OLD pairing (its opponent, its
  // window), so nothing of it is shown until a read of the re-paired board lands.
  if (s.repairing) return { kind: "repairing" };
  // T20: no game on file and the club is not offered online chess. A game on
  // file is played out whatever the flag says (the usecase only sets this
  // with no game), so this cannot hide a live board.
  if (snap.onlineChessOff) return { kind: "offForClub" };
  const game = snap.game;
  // A written result outranks every hold on the board (review I1): the
  // frozen player sees how the game ended, never A again.
  if (snap.result !== null || game?.over === true) return { kind: "over" };
  // A seat hold froze the VIEWER's seat — their token was refused, or they
  // unlinked or re-linked another account: they cannot move until they
  // re-link (A). The game on ANOTHER Lichess account than the viewer's
  // linked one is A too: play.ts refuses every act, and re-linking that
  // account is the remedy (T14 re-review 5, I-2).
  if (snap.frozen === "you" || snap.otherAccount !== null) return { kind: "revoked" };
  // Lichess refused the player's own grant mid-act or at the seat — or said so when the page loaded (P10).
  if (s.error === "relink" || s.grantRefused) return { kind: "relink" };
  // Final re-review 2, R2-1: a seat hold the viewer did NOT cause is never A
  // ("your link was revoked", and a re-link that lifts nothing). "both"
  // cannot tell the player who changed from the one who did not (no seat
  // recorded, two seats, or ruling N2's widening of one), so it blames
  // nobody. The opponent's freeze on a board with no game (their change
  // landed while the create was in flight) leaves nothing to play on: the
  // board is with the organiser — never "check-in has closed".
  if (snap.frozen === "both" || (snap.frozen === "opponent" && game === null)) return { kind: "seatHeld" };
  // The opponent's freeze on a game on file: this board plays on.
  // A game on file the server will not take an act on (play.ts refuses it:
  // a provider_error hold, T13's deadline hold, a withdrawn board) is shown
  // as it truly is — held, view-only — never live and movable (review I2).
  if (game !== null && !snap.canAct) return { kind: "held" };
  if (game !== null) return { kind: "live" };
  // T17B fix 2 (D10): our side closed the bridge before any game and no result stands (a No result, then voided):
  // no game will ever be created, so neither the window's cards nor "setting up" may show. A re-pair (above) and a
  // result (over) still outrank it; a re-paired board's fresh bridge reads open again.
  if (snap.boardClosed) return { kind: "boardClosed" };
  // Spec §6.1 (1): `before` splits on whether the round is stamped. No stamp: the organiser has not opened it (card 1,
  // unchanged). Stamped, board's batch not yet open: the batch-wait card, whose copy would be false on card 1.
  if (snap.phase === "not_opened") return { kind: "notOpened" };
  if (snap.phase === "before") return { kind: "batchWait" };
  if (snap.phase === "closed" || snap.held) return { kind: "closed" };
  // The window is open and there is no game yet.
  if (s.seat !== null && !s.seat.seated) {
    const cameraRefusal = s.seat.reason === "camera_required" || s.seat.reason === "camera_lost";
    if (cameraRefusal && ctx.cameraSettling === true) return { kind: "checkin" };
    return { kind: seatRefusalScreen(s.seat.reason) } as RoomScreen;
  }
  if (snap.creation !== null) {
    return { kind: "creating", retryAt: snap.creation.state === "busy" ? snap.creation.retryAt : null };
  }
  return { kind: "checkin" };
}
