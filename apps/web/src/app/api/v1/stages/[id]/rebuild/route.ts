import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { rebuildStageFixtures } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** F3 Task 5 (5b) — replace a root stage's fixtures wholesale (delete + Generate)
 *  rather than the additive-only top-up `/generate` always does. Refuses 409
 *  STAGE_HAS_RESULTS if any fixture already carries a real result, and 422
 *  STAGE_NOT_ROOT for a stage that doesn't draw fixtures directly from the
 *  active roster (see usecases/stages.ts's rebuildStageFixtures doc comment). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return rebuildStageFixtures(auth, id);
  });
}
