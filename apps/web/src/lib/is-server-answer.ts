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

// Did the request never leave? Narrower than "not a server answer": that also covers every bare `Error` a component throws on
// purpose (the logo upload's "bad image", a conversion failure), and telling the organiser "couldn't reach Seazn" about those
// is a lie. What `fetch` rejects with when the request never goes out is a `TypeError` - Chrome "Failed to fetch", Safari
// "Load failed", Firefox "NetworkError when attempting to fetch resource." - and, like all three, it carries no `status`. A
// `TypeError` that does carry one came back from somewhere, so it is not this. Never decided by the browser's words.
export function isUnreachable(err: unknown): err is TypeError {
  return err instanceof TypeError && !isServerAnswer(err);
}
