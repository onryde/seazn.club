import { v1 } from "@/server/api-v1/http";
import { matchRoomIdentity } from "@/server/api-v1/match-room-identity";
import { reportClockZero } from "@/server/usecases/external-play/room";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/room/clock-zero — a player's
 *  clock display reached zero. The server re-does the arithmetic and, only if
 *  it agrees, asks Lichess (reconcile `clock_zero`). A flag is never declared
 *  from arithmetic; the body is not read. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    return reportClockZero(await matchRoomIdentity(req), id);
  });
}
