// W5 follow-ups C (owner 2026-11-23, Option A "by round"): one folded round's match cards for the competition hub's Matches tab
// (`?key=`, `hubRoundKey`). Read out of the SAME cached hub document the page and the poll are served from (`publicCompetitionHub`,
// Redis 15 s, deleted on every scoring write), whole - the window is applied only when a document is served (`windowHubDoc`) - so a
// loaded round is exactly as fresh as the rest of the tab; the tab reads it again whenever the polled document changes.
import { v1, reply } from "@/server/api-v1/http";
import { publicCompetitionHub, publicPollRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
import { hubRoundMatches } from "@/lib/hub-round-paging";
import { HttpError } from "@/lib/errors";

type Ctx = { params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    // The poll's bucket: an open folded round is read again on each poll that changes the document.
    await publicPollRateLimit(req);
    const { orgSlug, competitionSlug, divisionSlug } = await params;
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (key === "") throw new HttpError(400, "ask for one round (?key=)");
    const doc = await publicCompetitionHub(orgSlug, competitionSlug);
    const rows = hubRoundMatches(doc, divisionSlug, key);
    if (rows === null) throw new HttpError(404, "round not found");
    return reply(200, rows, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
