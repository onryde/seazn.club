// Seazn-hosted video (Task 25; owner: viewer-side failures visible through Sentry, NOT PostHog): what the match page's video island
// reports when a viewer's player gives up on an address, and when its read of the video route fails.
//
// ONE report per address for a player: a player that gave up is rebuilt with the next answer, and a rebuilt player on the same address
// that fails again says nothing new. ONE per kind of failure for the route (a status, a network failure, a timeout, an answer the island
// refused): the loop retries on a 30 s / 60 s ladder for as long as the page is open, and an outage must not be one report a minute per
// viewer. Both per island (per page view).
//
// A report holds the fixture, the part (null for the live), the player's kind, live or replay, and the failure's CODES (hls.js's type
// and details, the HTTP status, the element's MediaError code). NEVER the address, its token, its `expires`, a query, or an error's
// text (hls.js quotes the URL in its message): the address is a key in this module's memory and goes nowhere else, and every field is
// a code, a number or the fixture's id.
//
// The send (Task 25b, owner 2026-11-23): NOT the browser's own Sentry (the lazy browser facade in lib/: consented visitors only, late, and
// stoppable by an ad-blocker; sending there too would report each failure twice, past the server's dedupe and budgets). A
// report goes to OUR server as a `video` client report (POST /api/v1/public/client-reports, server/client-reports/video.ts), which logs
// it and sends the server's Sentry one warning per fixture and reason per window. A beacon first (it outlives the page's unload and
// waits for nothing), else a keepalive fetch; a report that cannot be sent is lost, never retried, and never throws into the page. The
// body is the report itself with its `kind`: the same field names the route's closed schema takes, so a code the route would refuse is
// never sent (seazn-playback.ts drops it to null first).
import { ApiError } from "@/lib/client";
import { sendClientReport } from "@/lib/client-report-beacon";
import { CLIENT_REPORTS_PATH } from "@/lib/client-reports";
import type { RouteFailureReason } from "@/lib/seazn-video-report-codes";
import type { VideoClientReport } from "@/server/client-reports/video";
import type { PlaybackFailure } from "./seazn-playback";

/** The island refused the route's answer (its shape is not the contract). Named so the route report can tell it from a network one. */
export class BadVideoAnswer extends Error {
  override readonly name = "BadVideoAnswer";
}

/** A player's failure as the island knows it. `address` is the dedupe key alone: it is never part of a report. */
export interface PlayerFatal {
  address: string;
  source: "live" | "replay";
  /** The part's number; null for the live. */
  partNo: number | null;
  player: "hls" | "embed";
  failure: PlaybackFailure;
}

/** One report: the `video` client report's body without its `kind` (the route's own schema is the authority for every field). */
export type VideoFailureReport = Omit<VideoClientReport, "kind">;

/** A failed read's kind and status: an `ApiError`'s status, an abort (the loop's give-up timer), the island's own refusal, or a
 *  network failure. Nothing of a message. */
export function routeFailureOf(err: unknown): { reason: RouteFailureReason; httpStatus: number | null } {
  if (err instanceof ApiError) return { reason: "http", httpStatus: err.status };
  if (err instanceof BadVideoAnswer) return { reason: "answer", httpStatus: null };
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError") return { reason: "timeout", httpStatus: null };
  return { reason: "network", httpStatus: null };
}

export interface VideoReporter {
  player: (fixtureId: string, fatal: PlayerFatal) => void;
  route: (fixtureId: string, err: unknown) => void;
}

export function createVideoReporter(send: (report: VideoFailureReport) => void): VideoReporter {
  const addresses = new Set<string>();
  const routeKinds = new Set<string>();
  return {
    player(fixtureId, { address, source, partNo, player, failure }) {
      if (addresses.has(address)) return;
      addresses.add(address);
      send({
        stage: "player", fixtureId, source, partNo, player,
        reason: failure.reason, hlsType: failure.hlsType, hlsDetails: failure.hlsDetails, httpStatus: failure.httpStatus, mediaCode: failure.mediaCode,
      });
    },
    route(fixtureId, err) {
      const { reason, httpStatus } = routeFailureOf(err);
      const kind = `${reason}:${httpStatus ?? ""}`;
      if (routeKinds.has(kind)) return;
      routeKinds.add(kind);
      send({ stage: "route", fixtureId, source: null, partNo: null, player: null, reason, hlsType: null, hlsDetails: null, httpStatus, mediaCode: null });
    },
  };
}

/** The request a report is sent as: the beacon route, and the report with its `kind`, as JSON. */
export function videoReportRequest(report: VideoFailureReport): { url: string; body: string } {
  const body: VideoClientReport = { kind: "video", ...report };
  return { url: CLIENT_REPORTS_PATH, body: JSON.stringify(body) };
}

/** The send: the shared client-report beacon (lib/client-report-beacon.ts: `navigator.sendBeacon`, else a keepalive `fetch`; fire and
 *  forget). */
export function beaconVideoReport(report: VideoFailureReport): void {
  const { url, body } = videoReportRequest(report);
  sendClientReport(url, body);
}
