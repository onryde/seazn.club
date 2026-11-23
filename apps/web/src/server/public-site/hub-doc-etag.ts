import "server-only";
// W5 follow-ups B4: the hub document's CONTENT, as a weak ETag. The page polls every 15 s and the document's cache entry
// lives about as long, so the document is rebuilt between most polls even when nothing happened - and every rebuild is
// stamped with its build instant (`generatedAt`, and each match card's `header.updatedAt`). The tag hashes the document
// without that stamp (`unstampedHubDoc`): a rebuild that says the same thing names the same tag (the poll is answered 304,
// no body), and any change of what the page shows names a new one.
import { createHash } from "node:crypto";
import { unstampedHubDoc } from "@/lib/hub-doc-stamp";
import type { CompetitionHubDocT } from "./competition-hub-schema";

export function hubDocEtag(doc: CompetitionHubDocT): string {
  const hash = createHash("sha1").update(JSON.stringify(unstampedHubDoc(doc))).digest("base64url");
  return `W/"hub-${doc.competitionId}-${hash}"`;
}
