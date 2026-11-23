// server/client-reports/video.ts — the `video` client report (Seazn-hosted Task 25b): the match page's player gave up on an address, or
// the island's read of the video route failed (components/public-site/match-centre/seazn-video-report.ts sends it, once per address
// for a player and once per kind of failure for the route, per page view).
//
// The body is the reporter's own `VideoFailureReport` with `kind: "video"`, field for field (`player` and `source` keep the names the
// video read's answer and the reporter use). Closed: an unknown key is a 400, and every string is a member of a list
// (lib/seazn-video-report-codes.ts), the fixture's uuid, or a `ReportCode`. Never an address, a token, an `expires` or a query.
//
// A report counts only for a fixture that streamed to Seazn: one with a session whose destination is `seazn` (a Seazn replay is always a
// recording of such a session, V542's `session_id`, so the session alone answers). Any other id is dropped without a word, so the
// route's answer never says whether a fixture exists. Limited per fixture and IP; one Sentry event per fixture and reason per window.
import { z } from "zod";
import {
  PLAYER_FAILURE_REASONS, ROUTE_FAILURE_REASONS, VIDEO_REPORT_PLAYERS, VIDEO_REPORT_SOURCES, VIDEO_REPORT_STAGES,
} from "../../lib/seazn-video-report-codes.ts";
import { ReportCode, defineClientReportKind } from "./define.ts";

export const VideoClientReport = z.strictObject({
  kind: z.literal("video"),
  fixtureId: z.uuid(),
  stage: z.enum(VIDEO_REPORT_STAGES),
  /** Live or replay; null for a read of the route. */
  source: z.enum(VIDEO_REPORT_SOURCES).nullable(),
  /** The replay part's number; null for the live and for the route. */
  partNo: z.number().int().min(1).max(9999).nullable(),
  /** The player's kind; null for the route. */
  player: z.enum(VIDEO_REPORT_PLAYERS).nullable(),
  reason: z.enum([...PLAYER_FAILURE_REASONS, ...ROUTE_FAILURE_REASONS]),
  /** hls.js's error type and details, for an hls.js error. */
  hlsType: ReportCode.nullable(),
  hlsDetails: ReportCode.nullable(),
  /** The HTTP status the player or the read got. */
  httpStatus: z.number().int().min(100).max(599).nullable(),
  /** The element's MediaError code. */
  mediaCode: z.number().int().min(1).max(4).nullable(),
});
export type VideoClientReport = z.infer<typeof VideoClientReport>;

export const videoClientReport = defineClientReportKind(VideoClientReport, (r) => {
  const player = r.stage === "player";
  return {
    rateSubject: r.fixtureId,
    dedupeSubject: `${r.fixtureId}:${r.reason}`,
    subjectExists: async (db) => {
      const [row] = await db<{ seazn: boolean }[]>`
        select exists (select 1 from fixture_stream_sessions where fixture_id = ${r.fixtureId} and destination_kind = 'seazn') as seazn`;
      return row?.seazn === true;
    },
    message: player ? "seazn video: the player gave up" : "seazn video: the video route could not be read",
    tags: { area: "seazn-video", event: player ? "player_fatal" : "route_read_failed", reason: r.reason, fixture_id: r.fixtureId },
    fields: {
      fixtureId: r.fixtureId, stage: r.stage, source: r.source, partNo: r.partNo, player: r.player, reason: r.reason,
      hlsType: r.hlsType, hlsDetails: r.hlsDetails, httpStatus: r.httpStatus, mediaCode: r.mediaCode,
    },
  };
});
