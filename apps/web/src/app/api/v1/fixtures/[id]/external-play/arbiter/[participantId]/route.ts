import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { leaveAsArbiter } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string; participantId: string }> };

/** DELETE /api/v1/fixtures/{id}/external-play/arbiter/{participantId} (T15
 *  fix round 1, I2) — the arbiter panel closed: the server removes the
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
    return leaveAsArbiter(auth, id, participantId);
  });
}
