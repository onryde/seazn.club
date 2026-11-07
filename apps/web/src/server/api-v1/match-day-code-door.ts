import "server-only";
// The md_ routes' own door (capture S4 Match Day design §3, §9; MD-1 Tasks 3–6). A Match Day code is never an AuthCtx at
// the shared door — `rejectDeviceLink` (auth.ts) refuses an md_ bearer on every other v1 route — so each md_ route
// resolves its token here, the way `GET /device-link` resolves a dl_ one.
//
// Metered twice, as the plan's Global Constraints say: per client IP BEFORE the lookup (`publicPollRateLimit`, the bucket
// for what a phone polls on a timer: a flood of guessed tokens costs the prober before any database read), then per code
// AFTER it (`mdv1:<code id>`, 10 a second). The token is never logged and never echoed: a refusal names its word only.
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { publicPollRateLimit } from "@/server/usecases/public";
import { MATCH_DAY_CODE_PREFIX, resolveMatchDayCode, type MatchDayCodeRow, type MatchDayRefusal } from "@/server/usecases/match-day-codes";

/** The plan's refusal table: each resolve refusal, its status and a developer string (the phone keys on the word). */
const REFUSED: Record<MatchDayRefusal, { status: number; message: string }> = {
  MD_UNKNOWN: { status: 401, message: "no such Match Day code" },
  MD_WITHDRAWN: { status: 410, message: "this Match Day code was withdrawn" },
  MD_ENDED: { status: 410, message: "this Match Day code's day is over" },
  MD_NOT_OPEN: { status: 403, message: "this Match Day code's day has not started" },
};

/** `Authorization: Bearer md_…` resolved at `now`, or the refusal as an HttpError the v1 envelope answers
 *  `{error: {code, message}}` (MD_NOT_OPEN also carries `opens_at`). A missing or non-md_ bearer is MD_UNKNOWN. */
export async function matchDayCodeOf(req: Request, now: Date): Promise<MatchDayCodeRow> {
  await publicPollRateLimit(req);
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const got = token.startsWith(MATCH_DAY_CODE_PREFIX)
    ? await resolveMatchDayCode(token, now)
    : ({ ok: false, refusal: "MD_UNKNOWN" } as const);
  if (!got.ok) {
    const { status, message } = REFUSED[got.refusal];
    const extra = got.refusal === "MD_NOT_OPEN" && got.opensAt ? { opens_at: got.opensAt.toISOString() } : undefined;
    throw new HttpError(status, message, got.refusal, extra);
  }
  await rateLimit(`mdv1:${got.code.id}`, { max: 10, windowSeconds: 1 });
  return got.code;
}
