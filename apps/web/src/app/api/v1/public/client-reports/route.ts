import { clientIp } from "@/lib/client-ip";
import { reply, v1 } from "@/server/api-v1/http";
import { readClientReport, receiveClientReport } from "@/server/client-reports";

/** POST /api/v1/public/client-reports — Seazn-hosted Task 25b (owner 2026-11-23): a browser's report of a failure it saw, for the
 *  server's log and its Sentry: unlike the browser's own Sentry (consented visitors only, loaded late, stoppable by an ad-blocker), it
 *  reaches the server for every viewer, under the server's dedupe and budgets. Public (a spectator is anonymous) and not bot-checked: a
 *  beacon cannot solve a challenge, and the route writes nothing but a log line and a windowed warning.
 *
 *  The body is one registered kind (server/client-reports/kinds.ts), closed and made of codes: never an address, a token, an `expires`
 *  or a query, and a string shaped like one is a 400. Read under its cap whatever its Content-Type (413 past it; the cap bounds what
 *  this handler reads, not what the server receives: proxy.ts runs here, and Next buffers up to 10 MB of a proxied body before any
 *  handler, kept for proxy's Origin check). The pipeline drops a report past its per-IP limits, or about a subject that does not exist,
 *  without a word, and keeps one past its kind's Sentry budget out of Sentry. Every report the body admits is answered the same empty
 *  204, so the answer never says what became of it. */
export async function POST(req: Request) {
  return v1(async () => {
    const report = await readClientReport(req);
    await receiveClientReport(report, clientIp(req.headers));
    return reply(204, null);
  });
}
