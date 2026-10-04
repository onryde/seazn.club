import { HttpError } from "@/lib/errors";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { currentSession, defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** The organiser projection the Phone tab polls (design §6.3). `null` when the fixture has no session. The server-side
 *  ingest poll that turns `warming` into `live` runs inside currentSession — the client never decides.
 *
 *  Capture QR v2 §6.13 (W4, T11): the v1 QR is gone from this projection, and with it the `reveal` query flag that marked
 *  a credential disclosure. A tab still sending it (an old bundle) gets a 400 naming it — never a silent poll — and
 *  nothing is counted: `credentials_served_*` count descriptor serves alone (§17.3).
 *
 *  EVERY answer is `private, no-store` and varies on both credentials this route reads — the session cookie, and an API
 *  key's Authorization (refused at the door, NEVER_KEY_ROUTES) — so no shared cache can serve one caller's projection to
 *  another (Task 11 review I2; the 2026-09-22 edge review's F-CF1 shape; `api/users/me` sets it on every status). */
export async function GET(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id } = await params;
    if (new URL(req.url).searchParams.has("reveal")) throw new HttpError(400, "reveal is not a parameter of this route");
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return currentSession(auth, id, defaultDeps(baseUrl(req)));
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
