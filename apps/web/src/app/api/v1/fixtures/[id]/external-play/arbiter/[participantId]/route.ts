import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ArbiterRevokeInput } from "@/server/api-v1/schemas";
import { leaveAsArbiter } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string; participantId: string }> };

/** DELETE /api/v1/fixtures/{id}/external-play/arbiter/{participantId} (T15
 *  fix round 1, I2; owner 2026-11-17) — EXPLICIT REVOCATION only, never the
 *  panel closing (the browser keeps its token and leaves with the SDK; the sweep and the teardown
 *  do the server's cleanup): the body `{ "intent": "revoke" }` (ArbiterRevokeInput, strict; any other body
 *  is a 400 reaching no usecase and no vendor), read AFTER auth so a caller who may not act is
 *  never asked for a body. The server removes the
 *  caller's OWN arbiter participant from the board's meeting, so its token
 *  can no longer watch. `read` scope on purpose: giving up one's own access
 *  needs no editor role, so an organiser demoted mid-watch can still close
 *  it (the sweep removes it either way). Never an API key
 *  (key-scopes NEVER_KEY_ROUTES). 404 for a participant that is not the
 *  caller's on this board; 503 VIDEO_UNAVAILABLE when RealtimeKit is down. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, participantId } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "read");
    await parseBody(req, ArbiterRevokeInput);
    return leaveAsArbiter(auth, id, participantId);
  });
}
