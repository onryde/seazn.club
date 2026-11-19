import { v1 } from "@/server/api-v1/http";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { cascadeAuthFor } from "@/server/usecases/withdrawal";
import { previewWithdrawal } from "@/server/usecases/withdrawal-preview";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

/** W5 T8b (X-WDT-10, ruling 289): what a disqualification recorded IN this match would do to `entrant` — the pad's sanction
 *  ending reads it before its Confirm. Any actor who may score this fixture (an organiser, an official, its device link); the
 *  entrant must sit on it (404 otherwise). The match itself counts as played. Read-only. The reads run under the org's
 *  server authority once the door has admitted the actor, as the cascade they preview does (a device link may read only its
 *  own fixture, and the preview names her other lines). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireFixtureActor(req, id, "score");
    const entrant = new URL(req.url).searchParams.get("entrant");
    if (entrant === null || entrant === "") throw new HttpError(422, "entrant is required");
    if (!UUID_RE.test(entrant)) throw new HttpError(404, "entrant is not on this fixture");
    return previewWithdrawal(cascadeAuthFor(auth.orgId, auth.userId), entrant, "disqualified", { fixtureId: id });
  });
}
