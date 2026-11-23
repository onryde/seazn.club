import { v1 } from "@/server/api-v1/http";
import { NOT_A_MEMBER, requireResourceAuth, resourceOrg } from "@/server/api-v1/auth";
import { AuthError, HttpError } from "@/lib/errors";
import { deleteSeaznReplay } from "@/server/video/organiser-replays";

type Ctx = { params: Promise<{ id: string; replayId: string }> };

/** DELETE /api/v1/fixtures/{id}/replays/{replayId} — the organiser deletes one part of a fixture's Seazn replay (Seazn-hosted video,
 *  Task 26), for everyone: the part leaves the match page and the organiser's list at once, and the host's copy is removed (now, or
 *  by the replay move's cleanup when the host refuses). Answers `{ deleted: true }`, the same for a part already deleted.
 *
 *  An EDITOR with a session only (the door's `write` scope, then the use case's own session check): a viewer is 403, and so is an
 *  API key (NEVER_KEY_ROUTES). A signed-in user who is not a member of the fixture's organisation, an id that names nothing and one
 *  that is not a uuid all answer 404, as the organiser's video route does. The delete waits only for the move's own short write to
 *  the row, never for a provider call (server/video/organiser-replays.ts). */
export async function DELETE(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id, replayId } = await params;
    // 404 for a malformed id and an unknown one (`resourceOrg`); `requireResourceAuth` resolves the org once more and runs the door.
    await resourceOrg("fixture", id);
    let auth;
    try {
      auth = await requireResourceAuth(req, "fixture", id, "write");
    } catch (err) {
      if (err instanceof AuthError && err.message === NOT_A_MEMBER) throw new HttpError(404, "fixture not found");
      throw err;
    }
    return deleteSeaznReplay(auth, id, replayId);
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
