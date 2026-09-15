import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ResolveExternalPlay } from "@/server/api-v1/schemas";
import { resolveExternalPlay } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/resolve — organiser settles
 *  needs_organiser / stalled online play via the normal scoreEvent path. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, ResolveExternalPlay);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return resolveExternalPlay(auth, id, body.kind);
  });
}
