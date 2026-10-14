import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ResolveExternalPlay } from "@/server/api-v1/schemas";
import { resolveExternalPlay } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/resolve (T16) — the organiser
 *  settles an online board (held, or still being played) through the normal
 *  scoring path, under their own authority. Session only, never an API key. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    // Auth first (fix round 1, M3): a caller who may not decide this board learns nothing about the body's schema.
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const body = await parseBody(req, ResolveExternalPlay);
    return resolveExternalPlay(auth, id, body.kind);
  });
}
