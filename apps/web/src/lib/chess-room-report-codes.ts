// Online chess camera rooms (Task 25b follow-up, owner 2026-11-23): the ONE vocabulary of a camera room's connection-drop report. The two
// surfaces that join a RealtimeKit meeting send it (components/public-site/match-room/camera-loader.ts `watchRoomDrops`: the player's
// camera and the arbiter's) and the `chess-room` client report (server/client-reports/chess-room.ts) takes it, so both sides read the
// same lists. Zero imports: the client bundle and the bare OpenAPI generator both load it. Every member is a code: never a token, a
// peer, a name or an error's text.

/** The leave states that are a LOST connection (RealtimeKit's `LeaveRoomState`): a socket or media-node drop, the SDK giving up, and the
 *  SDK leaving on its own. Every other state is a planned leave (our server's `kicked` / `ended`, or no connection loss) and is never
 *  reported. camera-loader.ts types its own set from this list against the SDK's union, so a state the SDK drops is a compile error. */
export const ROOM_DROP_STATES = ["disconnected", "failed", "left"] as const;
export type RoomDropState = (typeof ROOM_DROP_STATES)[number];

/** Whether a leave state is a lost connection. */
export function isRoomDropState(state: string): state is RoomDropState {
  return (ROOM_DROP_STATES as readonly string[]).includes(state);
}

/** Who joined the meeting: the player's own camera, or the arbiter watching it. */
export const ROOM_REPORT_SURFACES = ["player", "arbiter"] as const;
/** The meeting's side as the joining surface names it: the player's colour, the arbiter's meeting side. */
export const ROOM_REPORT_SIDES = ["white", "black", "home", "away"] as const;
