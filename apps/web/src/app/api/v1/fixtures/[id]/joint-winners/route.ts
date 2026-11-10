import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { declareJointWinners, undoJointWinners } from "@/server/usecases/joint-winners";

type Ctx = { params: Promise<{ id: string }> };

/** W4 T12 (X-CH-4, X-CH-6): "Declare joint winners" on an unplayed final - both finalists rank 1st. The fixture's write door
 *  (the organiser's: an owner or admin, or a `manage`-scoped key). No body. 422 JOINT_WINNERS_NOT_A_FINAL, 409
 *  JOINT_WINNERS_FINAL_DECIDED (usecases/joint-winners.ts). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return declareJointWinners(auth, id);
  });
}

/** Undo the declaration: the final returns to the status and outcome it held. 409 JOINT_WINNERS_NOT_DECLARED when there is
 *  none to undo; 409 VACANT_TITLE_ALREADY_SEEDED when the stage it completed has seeded another. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return undoJointWinners(auth, id);
  });
}
