import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { parseBody } from "@/server/api-v1/http";
import { RelayHeartbeat } from "@/server/api-v1/schemas";
import { bearerOf } from "@/server/relay/bearer";
import { defaultDeps, heartbeat } from "@/server/usecases/stream-sessions";

type Ctx = { params: Promise<{ sid: string }> };

/** POST …/heartbeat — the control channel (design §6.4): the Machine reports, the reply carries `{ desiredState }`. A
 *  Machine takes no inbound traffic, so this reply is the only way a stop reaches it. The bearer's PRESENCE is checked
 *  before the body is read; the token itself is verified by the usecase before anything is written. The body is
 *  `RelayHeartbeat` (strict) — never a carrier of exit facts (A5: those are the runner's, persisted from its observed
 *  exit, and a beat must not be able to overwrite them). */
export async function POST(req: Request, { params }: Ctx) {
  return handler(async () => {
    const { sid } = await params;
    const token = bearerOf(req);
    const body = await parseBody(req, RelayHeartbeat);
    return heartbeat(sid, token, body, defaultDeps(baseUrl(req)));
  });
}
