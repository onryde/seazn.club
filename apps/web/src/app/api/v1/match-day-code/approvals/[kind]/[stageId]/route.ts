import { HttpError } from "@/lib/errors";
import { parseBody, reply, v1 } from "@/server/api-v1/http";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { CaptureMatchdayApprovalRequest } from "@/server/api-v1/schemas";
import { APPROVAL_KINDS, approveForCode, reviewApprovalForCode, type ApprovalKind } from "@/server/usecases/match-day-code-approvals";

type Ctx = { params: Promise<{ kind: string; stageId: string }> };

/** `swiss` or `draw`; any other kind is no such route (404). */
function kindOf(kind: string): ApprovalKind {
  const found = APPROVAL_KINDS.find((k) => k === kind);
  if (found === undefined) throw new HttpError(404, "no such approval kind");
  return found;
}

/**
 * Review an approval through a Match Day code (capture S4 Match Day design §7, §9.5; contract
 * docs/contracts/capture-matchday-approval.v1.json): the next Swiss round's pairings or a knockout's draw, as the server
 * computed them, with the `hash` the approve hands back. Authenticated by `Authorization: Bearer md_…` ONLY
 * (`matchDayCodeOf`; NEVER_KEY_ROUTES), and only for a code that can approve. Not a pure read: a draw with no live draft
 * computes one, and a Swiss preview commits its round's lots draw. Refusals: 401 MD_UNKNOWN, 410 MD_WITHDRAWN,
 * 410 MD_ENDED, 403 MD_NOT_OPEN (with `opens_at`), 403 MD_NO_APPROVE, 403 MD_OUT_OF_SCOPE, 409 MD_STALE (not ready),
 * 409 MD_ALREADY, 404 NOT_FOUND, 429 RATE_LIMITED (the code's review budget, one a second: the costliest md_ call).
 * Never cached.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { kind, stageId } = await params;
    const code = await matchDayCodeOf(req, new Date(), "review");
    return reply(200, await reviewApprovalForCode(code, kindOf(kind), stageId), { "cache-control": "no-store" });
  });
}

/**
 * Approve what the review showed, through a Match Day code: `{hash}` (and `round` for a Swiss round). 200 `{ok: true}`;
 * a second phone's approve is 409 MD_ALREADY, a proposal that moved 409 MD_STALE, a draw with a tie 409 MD_TIES. The
 * other refusals are the review's. One use row per approve, against the code.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { kind, stageId } = await params;
    const code = await matchDayCodeOf(req, new Date(), "approve");
    const approval = kindOf(kind);
    const input = await parseBody(req, CaptureMatchdayApprovalRequest);
    return reply(200, await approveForCode(code, approval, stageId, input), { "cache-control": "no-store" });
  });
}
