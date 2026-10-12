import { v1 } from "@/server/api-v1/http";
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
 *  seatPlayer (RealtimeKit's own presence); the body carries no camera claim
 *  and is not read. Answers the snapshot and the seat verbatim, including the
 *  caller's OWN participant token on a camera refusal (to join and retry). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const { snapshot, seat } = await claimRoomSeat(await matchRoomIdentity(req), id);
    return { snapshot, seat };
  });
}
