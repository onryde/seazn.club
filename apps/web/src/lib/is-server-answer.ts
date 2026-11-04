// Did this error come back from the server, or did the request never get there?
//
// Both client wrappers' errors - `ApiError` (lib/client.ts) and `ApiV1Error` (lib/client-v1.ts) - carry the HTTP `status` they
// were thrown for, as a number. The TypeError `fetch` rejects with when the request never leaves (offline, DNS, a dropped
// connection) has none, and neither wrapper catches it. So a server answer is told apart by that SHAPE, never by the
// browser's words ("Failed to fetch" in Chrome, "Load failed" in Safari, "NetworkError when attempting to fetch resource."
// in Firefox), which differ per browser and per language.
//
// Structural on purpose, and import-free: `config-issue-copy.ts` is imported by server code (`configIssuesOf`) and both
// wrappers are `"use client"`, so importing them there would make them client references in the server graph.
export function isServerAnswer(err: unknown): err is Error & { status: number } {
  return err instanceof Error && typeof (err as { status?: unknown }).status === "number";
}
