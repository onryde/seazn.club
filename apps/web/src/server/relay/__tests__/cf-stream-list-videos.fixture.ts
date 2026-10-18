// Cloudflare Stream "List videos" — the shape the R2004 camera-recordings listing reads, pinned from the PROVIDER's own
// declaration, never from the adapter under test (TEST-STRATEGY: expected values come from the source of truth).
//
// SOURCE: Cloudflare API OpenAPI document, `paths["/accounts/{account_id}/stream"].get` (summary "List videos"), read
// 2026-10-18 through the Cloudflare MCP `search` tool over `spec.paths` (all $refs pre-resolved). PR #981 review I2.
//   Query parameters used here, verbatim from the document:
//     live_input_id  string   "Filter by live input ID to find videos associated with a specific live stream."
//     limit          integer  minimum 1, maximum 1000 — "Maximum number of videos to return (default 1000, max 1000)."
//   Response: the v4 envelope (`success`, `errors`, `messages`) with `result`: an array of video objects. The item schema
//   declares NO `required` list, so every field — `liveInput` included — may be absent. Fields this adapter reads:
//     uid (string, maxLength 32), created (date-time string), liveInput (string, maxLength 32, "The live input ID used to
//     upload a video with Stream Live."), status { state (enum incl. "live-inprogress", "ready", "error"),
//     errorReasonCode (string) }, duration (number, -1 = unknown), size (number), input { width, height } (integer,
//     -1 = unknown).
// Not from the document: the uids and values below are made up; only their NAMES and TYPES are the document's.

/** The two query parameters, as the OpenAPI document names them. */
export const LIST_VIDEOS_QUERY = { liveInputId: "live_input_id", limit: "limit" } as const;
/** The document's declared `limit` maximum (and default). */
export const LIST_VIDEOS_LIMIT_MAX = 1000;

/** A 200 for `?live_input_id=in_abc`: a live recording (the -1/0 placeholders), a finished one, and one whose
 *  `liveInput` is ABSENT — legal under the schema, and the case the sweep's guard must refuse. */
export const LIST_VIDEOS_BY_INPUT_200 = {
  success: true,
  errors: [],
  messages: [],
  result: [
    { uid: "v_cam_live", created: "2026-09-01T00:00:00Z", status: { state: "live-inprogress" }, liveInput: "in_abc", duration: -1, size: -1, input: { width: 0, height: 0 } },
    { uid: "v_cam_done", created: "2026-09-01T01:00:00Z", status: { state: "ready" }, liveInput: "in_abc", duration: 30, size: 1000, input: { width: 1280, height: 720 } },
    { uid: "v_cam_unnamed", created: "2026-09-01T02:00:00Z", status: { state: "ready" }, duration: 12, size: 500, input: { width: 1280, height: 720 } },
  ],
} as const;
