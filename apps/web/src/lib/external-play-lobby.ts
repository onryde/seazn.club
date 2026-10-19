// The lobby's answer, client-safe (T16): the server's door (`server/usecases/external-play/lobby.ts`, GET
// /api/v1/fixtures/{id}/external-play/lobby) and the public fixture page's "Your board" island read the SAME list, so a
// state added on one side cannot go unrendered on the other.

/** What the door says. The empty case first: a club not offered online chess with no game started is its own state,
 *  with no room to go to — never a fall-through to a board. */
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
      /** The player's own room (`routes.sharedFixturePlay`, no token — the session is the identity there too). */
      roomPath: string;
      /** The round's window (D12), or nulls while it is unopened. */
      opensAt: string | null;
      deadline: string | null;
    };
