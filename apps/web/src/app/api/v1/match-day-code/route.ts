import { reply, v1 } from "@/server/api-v1/http";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { getMatchDayForCode } from "@/server/usecases/match-day-code-view";

/**
 * A Match Day code's day read (capture S4 Match Day design §5, §9.3; contract docs/contracts/capture-matchday-day.v1.json):
 * the courts in the code's scope with their Now / Next / finished matches, the matches with no court (a whole-competition
 * code only) and the approvals waiting. Authenticated by `Authorization: Bearer md_…` ONLY, resolved here
 * (`matchDayCodeOf`): no cookie, never an API key (NEVER_KEY_ROUTES). Refusals: 401 MD_UNKNOWN, 410 MD_WITHDRAWN,
 * 410 MD_ENDED, 403 MD_NOT_OPEN (with `opens_at`), 429 RATE_LIMITED. Read-only, polled every 15 s, never cached.
 */
export async function GET(req: Request) {
  return v1(async () => {
    const now = new Date();
    const code = await matchDayCodeOf(req, now);
    return reply(200, await getMatchDayForCode(code, now), { "cache-control": "no-store" });
  });
}
