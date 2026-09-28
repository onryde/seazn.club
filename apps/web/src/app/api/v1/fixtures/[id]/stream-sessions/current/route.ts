import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { currentSession, defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** The organiser projection the Phone tab polls (design §6.3). `null` when the fixture has no session. The server-side
 *  ingest poll that turns `warming` into `live` runs inside currentSession — the client never decides.
 *
 *  `?reveal=1` marks the call a CREDENTIAL REVEAL rather than a poll (De): the tab sends it when it first shows the QR
 *  for a session and when the organiser taps Copy, and only then do the reveal counters move. Without the flag a
 *  5-second poll would bank ~120 reveals for one disclosure. Exactly `1` — any other value is a poll. It is a query
 *  flag, not a new route, so ROUTES / NEVER_KEY_ROUTES keep one entry each (documented as a query parameter). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const reveal = new URL(req.url).searchParams.get("reveal") === "1";
    return currentSession(auth, id, defaultDeps(baseUrl(req)), { reveal });
  });
}
