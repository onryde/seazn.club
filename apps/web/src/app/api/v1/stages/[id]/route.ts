import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchStage } from "@/server/api-v1/schemas";
import { deleteStage, getStageWithTableRules, patchKnockoutStage } from "@/server/usecases/stages";
import { patchSwissStage } from "@/server/usecases/swiss-rounds-admin";

type Ctx = { params: Promise<{ id: string }> };

/** One stage with its table rules (W2d: the order, the points, where each came from, the pin, the sport's default). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    return getStageWithTableRules(auth, id);
  });
}

/** Delete a stage — last-in-graph only, refused once fixtures are played. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return deleteStage(auth, id);
  });
}

/** W3 T12 (SW-M10, #838): a Swiss stage's round count and chess colours, until the stage's first start; W4 B4 T9 (X-TP-6): a
 *  knockout stage's third place (`{ thirdPlace }`), until the stage starts. The door opens before the body is read (#376). The
 *  body's shape picks the usecase; each refuses a stage of the other kind by name (STAGE_NOT_SWISS / STAGE_NOT_KNOCKOUT). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, PatchStage);
    return "thirdPlace" in body ? patchKnockoutStage(auth, id, body) : patchSwissStage(auth, id, body);
  });
}
