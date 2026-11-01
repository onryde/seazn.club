import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchSwissStage } from "@/server/api-v1/schemas";
import { deleteStage, getStageWithTableRules } from "@/server/usecases/stages";
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

/** W3 T12 (SW-M10, #838): a Swiss stage's round count and chess colours, until the stage's first start. The door opens
 *  before the body is read (#376). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, PatchSwissStage);
    return patchSwissStage(auth, id, body);
  });
}
