import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { streamPhone } from "@/server/usecases/stream-phone";

type Ctx = { params: Promise<{ id: string }> };

/** The organiser panel's phone read model (capture QR v2 §9, §6.12): the fixture's stream code, its paired phone (§6.9's
 *  present / silent / not responding on the server's clock), the destination pre-pick and the last takeover. It carries
 *  no secret. Editor session only (the door's `write` scope), never key-reachable (NEVER_KEY_ROUTES). The panel polls it
 *  every STREAM_POLL_MS beside `current`; it answers a live, per-organiser view, so EVERY answer is `private, no-store`
 *  and varies on both credentials the door reads (the stream-code routes' shape). */
export async function GET(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return streamPhone(auth, id, { now: () => new Date() });
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
