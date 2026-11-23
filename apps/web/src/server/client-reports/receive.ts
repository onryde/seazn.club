import "server-only";
// server/client-reports/receive.ts — the ONE pipeline every client report runs (Task 25b): read the body under its cap, parse it as
// exactly one registered kind (kinds.ts), then, for that kind's facts (define.ts):
//   1. the client IP's bucket across every kind and subject (CLIENT_REPORT_IP_LIMIT), then the bucket per kind, subject and IP
//      (CLIENT_REPORT_LIMIT): past either the report is dropped, nothing logged. Both before the database is asked anything;
//   2. the subject must exist (for a video report, a fixture that streamed to Seazn): otherwise dropped, nothing logged;
//   3. the kind's Sentry budget (its `sentryBudget`, CLIENT_REPORT_SENTRY_BUDGET by default), across every client: past it the report
//      is written to stdout ONLY (`unforwardedLine`), so it reaches neither a Sentry event nor Sentry Logs;
//   4. one `log.warn` per report within the budget (pino: stdout, and Sentry Logs through Sentry.pinoIntegration);
//   5. one Sentry event (level warning) per kind and dedupe key per window (CLIENT_REPORT_SENTRY_WINDOW_SECONDS), counted in Redis so
//      every machine shares the window; later ones in the window are logged only.
// The counters live in Redis. With NO Redis configured (a dev box, e2e) neither the limits nor the counts run, and every report is
// logged and sent: the house fallback. With Redis configured and NOT answering (an outage: `incrWindow` null), a report is written to
// stdout only (review m1): an outage must not make every report from anyone a Sentry event.
// The route answers 204 for every outcome, so it never says which one a report met (nor whether a fixture exists).
//
// The body is read with `readCapped` and parsed as JSON whatever its Content-Type: `navigator.sendBeacon` sends a string as
// `text/plain`. Nothing read here is logged except the kind's own fields, which are codes.
import * as Sentry from "@sentry/nextjs";
import { cacheEnabled, incrWindow } from "@/lib/cache";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { CLIENT_REPORT_IP_LIMIT, CLIENT_REPORT_LIMIT, rateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { readCapped } from "@/server/relay/record-body";
import { getRequestContext } from "@/server/request-context";
import type { ReportDb } from "./define";
import { ClientReport, clientReportKind } from "./kinds";

/** The largest body read. A video report is under 400 bytes; this leaves room for a kind with a few more codes. */
export const CLIENT_REPORT_MAX_BYTES = 2048;
/** One Sentry event per kind and dedupe key in this many seconds. */
export const CLIENT_REPORT_SENTRY_WINDOW_SECONDS = 600;

const tooLarge = () => new HttpError(413, `a client report is at most ${CLIENT_REPORT_MAX_BYTES} bytes`, "REPORT_TOO_LARGE");

/** The request's report: one registered kind, closed. 413 past the cap: a Content-Length over it is refused before THIS handler reads
 *  a byte. (Not before a byte is received: proxy.ts runs on this path, and while it does Next buffers the whole body, up to
 *  `proxyClientMaxBodySize`, 10 MB, before any handler runs. Kept on purpose: proxy's Origin check is what stops a third-party page
 *  making its visitors beacon here; review m2.) 400 for a body that is not JSON or not a report (the ZodError v1() answers). */
export async function readClientReport(req: Request): Promise<ClientReport> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > CLIENT_REPORT_MAX_BYTES) throw tooLarge();
  let raw: Buffer | null;
  try {
    raw = await readCapped(req.body, CLIENT_REPORT_MAX_BYTES);
  } catch {
    throw new HttpError(400, "the report could not be read to its end", "REPORT_UNREADABLE");
  }
  if (raw === null) throw tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  return ClientReport.parse(body);
}

/** What became of a report: dropped past a limit, dropped for an unknown subject, written to stdout only (past the kind's Sentry
 *  budget, or with Redis configured and giving no count), logged only (a repeat in the window), or logged and sent to Sentry. The
 *  route answers 204 for all six. */
export type ClientReportOutcome = "capped" | "unknown" | "over-budget" | "uncounted" | "logged" | "sent";

/** A limit's verdict: false past it (the limiter's 429, caught: the report is dropped, never refused). */
async function withinLimit(key: string, cfg: RateLimitConfig): Promise<boolean> {
  try {
    await rateLimit(key, cfg);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return false;
    throw err;
  }
}

/** A warn line Sentry never sees: the app's JSON line (pino's level, time and name, the request context), written to stdout DIRECTLY.
 *  Not through pino: Sentry.pinoIntegration() forwards every pino instance's every level to Sentry Logs (sentry.server.config.ts), and
 *  its per-logger opt-out keys on a module-private symbol, so a line kept out of Sentry is one pino never writes. Its fields are the
 *  kind's codes, the only thing a report's line ever holds. */
function unforwardedLine(fields: Record<string, unknown>, message: string): void {
  process.stdout.write(`${JSON.stringify({ level: 40, time: Date.now(), name: "web", ...getRequestContext(), ...fields, msg: message })}\n`);
}

export async function receiveClientReport(report: ClientReport, ip: string, deps: { db?: ReportDb } = {}): Promise<ClientReportOutcome> {
  const kind = clientReportKind(report.kind);
  const facts = kind.facts(report);
  if (!(await withinLimit(`client-report:${ip}`, CLIENT_REPORT_IP_LIMIT))) return "capped";
  if (!(await withinLimit(`client-report:${report.kind}:${facts.rateSubject}:${ip}`, CLIENT_REPORT_LIMIT))) return "capped";
  if (!(await facts.subjectExists(deps.db ?? sql))) return "unknown";
  const line = { clientReport: report.kind, ...facts.fields };
  const counted = cacheEnabled();
  const spent = await incrWindow(`client-report-sentry-budget:${report.kind}`, kind.sentryBudget.windowSeconds);
  if (counted && spent === null) {
    unforwardedLine({ ...line, clientReportSentry: "uncounted" }, facts.message);
    return "uncounted";
  }
  if (spent !== null && spent.count > kind.sentryBudget.max) {
    unforwardedLine({ ...line, clientReportSentry: "over-budget" }, facts.message);
    return "over-budget";
  }
  const seen = await incrWindow(`client-report-sentry:${report.kind}:${facts.dedupeSubject}`, CLIENT_REPORT_SENTRY_WINDOW_SECONDS);
  if (counted && seen === null) {
    unforwardedLine({ ...line, clientReportSentry: "uncounted" }, facts.message);
    return "uncounted";
  }
  log.warn(line, facts.message);
  if (seen !== null && seen.count > 1) return "logged";
  Sentry.captureMessage(facts.message, { level: "warning", tags: { client_report: report.kind, ...facts.tags }, extra: { ...facts.fields } });
  return "sent";
}
