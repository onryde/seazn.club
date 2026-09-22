import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PublishCompetitionScheduleRequest } from "@/server/api-v1/schemas";
import { publishCompetitionSchedule } from "@/server/usecases/competition-schedule-publish";

type Ctx = { params: Promise<{ id: string }> };

/** POST /competitions/{id}/schedule/publish — publish every division of the
 *  competition whose schedule is still unreleased (`status = 'setup'`).
 *
 *  The competition-wide twin of /divisions/{id}/publish-schedule, and a loop
 *  over that exact usecase: the gate (`validateScheduleIn` + `assertPublishable`)
 *  keeps one authority and one pair of refusal codes.
 *
 *  BEST EFFORT, unlike the joint APPLY next door, which is one transaction or
 *  none. Publishing a division touches nothing another division shares, so a
 *  board the gate refuses must not withhold the timetables of the divisions
 *  that are clean — the result is a per-division report and the refusals carry
 *  their conflicts. ONE `acknowledge_warnings` covers the whole competition.
 *
 *  A THIN ADAPTER: the division selection, the classification and the 404 all
 *  live in `publishCompetitionSchedule`.
 *
 *  AUTHENTICATE FIRST, THEN PARSE (#376), matching the per-division route it
 *  mirrors: a caller with no write permission must learn that from the auth
 *  door and from nothing else. The body is OPTIONAL — an absent one parses as
 *  `{}`, which is the no-acknowledgement publish. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    const body = PublishCompetitionScheduleRequest.parse(await req.json().catch(() => ({})));
    return publishCompetitionSchedule(auth, id, body);
  });
}
