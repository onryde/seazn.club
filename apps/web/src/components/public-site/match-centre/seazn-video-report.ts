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
// a code, a number or the fixture's id. The send is the client's existing Sentry path (`Sentry.capture*` with area/event tags, as the
// match room's camera reports), under the client's `beforeSend` scrubber (lib/scrub-score-url.ts) where the client init runs.
import * as Sentry from "@sentry/nextjs";
import { ApiError } from "@/lib/client";
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

export type RouteFailureReason = "http" | "network" | "timeout" | "answer";
export interface VideoFailureReport {
  stage: "player" | "route";
  fixtureId: string;
  source: "live" | "replay" | null;
  partNo: number | null;
  player: "hls" | "embed" | null;
  reason: PlaybackFailure["reason"] | RouteFailureReason;
  hlsType: string | null;
  hlsDetails: string | null;
  httpStatus: number | null;
  mediaCode: number | null;
}

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

/** The client's Sentry path: one warning message, the codes as tags and extras. */
export function sentryVideoReport(report: VideoFailureReport): void {
  const player = report.stage === "player";
  Sentry.captureMessage(player ? "seazn video: the player gave up" : "seazn video: the video route could not be read", {
    level: "warning",
    tags: { area: "seazn-video", event: player ? "player_fatal" : "route_read_failed", reason: report.reason, fixture_id: report.fixtureId },
    extra: { ...report },
  });
}
