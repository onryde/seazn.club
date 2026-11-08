import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { listDivisionAutoActions } from "@/server/usecases/auto-advance";

type Ctx = { params: Promise<{ id: string }> };

/** Swiss auto-advance (spec 2026-11-08 §4.6): the division's auto actions, every live row and each done row for 10 minutes
 *  after it was done, newest first. What the fixtures tab's banner reads. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return { actions: await listDivisionAutoActions(auth, id) };
  });
}
