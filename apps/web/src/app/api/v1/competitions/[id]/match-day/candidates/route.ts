import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { Uuid } from "@/server/api-v1/schemas";
import { HttpError } from "@/lib/errors";
import { matchDayCandidates } from "@/server/usecases/match-day";

type Ctx = { params: Promise<{ id: string }> };

/** Match Day (spec 2026-10-31 §7, task A2, ruling R3): the matches that could start on `?court_id=` now, best first.
 *  Authenticates before it reads the query, so a 400 never reveals an auth pass. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const courtId = Uuid.safeParse(new URL(req.url).searchParams.get("court_id"));
    if (!courtId.success) throw new HttpError(400, "court_id must be a court's id");
    return matchDayCandidates(auth, id, courtId.data);
  });
}
