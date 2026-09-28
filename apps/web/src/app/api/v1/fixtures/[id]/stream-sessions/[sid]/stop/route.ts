import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth, assertUuid } from "@/server/api-v1/auth";
import { stopSession, defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string; sid: string }> };

/** desired_state = ending (design §6.3). Passthrough completes at once; composed completes on the Machine's `stopped`
 *  beat (the heartbeat reply is how it learns). IDEMPOTENT: a repeated stop of a session already ending or ended answers
 *  the same projection and writes nothing; a session this fixture has since superseded is 409 not_active. The stop's
 *  `action` row carries the signed-in organiser. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sid } = await params;
    assertUuid(sid, "session");
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return stopSession(auth, id, sid, defaultDeps(baseUrl(req)));
  });
}
