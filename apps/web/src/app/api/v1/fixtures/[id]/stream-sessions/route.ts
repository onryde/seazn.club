import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateStreamSession } from "@/server/api-v1/schemas";
import { createSession, defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** Start a phone-relay session (streaming R1, design §6.3). Same write gate as PUT /stream — pasting a link and going
 *  live are the same authority; never key-reachable (NEVER_KEY_ROUTES: it spends a credit). The §6.3 gate ORDER and
 *  every typed refusal live in the usecase; the v1 envelope carries each refusal's `extra` (active_session's
 *  `sessionId`, no_credits' `featureKey`, storage_exhausted's `headroomMinutes`, DESTINATION_NOT_ALLOWED's `rule`).
 *  `baseUrl(req)` is where a composed session's Machine is told to call back. 201 { sessionId }. Never a redirect (R8). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateStreamSession);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return reply(201, await createSession(auth, id, body, defaultDeps(baseUrl(req))));
  });
}
