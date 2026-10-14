import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { OpenRoundInput } from "@/server/api-v1/schemas";
import { HttpError } from "@/lib/errors";
import { openRound } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** D12 — the organiser opens one round of an online-play stage: stamps it and
 *  invites its players. Never an API-key route (key-scopes NEVER_KEY_ROUTES):
 *  the stamp names the user who opened it. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const { roundNo } = await parseBody(req, OpenRoundInput);
    // Defence in depth behind the never-key listing: no user, no stamp author.
    if (!auth.userId) throw new HttpError(403, "Opening a round needs a signed-in organiser", "OPEN_ROUND_FORBIDDEN");
    return openRound({ stageId: id, roundNo, actorUserId: auth.userId });
  });
}
