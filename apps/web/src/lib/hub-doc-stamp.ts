// W5 follow-ups B4: the hub document carries its build instant twice - `generatedAt`, and every match card's
// `header.updatedAt` (the builder stamps each with the same instant; a LIVE card reads it as "Updated Ns ago"). Those are
// the stamp, not the content: the server's ETag hashes the document without them (`server/public-site/hub-doc-etag.ts`),
// and a poll answered 304 re-stamps the document it holds with the server's current build (`X-Hub-Generated-At`), so the
// freshness line resets exactly as a full answer would have reset it.
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

/** The response header naming the build a 304 confirms. */
export const HUB_BUILD_HEADER = "X-Hub-Generated-At";

/** The document as if built at `at`: `generatedAt` and every card stamped with the old build move to `at`; a card stamped
 *  otherwise keeps its own. The same object when `at` is already its build. */
export function restampHubDoc(doc: CompetitionHubDocT, at: string): CompetitionHubDocT {
  if (at === doc.generatedAt) return doc;
  const was = doc.generatedAt;
  return {
    ...doc,
    generatedAt: at,
    matches: doc.matches.map((m) => (m.header.updatedAt === was ? { ...m, header: { ...m.header, updatedAt: at } } : m)),
  };
}

/** The document without its stamp - what the ETag hashes. */
export function unstampedHubDoc(doc: CompetitionHubDocT): unknown {
  const was = doc.generatedAt;
  return {
    ...doc,
    generatedAt: undefined,
    matches: doc.matches.map((m) => (m.header.updatedAt === was ? { ...m, header: { ...m.header, updatedAt: undefined } } : m)),
  };
}
