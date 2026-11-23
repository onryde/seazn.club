// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the rows a big division's Schedule tab loads on a tap - one folded
// round (`?round=<key>`) or one team's matches across every round (`?entrant=<id>`). Read out of the SAME cached public document
// the page renders from (`getPublicDivision`: public views only, tagged, so `revalidateTag` reaches it), grouped and worded by the
// same builder (`schedule-paging.ts`), and cached at the edge as long as the page is (ISR 30 s), so a loaded round is exactly as
// fresh as the rounds the page shipped.
import { v1, reply } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { getPublicDivision } from "@/server/public-site/data";
import { publicScheduleContext, scheduleRoundsAnswer } from "@/server/public-site/schedule-paging";
import { publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary } from "@/lib/i18n";

type Ctx = { params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, competitionSlug, divisionSlug } = await params;
    const search = new URL(req.url).searchParams;
    const round = search.get("round");
    const entrant = search.get("entrant");
    // Exactly one question per request: a round, or a team.
    if ((round === null) === (entrant === null) || round === "" || entrant === "") {
      throw new HttpError(400, "ask for one round (?round=) or one team (?entrant=)");
    }
    const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
    if (!data) throw new HttpError(404, "division not found");
    const locale = toLocale(data.org.default_locale);
    const ctx = await publicScheduleContext(data, { locale, dict: await getDictionary(locale, "public") });
    const answer = scheduleRoundsAnswer(data, ctx, round !== null ? { round } : { entrant: entrant! });
    if (answer === null) throw new HttpError(404, round !== null ? "round not found" : "team not found");
    return reply(200, answer, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
