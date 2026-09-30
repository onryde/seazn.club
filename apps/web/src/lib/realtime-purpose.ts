// The purpose a caller DECLARES when it asks `/api/v1/public/fixtures/{id}/realtime-token` for a token, and the key
// that has to come with it. One spelling, shared by the stream overlay's client (which sends both) and the route (which
// reads both). RT (lane-close fix, ruled 2026-09-29): a declared purpose is a REQUEST, never an authorisation — the
// route grants the overlay's bypass only when `key` verifies for THIS fixture (server/overlay/overlay-key.ts) and the
// org has `streaming.overlay`. The key reaches the overlay in the OBS URL the organiser's panel copies, under the same
// parameter name.
export const REALTIME_PURPOSE_PARAM = "purpose";
export const OVERLAY_REALTIME_PURPOSE = "overlay";
export type RealtimePurpose = typeof OVERLAY_REALTIME_PURPOSE;
export const OVERLAY_KEY_PARAM = "key";
