import { parseBody, v1 } from "@/server/api-v1/http";
import { RoomAct } from "@/server/api-v1/schemas";
import { matchRoomIdentity } from "@/server/api-v1/match-room-identity";
import { actInRoom } from "@/server/usecases/external-play/room";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/room/act — a move, a draw offer
 *  or answer, a resignation or an abort. Our server forwards it to Lichess
 *  with the player's own token (T10's act); the client never talks to Lichess.
 *  RoomAct's uci length bound is a cheap first gate only — the strict UCI
 *  check is T3's assertUci (M5), server-side, which refuses a suffixless
 *  promotion with 400 INVALID_UCI. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const identity = await matchRoomIdentity(req);
    const action = await parseBody(req, RoomAct);
    return actInRoom(identity, id, action);
  });
}
