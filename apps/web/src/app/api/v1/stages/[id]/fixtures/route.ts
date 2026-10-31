import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AddFixture } from "@/server/api-v1/schemas";
import { addFixture } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Ad-hoc single fixture (PROMPT-66): a replay / friendly / manual tie-breaker
 *  added to a running league or group stage. Bracket kinds 422 — a loose
 *  fixture has no slot in the tree; Swiss 422 SWISS_ADHOC_REFUSED (W3 RB3-15:
 *  the system pairs its rounds). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AddFixture);
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return reply(201, await addFixture(auth, id, body));
  });
}
