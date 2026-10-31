import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CallFixtureInput } from "@/server/api-v1/schemas";
import { previewCall } from "@/server/usecases/match-day-call";

type Ctx = { params: Promise<{ id: string }> };

/** Match Day: the knock-on of calling the match onto a court, before the organiser confirms (spec 2026-10-31 §7.1). Writes
 *  nothing; refuses with the call's own hard stops. A POST because it is the confirm step's twin, with the same body. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const body = await parseBody(req, CallFixtureInput);
    return previewCall(auth, id, body.court_id);
  });
}
