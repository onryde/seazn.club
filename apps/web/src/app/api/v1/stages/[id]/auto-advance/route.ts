import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { StageAutoAdvancePatch } from "@/server/api-v1/schemas";
import { setStageAutoAdvance } from "@/server/usecases/auto-advance";

type Ctx = { params: Promise<{ id: string }> };

/** Swiss auto-advance (spec 2026-11-08 §4.1): a stage's two switches, `autoPair` (a Swiss stage) and `autoConfirmHandoff`
 *  (a stage whose progression timing is "setup"). Editors only; the door opens before the body is read (#376). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const patch = await parseBody(req, StageAutoAdvancePatch);
    return setStageAutoAdvance(auth, id, patch);
  });
}
