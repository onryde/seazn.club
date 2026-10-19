import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ExtendRoundCheckinInput } from "@/server/api-v1/schemas";
import { extendRoundCheckin } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/stages/{id}/extend-checkin (spec §3.2.2) - the same press on every board of an opened round whose check-in is
 *  open right now. Never an API-key route (key-scopes NEVER_KEY_ROUTES), authorised as the arbiter panel is. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const { roundNo } = await parseBody(req, ExtendRoundCheckinInput);
    return extendRoundCheckin(auth, { stageId: id, roundNo });
  });
}
