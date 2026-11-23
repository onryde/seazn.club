// server/client-reports — a browser's failure reports, through ONE public beacon route (POST /api/v1/public/client-reports; Task 25b).
//   define.ts   what a kind is (its closed schema and the facts the pipeline reads), and `ReportCode`. Pure.
//   kinds.ts    the registry of kinds and the route's body (`ClientReport`, a union on `kind`). Pure: OpenAPI loads it.
//   video.ts    the `video` kind: the match page's player gave up, or its read of the video route failed. Pure.
//   receive.ts  the pipeline: the capped read, the per-IP and per-subject limits, the subject check, the kind's Sentry budget, the log
//               line and the windowed Sentry event. server-only.
export { readClientReport, receiveClientReport, CLIENT_REPORT_MAX_BYTES, CLIENT_REPORT_SENTRY_WINDOW_SECONDS, type ClientReportOutcome } from "./receive";
export { ClientReport, CLIENT_REPORT_KINDS } from "./kinds";
