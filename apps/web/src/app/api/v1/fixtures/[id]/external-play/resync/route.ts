import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { resyncExternalPlay } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/resync (T15) — the organiser's
 *  "Resync from Lichess": reconcile with trigger `organiser` (design §3.5).
 *  Session only, never an API key. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return resyncExternalPlay(auth, id);
  });
}
