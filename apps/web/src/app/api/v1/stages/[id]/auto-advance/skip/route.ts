import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AutoAdvanceSkip } from "@/server/api-v1/schemas";
import { skipAutoAction } from "@/server/usecases/auto-advance";

type Ctx = { params: Promise<{ id: string }> };

/** Swiss auto-advance (spec 2026-11-08 §4.2, §4.6): "Skip this time" — the stage's live `pair_round` or `complete_stage`
 *  row is cancelled for its target only, and stays so (a sticky skip). Editors only; the door opens before the body is
 *  read (#376). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const { kind } = await parseBody(req, AutoAdvanceSkip);
    return skipAutoAction(auth, id, kind);
  });
}
