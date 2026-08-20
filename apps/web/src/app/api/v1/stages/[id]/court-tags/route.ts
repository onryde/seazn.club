import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseBody, v1 } from "@/server/api-v1/http";
import { PutStageCourtTags } from "@/server/api-v1/schemas";
import { getStageCourtTags, putStageCourtTags } from "@/server/usecases/stage-court-tags";

type Ctx = { params: Promise<{ id: string }> };

/** #622 — a stage's required court tags, stage-wide and per round role. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    return getStageCourtTags(auth, id);
  });
}

/** Replace them. `rounds` is a whole-list replace (an omitted round is
 *  deleted); omitting the key entirely leaves the round rules untouched. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, PutStageCourtTags);
    return putStageCourtTags(auth, id, body);
  });
}
