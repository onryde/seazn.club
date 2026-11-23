import { clientIp } from "@/lib/client-ip";
import { reply, v1 } from "@/server/api-v1/http";
import { readClientReport, receiveClientReport } from "@/server/client-reports";

/** POST /api/v1/public/client-reports — Seazn-hosted Task 25b (owner 2026-11-23): a browser's report of a failure it saw, for the
 *  server's log and its Sentry, because the browser has no Sentry of its own. Public (a spectator is anonymous) and not bot-checked: a
 *  beacon cannot solve a challenge, and the route writes nothing but a log line and a windowed warning.
 *
 *  The body is one registered kind (server/client-reports/kinds.ts), closed and made of codes: never an address, a token, an `expires`
 *  or a query, and a string shaped like one is a 400. Read under its cap whatever its Content-Type (413 past it). The pipeline drops a
 *  report past its per-IP limit, or about a subject that does not exist, without a word. Every report the body admits is answered the
 *  same empty 204, so the answer never says what became of it. */
export async function POST(req: Request) {
  return v1(async () => {
    const report = await readClientReport(req);
    await receiveClientReport(report, clientIp(req.headers));
    return reply(204, null);
  });
}
