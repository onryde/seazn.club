// Seazn-hosted video (Task 25, server beacon since Task 25b): the ONE vocabulary of a viewer's video failure report. The match page's
// reporter (components/public-site/match-centre/seazn-video-report.ts) sends it and the `video` client report
// (server/client-reports/video.ts) takes it, so the two sides read the same lists. Zero imports: the client bundle and the bare OpenAPI
// generator both load it. Every member is a code, never an address or an error's text.

/** Why a player gave up (seazn-playback.ts `PlaybackFailure`): a fatal hls.js error, a browser hls.js cannot run in, an hls.js bundle
 *  that would not load, the element's own error (native HLS), an address with no token to read. */
export const PLAYER_FAILURE_REASONS = ["hls", "unsupported", "bundle", "element", "unsigned"] as const;
export type PlayerFailureReason = (typeof PLAYER_FAILURE_REASONS)[number];

/** Why a read of the video route failed (seazn-video-report.ts `routeFailureOf`): an HTTP status, the network, the loop's give-up timer,
 *  an answer the island refused. */
export const ROUTE_FAILURE_REASONS = ["http", "network", "timeout", "answer"] as const;
export type RouteFailureReason = (typeof ROUTE_FAILURE_REASONS)[number];

/** Which failed: a player, or the island's read of the route. */
export const VIDEO_REPORT_STAGES = ["player", "route"] as const;
/** What the player was playing: the live or a replay part. */
export const VIDEO_REPORT_SOURCES = ["live", "replay"] as const;
/** The player's kind: our HLS `<video>` or the replay host's embed. */
export const VIDEO_REPORT_PLAYERS = ["hls", "embed"] as const;
