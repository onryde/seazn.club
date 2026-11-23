// Client reports (Seazn-hosted Task 25b, owner 2026-11-23): what a browser tells our server about a failure it saw, through ONE generic
// public beacon route, POST /api/v1/public/client-reports (server/client-reports/). The browser's own Sentry (lib/sentry-browser.ts)
// runs only for a visitor who accepted analytics, loads late, and an ad-blocker can stop it; a beacon to our server reaches the server
// log for EVERY viewer, and the server's Sentry under the server's own dedupe and budgets. Generic, so other kinds (chess) share it.
// Zero imports: the client bundle, the route's schemas and the bare OpenAPI generator all load it.
//
// A report is CODES only. Each string it carries is a member of a closed list, a uuid, or a bare word (`CLIENT_REPORT_CODE`, the way
// hls.js names its error types and details) that names no credential (`CLIENT_REPORT_SECRET_WORD`). A URL, a query, a path, a host and
// an error's text are none of those: the browser never sends one, and the route refuses a body that holds one.

/** The beacon route (a public one: spectators are anonymous). */
export const CLIENT_REPORTS_PATH = "/api/v1/public/client-reports";

/** A code: a bare word (`networkError`, `manifestLoadError`). No `?`, `/`, `:`, `.`, `=`, `&`, `%` or space can be in one. */
export const CLIENT_REPORT_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The names of a signed address's credentials. A code that holds one is refused whatever its shape. */
export const CLIENT_REPORT_SECRET_WORD = /token|expires/i;

/** Whether `v` may ride a report as a code. */
export function isClientReportCode(v: unknown): v is string {
  return typeof v === "string" && CLIENT_REPORT_CODE.test(v) && !CLIENT_REPORT_SECRET_WORD.test(v);
}
