import { v1 } from "@/server/api-v1/http";
import { matchRoomIdentity } from "@/server/api-v1/match-room-identity";
import { requestRoomCamera } from "@/server/usecases/external-play/room";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/room/camera — a player seated under an OPTIONAL camera whose token the
 *  platform's call budget deferred asks for it again (D21-fix-3). The token and nothing else: no check-in is stamped, no
 *  lobby is published, no game is asked for, no seat refusal's side effect re-runs - the seat route (POST …/room) owns
 *  all of that. The body is not read; whether the camera may be asked again is the server's answer, never the
 *  client's inference. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    return requestRoomCamera(await matchRoomIdentity(req), id);
  });
}
