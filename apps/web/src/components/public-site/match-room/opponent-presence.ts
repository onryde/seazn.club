// The opponent's presence pill (spec §5.3: "compliance without a face"),
// answered by the viewer's OWN RealtimeKit client (review I8, controller
// ruling): the server sends only which participant is the opponent; whether
// they are in the meeting and on camera is read from this client's signalling
// (camera-loader.ts `link()`), at zero network cost.
import type { MeetingLink } from "./camera-loader";
import type { RoomSnapshot } from "./room-snapshot";

/** The peer list arrives after the join: until then everyone looks absent,
 *  so no pill — rather than a false "camera off" — for this long after each
 *  (re)join. */
export const PRESENCE_SETTLE_MS = 4_000;
/** Producer changes emit no event in the SDK (2.0.2): the pill re-reads on
 *  this local timer. No network. */
export const PRESENCE_TICK_MS = 1_000;

/** From the snapshot (room-snapshot.ts `opponentPresence`). */
export type OpponentPresenceWire = RoomSnapshot["opponentPresence"];

/** true ⇒ "on camera"; false ⇒ "camera off" — only when that is a fact; null
 *  ⇒ no pill (not joined, not settled, connection down, or not shown). */
export function opponentPresenceView(link: MeetingLink | null, opponent: OpponentPresenceWire, now: number): boolean | null {
  if (opponent === null || link === null) return null;
  if (now - link.joinedAt < PRESENCE_SETTLE_MS) return null;
  if (opponent.participantId === null) return false;
  return link.peers.some((p) => p.userId === opponent.participantId && p.videoLive);
}
