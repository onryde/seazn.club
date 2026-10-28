import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { deleteStage, getStageWithTableRules } from "@/server/usecases/stages";

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
