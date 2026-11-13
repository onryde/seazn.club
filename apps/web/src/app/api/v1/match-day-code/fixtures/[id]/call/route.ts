import { parseBody, reply, v1 } from "@/server/api-v1/http";
import { matchDayCodeOf } from "@/server/api-v1/match-day-code-door";
import { CaptureMatchdayCallRequest } from "@/server/api-v1/capture-schemas";
import { callForCode, previewCallForCode, undoCallForCode } from "@/server/usecases/match-day-code-call";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Call a match to a court through a Match Day code (Task 8e; contract docs/contracts/capture-matchday-call.v1.json):
 * `{court_id, preview}`. `preview: true` answers the desk's knock-on (`{shifts, warnings}`) and writes nothing;
 * `preview: false` calls the match onto the court now and answers `{fixture_id, court_id, called_at}`, written against the code.
 * Authenticated by `Authorization: Bearer md_…` ONLY (`matchDayCodeOf`; NEVER_KEY_ROUTES), and only for a code minted with
 * "Call matches to courts". Refusals: 401 MD_UNKNOWN, 410 MD_WITHDRAWN, 410 MD_ENDED, 403 MD_NOT_OPEN (with `opens_at`),
 * 403 MD_NO_CALL, 403 MD_OUT_OF_SCOPE (the match or the court), 409 MD_CALL_REFUSED (with `reason`), 404 NOT_FOUND, 422 (a bad
 * body), 429 RATE_LIMITED (the code's call budget). The code is resolved before the body is read. Never cached.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const now = new Date();
    const code = await matchDayCodeOf(req, now, "call");
    const body = await parseBody(req, CaptureMatchdayCallRequest);
    const got = body.preview
      ? await previewCallForCode(code, id, body.court_id, now)
      : await callForCode(code, id, body.court_id, now);
    return reply(200, got, { "cache-control": "no-store" });
  });
}

/**
 * Undo call through a Match Day code: the match goes back to the court and time it had before it was called. Answers
 * `{fixture_id, court_id, scheduled_at}` (nulls: it had none). Only for a code minted with "Call matches to courts", and a match
 * in its scope. Refusals as the call's; 409 MD_CALL_REFUSED `not_called` (not called, or moved since) and `started`.
 */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const code = await matchDayCodeOf(req, new Date(), "call");
    return reply(200, await undoCallForCode(code, id), { "cache-control": "no-store" });
  });
}
