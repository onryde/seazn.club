import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CloseExternalPlayFlags } from "@/server/api-v1/schemas";
import { closeExternalPlayFlags } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/flags/close (T16) — "Let the
 *  game go on": the organiser closes the fair-play flags they were shown, by
 *  id. The closed row names who and when. Session only, never an API key. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    // Auth first (fix round 1, M3): a caller who may not decide this board learns nothing about the body's schema.
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const body = await parseBody(req, CloseExternalPlayFlags);
    return closeExternalPlayFlags(auth, id, body.ids);
  });
}
