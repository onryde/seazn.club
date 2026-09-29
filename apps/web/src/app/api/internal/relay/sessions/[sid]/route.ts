import { handler } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";
import { bearerOf } from "@/server/relay/bearer";
import { defaultDeps, sessionFactsForJob } from "@/server/usecases/stream-sessions";

type Ctx = { params: Promise<{ sid: string }> };

/** GET /api/internal/relay/sessions/[sid] — the facts a Machine needs (design §6.3): mode, theme, delay, the DECRYPTED
 *  destination, a page token. Job token only (`Authorization: Bearer <jwt>`, verified for THIS sid and the job scope by
 *  the usecase); 410 SESSION_ENDED once the session is terminal. The read also ticks the session's policy (a reconcile),
 *  which is how a Machine's own reads persist its exit facts (A5). Never a redirect (R8).
 *
 *  The 200 is a stream KEY, gated only by the bearer: EVERY answer is `private, no-store` + `Vary: Authorization`, so no
 *  shared cache can hand one caller's facts to the next whatever they sent (Task 11 review I2; the 2026-09-22 edge
 *  review's F-CF1 shape; `api/users/me` sets it on every status the same way). */
export async function GET(req: Request, { params }: Ctx) {
  const res = await handler(async () => {
    const { sid } = await params;
    return sessionFactsForJob(sid, bearerOf(req), defaultDeps(baseUrl(req)));
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Authorization");
  return res;
}
