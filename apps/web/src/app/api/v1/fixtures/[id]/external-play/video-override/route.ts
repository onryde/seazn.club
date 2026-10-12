import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { VideoOverrideInput } from "@/server/api-v1/schemas";
import { overrideVideoAsOrganiser } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/video-override (D11) — RealtimeKit
 *  is down under policy `required`: the organiser lets this board play
 *  without video. The audit record names the signed-in user, so never an API
 *  key. 409 FIXTURE_NOT_PLAYABLE / VIDEO_NOT_REQUIRED (Task 8). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const { note } = await parseBody(req, VideoOverrideInput);
    return overrideVideoAsOrganiser(auth, id, note);
  });
}
