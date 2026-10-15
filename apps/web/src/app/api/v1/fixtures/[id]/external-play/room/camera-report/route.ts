import { parseBody, v1 } from "@/server/api-v1/http";
import { RoomCameraReport } from "@/server/api-v1/schemas";
import { matchRoomIdentity } from "@/server/api-v1/match-room-identity";
import { reportOwnCamera } from "@/server/usecases/external-play/camera-report";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/room/camera-report (D16, §5.6.3) - the caller's browser reports its own camera
 *  (`live` or `off`) so the OPPONENT's pill can show it; each player is in a meeting of their own, so the opponent's browser
 *  cannot see it. `heartbeat` is a repeat of an unchanged state; a change always writes. Stamps the caller's own player
 *  participant on the server's clock. No vendor call. Nothing but the opponent's pill reads it. 429 past
 *  CAMERA_REPORT_LIMIT. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const identity = await matchRoomIdentity(req);
    const body = await parseBody(req, RoomCameraReport);
    return reportOwnCamera(identity, id, body);
  });
}
