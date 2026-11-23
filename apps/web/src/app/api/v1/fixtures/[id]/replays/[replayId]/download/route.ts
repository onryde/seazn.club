import { v1 } from "@/server/api-v1/http";
import { NOT_A_MEMBER, requireResourceAuth, resourceOrg } from "@/server/api-v1/auth";
import { AuthError, HttpError } from "@/lib/errors";
import { seaznReplayDownload } from "@/server/video/organiser-replays";

type Ctx = { params: Promise<{ id: string; replayId: string }> };

/** Every answer, the file and each refusal: nothing here may be kept by a cache, or served to anyone but the caller. */
function privateNoStore(headers: Headers): void {
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Cookie, Authorization");
}

/** GET /api/v1/fixtures/{id}/replays/{replayId}/download — the organiser downloads one PLAYABLE part of a fixture's Seazn replay
 *  (Seazn-hosted video, Task 26) as an mp4 attachment named for the match and the part (`seazn-<home>-v-<away>-part-<n>.mp4`).
 *
 *  The file is the host's own stream passed straight through: never buffered here, never a redirect to the host, and no host
 *  address, token or key in any header — the browser only ever talks to this route. A part that is not playable (processing,
 *  failed, deleted), or one the host is not ready to hand over, is 409 (try again later). The same door as the delete: an EDITOR
 *  with a session (a viewer and an API key are 403; NEVER_KEY_ROUTES), and 404 for another organisation's fixture, an id that names
 *  nothing and one that is not a uuid. Refusals are the v1 envelope; only the file itself is raw.
 *
 *  How long a download may run: the server sets no limit of its own (Next's `maxDuration` is honoured only by a deployment platform
 *  that reads it; this one self-hosts). The proxies in front decide, and none caps a response that keeps sending; the measured and
 *  documented numbers are in the Task 26 report. */
export async function GET(req: Request, { params }: Ctx) {
  let file;
  try {
    const { id, replayId } = await params;
    await resourceOrg("fixture", id);
    let auth;
    try {
      auth = await requireResourceAuth(req, "fixture", id, "write");
    } catch (err) {
      if (err instanceof AuthError && err.message === NOT_A_MEMBER) throw new HttpError(404, "fixture not found");
      throw err;
    }
    // Review m1: the request's own signal goes to the host, so a viewer who leaves stops the host's stream too.
    file = await seaznReplayDownload(auth, id, replayId, { signal: req.signal });
  } catch (err) {
    const refused = await v1(async () => {
      throw err;
    });
    privateNoStore(refused.headers);
    return refused;
  }
  const headers = new Headers({
    "Content-Type": "video/mp4",
    // The name is slugged to [a-z0-9-] (replayFileName), so it needs no escaping inside the quotes.
    "Content-Disposition": `attachment; filename="${file.fileName}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (file.bytes !== null) headers.set("Content-Length", String(file.bytes));
  privateNoStore(headers);
  // The host's body as it is: a viewer's cancel reaches the host's request through it.
  return new Response(file.body, { status: 200, headers });
}
