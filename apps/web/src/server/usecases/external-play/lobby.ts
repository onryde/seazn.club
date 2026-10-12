import "server-only";
// The lobby (T16, controller ruling 2026-10-12): a signed-in player's DOOR
// from the public fixture page into their match room. One venue (D3): the
// board, the camera and the check-in all live in the room (T14); the lobby
// only answers "do you play on this board, what state is it in, and where is
// your room?" for a client island on a page that is ISR and so can render
// nothing about who is looking at it.
//
// It is a PROJECTION of the room's own read — `readRoom` with the session as
// the identity — so who counts as a player, the D12 phase and the T20 start
// gate each have one authority, the room's. It never writes (readRoom
// never does), and it hands back nothing the room's snapshot carries for
// play: no realtime token, no participant, no game, no opponent name.
import { HttpError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { loadOnlinePlayFixture } from "./guard";
import { readRoom, type RoomDeps } from "./room";

/** What the door says. The empty case first: a club not offered online chess
 *  with no game started is its own state, with no room to go to — never a
 *  fall-through to a board. */
export const LOBBY_STATES = [
  "online_chess_off",
  "not_opened",
  "before",
  "check_in",
  "closed",
  "playing",
  "held",
  "over",
] as const;
export type LobbyState = (typeof LOBBY_STATES)[number];

export type ExternalPlayLobby =
  | { state: "online_chess_off"; roomPath: null }
  | {
      state: Exclude<LobbyState, "online_chess_off">;
      /** The player's own room (`routes.sharedFixturePlay`, no token — the
       *  session is the identity there too). */
      roomPath: string;
      /** The round's window (D12), or nulls while it is unopened. */
      opensAt: string | null;
      deadline: string | null;
    };

/**
 * The door for `userId` on `fixtureId`. Every failure is the room's own: a
 * user who is not one of the two players, another club's player, a fixture
 * that is not an online one — the same 404, never a hint which.
 */
export async function readExternalPlayLobby(userId: string, fixtureId: string, deps: RoomDeps = {}): Promise<ExternalPlayLobby> {
  const s = await readRoom({ kind: "session", userId }, fixtureId, deps);
  // T20 (the room's `onlineChessOff`): online play STARTS only for a club
  // offered it, and a board with a game — or a create already sent — is never
  // gated. Finishing play is never gated, so the off state is only ever an
  // unstarted board.
  if (s.onlineChessOff) return { state: "online_chess_off", roomPath: null };
  // readRoom resolved the fixture as an online one a moment ago; it can only
  // be gone now if it was deleted in between, which is the room's 404 too.
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) throw new HttpError(404, "This match room could not be found", "NOT_FOUND");
  return {
    state: stateOf(s),
    roomPath: routes.sharedFixturePlay(f.orgSlug, f.competitionSlug, f.divisionSlug, f.fixtureId),
    opensAt: s.opensAt,
    deadline: s.deadline,
  };
}

function stateOf(s: Awaited<ReturnType<typeof readRoom>>): Exclude<LobbyState, "online_chess_off"> {
  if (s.result !== null || s.game?.over === true) return "over";
  if (s.held) return "held";
  if (s.game !== null) return "playing";
  switch (s.phase) {
    case "not_opened":
      return "not_opened";
    case "before":
      return "before";
    case "open":
      return "check_in";
    case "closed":
      return "closed";
  }
}
