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
//     -1 = unknown), requireSignedURLs (boolean, default false: "When set to `true`, a signed token must be generated … to
//     view the video" — Seazn Task 13, re-read 2026-11-21 from the same document's list item schema), readyToStream (boolean,
//     an OPTIONAL boolean, "empty" when the video is not ready for viewing or the live stream is still in progress; Seazn Task 39,
//     re-read from the Cloudflare Stream documentation: so the adapter reads an absent key as null, never false).
// Not from the document: the uids and values below are made up; only their NAMES and TYPES are the document's.

/** The two query parameters, as the OpenAPI document names them. */
export const LIST_VIDEOS_QUERY = { liveInputId: "live_input_id", limit: "limit" } as const;
/** The document's declared `limit` maximum (and default). */
export const LIST_VIDEOS_LIMIT_MAX = 1000;

/** A 200 for `?live_input_id=in_abc`: a live recording (the -1/0 placeholders), a finished one, and one whose
 *  `liveInput` is ABSENT — legal under the schema, and the case the sweep's guard must refuse. Task 13: the live one reads
 *  `requireSignedURLs: true` (C7 measured that of an in-progress recording), the finished one `false` (C3), and the third omits
 *  the key (the schema requires nothing). */
export const LIST_VIDEOS_BY_INPUT_200 = {
  success: true,
  errors: [],
  messages: [],
  result: [
    { uid: "v_cam_live", created: "2026-09-01T00:00:00Z", status: { state: "live-inprogress" }, liveInput: "in_abc", requireSignedURLs: true, duration: -1, size: -1, input: { width: 0, height: 0 } },
    { uid: "v_cam_done", created: "2026-09-01T01:00:00Z", status: { state: "ready" }, liveInput: "in_abc", requireSignedURLs: false, readyToStream: true, duration: 30, size: 1000, input: { width: 1280, height: 720 } },
    { uid: "v_cam_unnamed", created: "2026-09-01T02:00:00Z", status: { state: "ready" }, duration: 12, size: 500, input: { width: 1280, height: 720 } },
    // T39: finished uploading but not yet playable (`queued`), the key reading an explicit false.
    { uid: "v_cam_queued", created: "2026-09-01T03:00:00Z", status: { state: "queued" }, liveInput: "in_abc", requireSignedURLs: true, readyToStream: false, duration: -1, size: -1, input: { width: 0, height: 0 } },
  ],
} as const;
