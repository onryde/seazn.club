// Addendum RT (Task 14b fix round 2; owner decision 2026-09-29): the purpose a caller DECLARES when it asks
// `/api/v1/public/fixtures/{id}/realtime-token` for a token. One spelling, shared by the stream overlay's client (which
// sends it) and the route (which reads it). A declared purpose is a REQUEST, never an authorisation: the route grants
// the overlay's bypass only while the fixture is being streamed and the org has `streaming.overlay`.
export const REALTIME_PURPOSE_PARAM = "purpose";
export const OVERLAY_REALTIME_PURPOSE = "overlay";
export type RealtimePurpose = typeof OVERLAY_REALTIME_PURPOSE;
