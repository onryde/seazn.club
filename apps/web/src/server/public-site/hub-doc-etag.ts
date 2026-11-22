import "server-only";
// W5 follow-ups B4: the hub document's CONTENT, as a weak ETag. The page polls every 15 s and the document's cache entry
// lives about as long, so the document is rebuilt between most polls even when nothing happened - and every rebuild is
// stamped with a new `generatedAt`. The tag is therefore a hash of everything BUT that stamp: a rebuild that says the same
// thing names the same tag (the poll is answered 304, no body), and any change of what the page shows names a new one.
import { createHash } from "node:crypto";

export function hubDocEtag(doc: { competitionId: string; generatedAt: string }): string {
  // `undefined` is dropped by JSON.stringify: the content, without the build stamp.
  const hash = createHash("sha1").update(JSON.stringify({ ...doc, generatedAt: undefined })).digest("base64url");
  return `W/"hub-${doc.competitionId}-${hash}"`;
}
