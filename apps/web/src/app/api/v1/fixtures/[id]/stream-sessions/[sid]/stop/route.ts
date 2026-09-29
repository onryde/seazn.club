import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth, assertUuid } from "@/server/api-v1/auth";
import { stopSession, defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string; sid: string }> };

/** desired_state = ending (design §6.3). Passthrough completes at once; composed completes on the Machine's `stopped`
 *  beat (the heartbeat reply is how it learns). IDEMPOTENT: a repeated stop of a session already ending or ended answers
 *  the same projection and DECIDES nothing — no transition, no provider call. A tap on a session still `ending` is
 *  recorded as the organiser's `action` row (Task 10 n5: the tap is theirs whatever is ending it); a tap on an ended
 *  session writes nothing. A session this fixture has since superseded is 409 not_active. The stop's `action` row
 *  carries the signed-in organiser. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sid } = await params;
    assertUuid(sid, "session");
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return stopSession(auth, id, sid, defaultDeps(baseUrl(req)));
  });
}
