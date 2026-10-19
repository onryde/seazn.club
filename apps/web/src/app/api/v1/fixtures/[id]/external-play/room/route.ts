import { v1 } from "@/server/api-v1/http";
import { RoomSeatClaim } from "@/server/api-v1/schemas";
import { matchRoomIdentity } from "@/server/api-v1/match-room-identity";
import { claimRoomSeat, readRoom } from "@/server/usecases/external-play/room";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/fixtures/{id}/external-play/room — the match-room snapshot for
 *  one of the fixture's two players (session, or `?t=` personal link). Never
 *  writes. Every identity failure is the same 404. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    return readRoom(await matchRoomIdentity(req), id);
  });
}

/** POST — take the seat. The camera gate is server-verified by preflight's
 *  seatPlayer (RealtimeKit's own presence); the body carries no camera claim.
 *  Its one OPTIONAL field, `heldParticipantId`, says which participant's token
 *  the browser already holds, so a claim answered `camera_starting` need not
 *  hand it another (D21-fix-3, F1) - absent, it holds none. Answers the
 *  snapshot and the seat verbatim, including the caller's OWN participant
 *  token on a camera refusal (to join and retry), and T9's answer when this
 *  seat asked for the game (review m3). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = RoomSeatClaim.parse(await req.json().catch(() => ({})));
    const { snapshot, seat, create } = await claimRoomSeat(await matchRoomIdentity(req), id, {}, { heldParticipantId: body.heldParticipantId ?? null });
    return { snapshot, seat, create };
  });
}
