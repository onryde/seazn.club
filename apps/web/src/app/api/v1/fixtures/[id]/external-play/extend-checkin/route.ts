import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { extendCheckin } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/extend-checkin (spec §3.2.2) - the arbiter adds 5 minutes to ONE board's check-in
 *  while it is still open. Authorised as the arbiter panel is (an owner or admin, `write`, then the usecase's own signed-in
 *  organiser gate), never an API key: the audit record names the user. 403 ARBITER_PLAYS_THIS_BOARD for an organiser who plays
 *  on the board; 409 ROUND_NOT_OPEN, CHECKIN_NOT_OPEN, CHECKIN_CLOSED, CHECKIN_GAME_STARTED, FIXTURE_NOT_PLAYABLE,
 *  CHECKIN_EXTEND_CAP. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return extendCheckin(auth, id);
  });
}
