import { HttpError } from "@/lib/errors";
import { DEVICE_LINK_MINT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { clientIpOf } from "@/server/api-v1/capture-http";
import { reply, v1 } from "@/server/api-v1/http";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { openMatchForCode } from "@/server/usecases/match-day-code-open";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Open a match through a Match Day code (capture S4 Match Day design §6, §9.4; contract
 * docs/contracts/capture-matchday-open.v1.json): 200 `{kind: "link", url, sport_key}` — the match's own sealed
 * `/score/dl_…` link, re-shown, never a second one beside a live one, nothing revoked — or 200 `{kind: "finished"}` for a
 * finalized or cancelled match. Authenticated by `Authorization: Bearer md_…` ONLY (`matchDayCodeOf`; NEVER_KEY_ROUTES).
 * Refusals: 401 MD_UNKNOWN, 410 MD_WITHDRAWN, 410 MD_ENDED, 403 MD_NOT_OPEN (with `opens_at`), 403 MD_OUT_OF_SCOPE (a
 * match the code does not cover at the moment of asking), 404 NOT_FOUND, 429 RATE_LIMITED. Past the door it spends the
 * console's mint budget (`dlmint:` per client IP, as the capture phone's link does: a re-show IS a mint). The url is a
 * credential: never logged, never cached.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const now = new Date();
    const code = await matchDayCodeOf(req, now);
    await rateLimit(`dlmint:${clientIpOf(req)}`, DEVICE_LINK_MINT_LIMIT);
    const got = await openMatchForCode(code, id, now);
    if (got.kind === "refused") throw new HttpError(403, "this match is not in this Match Day code's scope", got.code);
    return reply(200, got, { "cache-control": "no-store" });
  });
}
