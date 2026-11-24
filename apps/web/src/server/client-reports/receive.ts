import "server-only";
// server/client-reports/receive.ts — the ONE pipeline every client report runs (Task 25b): read the body under its cap, parse it as
// exactly one registered kind (kinds.ts), then, for that kind's facts (define.ts):
//   1. the client IP's bucket across every kind and subject (CLIENT_REPORT_IP_LIMIT), then the bucket per kind, subject and IP
//      (CLIENT_REPORT_LIMIT): past either the report is dropped, nothing logged. Both before the database is asked anything;
//   2. the subject must exist (for a video report, a fixture that streamed to Seazn): otherwise dropped, nothing logged;
//   3. only the FIRST report of its kind and dedupe key per window (CLIENT_REPORT_SENTRY_WINDOW_SECONDS) may reach Sentry; a repeat
//      is a server-log line only (`unforwardedLine`) and spends nothing (review N1), so one fixture's viewers cannot crowd another
//      fixture's first report out;
//   4. the client IP's Sentry share across every kind (CLIENT_REPORT_IP_SENTRY_SHARE): past it, a server-log line only, so one IP
//      cannot spend the kinds' budgets;
//   5. the kind's Sentry budget across every client (its `sentryBudget`, CLIENT_REPORT_SENTRY_BUDGET by default): past it, a
//      server-log line only;
//   A first report the share or the budget refuses GIVES BACK its dedupe slot (review I2): otherwise every other client's report of
//   that failure would be a repeat for the window, and one IP over its share could silence a failure for everyone;
//   6. then, and only then, ONE `log.warn` (pino: stdout, and Sentry Logs through Sentry.pinoIntegration) and ONE Sentry event (level
//      warning). So the budget and the share bound Sentry's events AND its Logs exactly.
// Every counter lives in Redis, shared by every machine. With NO Redis configured (a dev box, e2e) none of them runs, and every
// report is logged and sent: the house fallback. With Redis configured and NOT answering (an outage: `incrWindow` null), a report is
// a server-log line only (review m1): an outage must not make every report from anyone a Sentry event.
// The route answers 204 for every outcome, so it never says which one a report met (nor whether a fixture exists).
//
// The body is read with `readCapped` and parsed as JSON whatever its Content-Type: `navigator.sendBeacon` sends a string as
// `text/plain`. Nothing read here is logged except the kind's own fields, which are codes.
import * as Sentry from "@sentry/nextjs";
import pino from "pino";
import { cacheDel, cacheEnabled, incrWindow } from "@/lib/cache";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { limiterSubject } from "@/lib/client-ip";
import { CLIENT_REPORT_IP_LIMIT, CLIENT_REPORT_LIMIT, rateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { readCapped } from "@/server/relay/record-body";
import { getRequestContext } from "@/server/request-context";
import type { ReportDb, SentryBudget } from "./define";
import { ClientReport, clientReportKind } from "./kinds";

/** The largest body read. A video report is under 400 bytes; this leaves room for a kind with a few more codes. */
export const CLIENT_REPORT_MAX_BYTES = 2048;
/** One Sentry event per kind and dedupe key in this many seconds. */
export const CLIENT_REPORT_SENTRY_WINDOW_SECONDS = 600;
/** One client IP's share of Sentry, across every kind (review N1): at most 5 first reports an hour reach Sentry from one IP, a twelfth
 *  of a kind's default hourly budget, so no single client can spend it. A venue behind one NAT whose viewers all see the same failure
 *  sends ONE first report per fixture and reason; the rest are repeats, which spend no share. */
export const CLIENT_REPORT_IP_SENTRY_SHARE: SentryBudget = { max: 5, windowSeconds: 3600 };

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

/** What became of a report: dropped past a limit, dropped for an unknown subject, a server-log line only (with Redis configured and
 *  giving no count; a repeat in the window, `logged`; past the IP's Sentry share; past the kind's Sentry budget), or logged and sent
 *  to Sentry. The route answers 204 for all seven. */
export type ClientReportOutcome = "capped" | "unknown" | "uncounted" | "logged" | "over-share" | "over-budget" | "sent";

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

type PinoInternals = Record<symbol, unknown>;

/** A warn line Sentry never sees, in the app logger's own line shape (its level and time, its base `pid`/`hostname`/`name` bindings,
 *  the request context), written into the logger's OWN destination stream: one writer on fd 1, one buffer, one order (review N2).
 *  Not through pino's serialiser: Sentry.pinoIntegration() listens on that serialiser's tracing channel (`pino_asJson`) and forwards
 *  every pino line at every level to Sentry Logs (sentry.server.config.ts); its per-logger opt-out keys on a module-private symbol.
 *  The fields are the kind's codes, the only thing a report's line ever holds, so pino's redaction has nothing to act on. Written only
 *  at a level the logger writes (LOG_LEVEL), as pino's own warn would be (review m-r2b). */
function unforwardedLine(fields: Record<string, unknown>, message: string): void {
  if (!log.isLevelEnabled("warn")) return;
  const internals = log as unknown as PinoInternals;
  const destination = internals[pino.symbols.streamSym] as { write: (chunk: string) => unknown };
  const bindings = (internals[pino.symbols.chindingsSym] as string | undefined) ?? "";
  const rest = JSON.stringify({ ...getRequestContext(), ...fields, msg: message }).slice(1);
  destination.write(`{"level":${log.levels.values.warn},"time":${Date.now()}${bindings},${rest}\n`);
}

export async function receiveClientReport(report: ClientReport, ip: string, deps: { db?: ReportDb } = {}): Promise<ClientReportOutcome> {
  const kind = clientReportKind(report.kind);
  const facts = kind.facts(report);
  // Every limiter and share key takes the client's SUBJECT, not its raw address: an IPv6 /64 is one client (Task 25c).
  const client = limiterSubject(ip);
  if (!(await withinLimit(`client-report:${client}`, CLIENT_REPORT_IP_LIMIT))) return "capped";
  if (!(await withinLimit(`client-report:${report.kind}:${facts.rateSubject}:${client}`, CLIENT_REPORT_LIMIT))) return "capped";
  if (!(await facts.subjectExists(deps.db ?? sql))) return "unknown";
  const line = { clientReport: report.kind, ...facts.fields };
  const counted = cacheEnabled();
  const serverLogOnly = <O extends ClientReportOutcome>(outcome: O, why: string): O => {
    unforwardedLine({ ...line, clientReportSentry: why }, facts.message);
    return outcome;
  };
  const dedupeKey = `client-report-sentry:${report.kind}:${facts.dedupeSubject}`;
  const seen = await incrWindow(dedupeKey, CLIENT_REPORT_SENTRY_WINDOW_SECONDS);
  if (counted && seen === null) return serverLogOnly("uncounted", "uncounted");
  if (seen !== null && seen.count > 1) return serverLogOnly("logged", "repeat");
  /** A first report refused below gives its dedupe slot back (review I2), so the next report of this failure, from anyone, is first. */
  const refused = async <O extends ClientReportOutcome>(outcome: O): Promise<O> => {
    if (seen !== null && seen.count === 1) await cacheDel(dedupeKey);
    return serverLogOnly(outcome, outcome);
  };
  const share = await incrWindow(`client-report-sentry-ip:${client}`, CLIENT_REPORT_IP_SENTRY_SHARE.windowSeconds);
  if (counted && share === null) return serverLogOnly("uncounted", "uncounted");
  if (share !== null && share.count > CLIENT_REPORT_IP_SENTRY_SHARE.max) return refused("over-share");
  const spent = await incrWindow(`client-report-sentry-budget:${report.kind}`, kind.sentryBudget.windowSeconds);
  if (counted && spent === null) return serverLogOnly("uncounted", "uncounted");
  if (spent !== null && spent.count > kind.sentryBudget.max) return refused("over-budget");
  log.warn(line, facts.message);
  Sentry.captureMessage(facts.message, { level: "warning", tags: { client_report: report.kind, ...facts.tags }, extra: { ...facts.fields } });
  return "sent";
}
