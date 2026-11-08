import "server-only";
// The md_ routes' own door (capture S4 Match Day design §3, §9; MD-1 Tasks 3–6). A Match Day code is never an AuthCtx at
// the shared door — `rejectDeviceLink` (auth.ts) refuses an md_ bearer on every other v1 route — so each md_ route
// resolves its token here, the way `GET /device-link` resolves a dl_ one.
//
// Metered per CODE, never per client IP (the controller's ruling on the MD-1 final review's I1, amending the plan's
// Global Constraint: umpires share venue Wi-Fi and carrier NAT), after capture-http.ts's credential-keyed pattern:
//  - a code that resolves spends its route's own per-code bucket (`MdBudget`; rate-limit.ts `MD_*_LIMIT`);
//  - a lookup that FAILS (an unknown, withdrawn or ended token) spends the client IP's failed-lookup budget
//    (`MD_FAIL_LIMIT`), and a failure past it answers 429 instead of its refusal: a guessing client is throttled, a
//    valid code is never refused for its neighbours' traffic. MD_NOT_OPEN is a real code, early: not a failed lookup.
// The token is never logged and never echoed: a refusal names its word only.
import { HttpError } from "@/lib/errors";
import {
  MD_APPROVE_LIMIT,
  MD_DAY_LIMIT,
  MD_FAIL_LIMIT,
  MD_OPEN_LIMIT,
  MD_REVIEW_LIMIT,
  rateLimit,
  type RateLimitConfig,
} from "@/lib/rate-limit";
import { clientIpOf } from "@/server/api-v1/capture-http";
import { MATCH_DAY_CODE_PREFIX, resolveMatchDayCode, type MatchDayCodeRow, type MatchDayRefusal } from "@/server/usecases/match-day-codes";

/** The plan's refusal table: each resolve refusal, its status and a developer string (the phone keys on the word). */
const REFUSED: Record<MatchDayRefusal, { status: number; message: string }> = {
  MD_UNKNOWN: { status: 401, message: "no such Match Day code" },
  MD_WITHDRAWN: { status: 410, message: "this Match Day code was withdrawn" },
  MD_ENDED: { status: 410, message: "this Match Day code's day is over" },
  MD_NOT_OPEN: { status: 403, message: "this Match Day code's day has not started" },
};

/** The lookups a guessing client fails: no such code, or one that no longer opens. */
const FAILED_LOOKUP: ReadonlySet<MatchDayRefusal> = new Set(["MD_UNKNOWN", "MD_WITHDRAWN", "MD_ENDED"]);

/** Which per-code bucket a route spends: the day read, an approval's review or approve, or an open. */
export type MdBudget = "day" | "review" | "approve" | "open";

const BUDGET: Record<MdBudget, RateLimitConfig> = {
  day: MD_DAY_LIMIT,
  review: MD_REVIEW_LIMIT,
  approve: MD_APPROVE_LIMIT,
  open: MD_OPEN_LIMIT,
};

/** `Authorization: Bearer md_…` resolved at `now`, or the refusal as an HttpError the v1 envelope answers
 *  `{error: {code, message}}` (MD_NOT_OPEN also carries `opens_at`). A missing or non-md_ bearer is MD_UNKNOWN. The
 *  resolved code spends `budget`'s bucket; a failed lookup the client IP's. */
export async function matchDayCodeOf(req: Request, now: Date, budget: MdBudget): Promise<MatchDayCodeRow> {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const got = token.startsWith(MATCH_DAY_CODE_PREFIX)
    ? await resolveMatchDayCode(token, now)
    : ({ ok: false, refusal: "MD_UNKNOWN" } as const);
  if (!got.ok) {
    if (FAILED_LOOKUP.has(got.refusal)) await rateLimit(`mdfail:${clientIpOf(req)}`, MD_FAIL_LIMIT);
    const { status, message } = REFUSED[got.refusal];
    const extra = got.refusal === "MD_NOT_OPEN" && got.opensAt ? { opens_at: got.opensAt.toISOString() } : undefined;
    throw new HttpError(status, message, got.refusal, extra);
  }
  await rateLimit(`md${budget}:${got.code.id}`, BUDGET[budget]);
  return got.code;
}
