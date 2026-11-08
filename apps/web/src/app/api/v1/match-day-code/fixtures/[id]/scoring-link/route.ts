import { HttpError } from "@/lib/errors";
import { DEVICE_LINK_MINT_LIMIT, rateLimit } from "@/lib/rate-limit";
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
 * match the code does not cover at the moment of asking), 404 NOT_FOUND, 429 RATE_LIMITED. The door spends the code's
 * open budget (`MD_OPEN_LIMIT`, per code); a NEW link minted spends a mint budget on top — the console's number
 * (`DEVICE_LINK_MINT_LIMIT`) keyed on the CODE (`dlmint:md:{code}`), never the client IP a venue's umpires share —
 * inside the open's transaction, so a mint past it is rolled back; a re-shown link spends nothing more (the controller's
 * rulings on the MD-1 final review's I1). The url is a credential: never logged, never cached.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const now = new Date();
    const code = await matchDayCodeOf(req, now, "open");
    const got = await openMatchForCode(code, id, now, { onMint: () => rateLimit(`dlmint:md:${code.id}`, DEVICE_LINK_MINT_LIMIT) });
    if (got.kind === "refused") throw new HttpError(403, "this match is not in this Match Day code's scope", got.code);
    return reply(200, got, { "cache-control": "no-store" });
  });
}
