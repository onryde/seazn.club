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
  | { kind: "offForClub" } // seam B
  | { kind: "revoked" } // seam A
  | { kind: "relink" } // card 8
  | { kind: "over" }
  | { kind: "held" } // seam: a game on file nobody may act on
  | { kind: "live" }
  | { kind: "notOpened" } // card 1
  | { kind: "cameraRequired" } // card 2
  | { kind: "cameraLost" } // card 3
  | { kind: "videoDown" } // card 4
  | { kind: "creating"; retryAt: string | null } // card 5
  | { kind: "closed" } // card 6
  | { kind: "checkin" };

/** A seat refusal's card. Total over SeatRefusal: a new reason fails
 *  compilation here rather than falling through to a default. */
type CardKind = Exclude<RoomScreen, { kind: "creating" }>["kind"];
const REFUSAL_SCREEN: Record<SeatRefusal, CardKind> = {
  camera_required: "cameraRequired",
  camera_lost: "cameraLost",
  video_unavailable: "videoDown",
  lichess_link_required: "relink",
  lichess_reconsent_required: "relink",
  window_closed: "closed",
  round_not_open: "notOpened",
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

export function roomScreen(s: RoomState, ctx: ScreenContext = {}): RoomScreen {
  const snap = s.snap;
  if (s.notFound) return { kind: "unavailable" };
  // T20: no game on file and the club is not offered online chess. A game on
  // file is played out whatever the flag says (the usecase only sets this
  // with no game), so this cannot hide a live board.
  if (snap.onlineChessOff) return { kind: "offForClub" };
  const game = snap.game;
  // A written result outranks every hold on the board (review I1): the
  // frozen player sees how the game ended, never A again.
  if (snap.result !== null || game?.over === true) return { kind: "over" };
  // A token_revoked hold froze the VIEWER's seat: they cannot move until they
  // re-link (A). The opponent's freeze is theirs to fix; this board plays on.
  // The game on ANOTHER Lichess account than the viewer's linked one is A
  // too: play.ts refuses every act, and re-linking that account is the
  // remedy (T14 re-review 5, I-2).
  if (snap.frozen === "you" || snap.frozen === "both" || snap.otherAccount !== null) return { kind: "revoked" };
  // Lichess refused the player's own grant mid-act or at the seat.
  if (s.error === "relink") return { kind: "relink" };
  // A game on file the server will not take an act on (play.ts refuses it:
  // a provider_error hold, T13's deadline hold, a withdrawn board) is shown
  // as it truly is — held, view-only — never live and movable (review I2).
  if (game !== null && !snap.canAct) return { kind: "held" };
  if (game !== null) return { kind: "live" };
  if (snap.phase === "not_opened" || snap.phase === "before") return { kind: "notOpened" };
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
