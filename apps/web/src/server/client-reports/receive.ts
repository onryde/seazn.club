import "server-only";
// server/client-reports/receive.ts — the ONE pipeline every client report runs (Task 25b): read the body under its cap, parse it as
// exactly one registered kind (kinds.ts), then, for that kind's facts (define.ts):
//   1. the limit, per kind, subject and client IP (CLIENT_REPORT_LIMIT): past it the report is dropped, nothing logged;
//   2. the subject must exist (for a video report, a fixture that streamed to Seazn): otherwise dropped, nothing logged;
//   3. one `log.warn` per accepted report;
//   4. one Sentry event (level warning) per kind and dedupe key per window (CLIENT_REPORT_SENTRY_WINDOW_SECONDS), counted in Redis so
//      every machine shares the window; later ones in the window are logged only. With no Redis to count in, none is a repeat.
// The route answers 204 for every outcome, so it never says which one a report met (nor whether a fixture exists).
//
// The body is read with `readCapped` and parsed as JSON whatever its Content-Type: `navigator.sendBeacon` sends a string as
// `text/plain`. Nothing read here is logged except the kind's own fields, which are codes.
import * as Sentry from "@sentry/nextjs";
import { incrWindow } from "@/lib/cache";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { CLIENT_REPORT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { readCapped } from "@/server/relay/record-body";
import type { ReportDb } from "./define";
import { ClientReport, clientReportKind } from "./kinds";

/** The largest body read. A video report is under 400 bytes; this leaves room for a kind with a few more codes. */
export const CLIENT_REPORT_MAX_BYTES = 2048;
/** One Sentry event per kind and dedupe key in this many seconds. */
export const CLIENT_REPORT_SENTRY_WINDOW_SECONDS = 600;

const tooLarge = () => new HttpError(413, `a client report is at most ${CLIENT_REPORT_MAX_BYTES} bytes`, "REPORT_TOO_LARGE");

/** The request's report: one registered kind, closed. 413 past the cap (a Content-Length over it is refused before a byte is read),
 *  400 for a body that is not JSON or not a report (the ZodError v1() answers). */
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

/** What became of a report: dropped past the limit, dropped for an unknown subject, logged only (a repeat in the window), or logged
 *  and sent to Sentry. The route answers 204 for all four. */
export type ClientReportOutcome = "capped" | "unknown" | "logged" | "sent";

/** The limit's verdict: false past it (the limiter's 429, caught: the report is dropped, never refused). */
async function withinLimit(key: string): Promise<boolean> {
  try {
    await rateLimit(key, CLIENT_REPORT_LIMIT);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return false;
    throw err;
  }
}

export async function receiveClientReport(report: ClientReport, ip: string, deps: { db?: ReportDb } = {}): Promise<ClientReportOutcome> {
  const facts = clientReportKind(report.kind).facts(report);
  if (!(await withinLimit(`client-report:${report.kind}:${facts.rateSubject}:${ip}`))) return "capped";
  if (!(await facts.subjectExists(deps.db ?? sql))) return "unknown";
  log.warn({ clientReport: report.kind, ...facts.fields }, facts.message);
  const seen = await incrWindow(`client-report-sentry:${report.kind}:${facts.dedupeSubject}`, CLIENT_REPORT_SENTRY_WINDOW_SECONDS);
  if (seen !== null && seen.count > 1) return "logged";
  Sentry.captureMessage(facts.message, { level: "warning", tags: { client_report: report.kind, ...facts.tags }, extra: { ...facts.fields } });
  return "sent";
}
