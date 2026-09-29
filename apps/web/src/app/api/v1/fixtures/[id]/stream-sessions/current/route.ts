import { assertOneOf, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { currentSession, defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

const REVEAL = ["1"] as const;

/** The organiser projection the Phone tab polls (design §6.3). `null` when the fixture has no session. The server-side
 *  ingest poll that turns `warming` into `live` runs inside currentSession — the client never decides.
 *
 *  `?reveal=1` marks the call a CREDENTIAL REVEAL rather than a poll (De): the tab sends it when it first shows the QR
 *  for a session and when the organiser taps Copy, and only then do the reveal counters move. Without the flag a
 *  5-second poll would bank ~120 reveals for one disclosure. Exactly `1`; any other value is a 400 (`assertOneOf`, Task 11
 *  review m3) — a disclosure counter that silently read `?reveal=true` as a poll would under-count. It is a query flag,
 *  not a new route, so ROUTES / NEVER_KEY_ROUTES keep one entry each (documented as a query parameter).
 *
 *  The body carries the QR's SRT/RTMPS ingest credentials while a session warms, so EVERY answer is `private, no-store`
 *  and varies on both credentials this route reads — the session cookie, and an API key's Authorization (refused at the
 *  door, NEVER_KEY_ROUTES) — so no shared cache can serve one caller's answer to another (Task 11 review I2; the
 *  2026-09-22 edge review's F-CF1 shape; `api/users/me` sets it on every status the same way). */
export async function GET(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id } = await params;
    const reveal = new URL(req.url).searchParams.get("reveal");
    assertOneOf(reveal, REVEAL, "reveal");
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return currentSession(auth, id, defaultDeps(baseUrl(req)), { reveal: reveal === "1" });
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
