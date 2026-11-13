import { reply, v1 } from "@/server/api-v1/http";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { candidatesForCode } from "@/server/usecases/match-day-code-call";

type Ctx = { params: Promise<{ courtId: string }> };

/**
 * The matches that could start on a court now, through a Match Day code (Task 8e; contract
 * docs/contracts/capture-matchday-call.v1.json): the desk's free-court candidates, limited to the code's scope — the court must
 * be in it, and only matches the code's day read could list are offered. Authenticated by `Authorization: Bearer md_…` ONLY
 * (`matchDayCodeOf`; NEVER_KEY_ROUTES). A read: needs no "Call matches to courts". Refusals: 401 MD_UNKNOWN, 410 MD_WITHDRAWN,
 * 410 MD_ENDED, 403 MD_NOT_OPEN (with `opens_at`), 403 MD_OUT_OF_SCOPE (a court outside the code's scope), 404 NOT_FOUND
 * (no such court), 429 RATE_LIMITED (the code's candidates budget). Never cached.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { courtId } = await params;
    const now = new Date();
    const code = await matchDayCodeOf(req, now, "candidates");
    return reply(200, await candidatesForCode(code, courtId, now), { "cache-control": "no-store" });
  });
}
