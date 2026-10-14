import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { readExternalPlayLobby } from "@/server/usecases/external-play/lobby";

type Ctx = { params: Promise<{ id: string }> };

/** The answer is about WHO is asking, on a page whose HTML is shared (ISR):
 *  it must never be stored by a browser cache, a CDN or the edge — success
 *  and refusal alike (a cached 404 would hide a player's door from them). */
const LOBBY_CACHE_CONTROL = "private, no-store";

/** GET /api/v1/fixtures/{id}/external-play/lobby — a signed-in player's door
 *  into their match room (T16): the board's state and the room's path, or
 *  "online chess is off for this club" while no game has started. Session
 *  only (`requireUser` reads the session cookie; an API key is never an
 *  identity here). Never writes: there is no POST — check-in happens only in
 *  the room (one venue, D3). A non-player is the room's one 404. */
export async function GET(_req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const user = await requireUser();
    const { id } = await params;
    return readExternalPlayLobby(user.id, id);
  });
  res.headers.set("Cache-Control", LOBBY_CACHE_CONTROL);
  return res;
}
