import { parseBody, v1 } from "@/server/api-v1/http";
import { RoomCameraFault } from "@/server/api-v1/schemas";
import { matchRoomIdentity } from "@/server/api-v1/match-room-identity";
import { reportCameraFault } from "@/server/usecases/external-play/room";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/room/camera-fault — the player's
 *  browser left the video meeting because it could not refuse a remote
 *  stream (D7: our safeguard, never the player's camera), or is back in it.
 *  The server stamps the caller's OWN seat on its own clock; T13's camera
 *  evidence never counts the gap against the player (T14 re-review 3, I-1). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const identity = await matchRoomIdentity(req);
    const body = await parseBody(req, RoomCameraFault);
    return reportCameraFault(identity, id, body);
  });
}
