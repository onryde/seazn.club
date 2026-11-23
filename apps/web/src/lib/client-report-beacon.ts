// The browser's side of the client-report route (Task 25b): how ANY kind's report leaves the page. The match page's video reporter
// (components/public-site/match-centre/seazn-video-report.ts) and the chess camera room's drop watcher (match-room/camera-loader.ts)
// both send through it, so there is one send path to reason about and to test.
//
// A beacon first (it outlives the page's unload and waits for nothing; a string goes as text/plain, which the route reads whatever
// its Content-Type), else a keepalive fetch. Fire and forget: no answer is read, a report that cannot be sent is lost, never retried,
// and never throws into the page. The caller builds a report that the route's own closed schema takes (server/client-reports/);
// nothing here looks inside it.
import { CLIENT_REPORTS_PATH } from "./client-reports";

/** Send one serialised report to `url` (the route's path). */
export function sendClientReport(url: string, body: string): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, body)) return;
  } catch {
    // A beacon the browser refused outright: the fetch below.
  }
  try {
    void fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => undefined);
  } catch {
    // No fetch at all: the report is lost, the page is not.
  }
}

/** Send one report of a registered kind to the route (a body with its `kind`, as JSON). */
export function beaconClientReport(report: { kind: string }): void {
  sendClientReport(CLIENT_REPORTS_PATH, JSON.stringify(report));
}
