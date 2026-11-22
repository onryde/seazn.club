import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { loadMatchDayBoard } from "@/server/usecases/external-play/arbiter";

type Ctx = { params: Promise<{ id: string }> };

/** Match Day online: the board in focus (spec 2026-11-05 §5, task 3) - the board as the arbiter's round view paints it, with the position
 *  of its game. Reads only; the competition read's own terms (`read`: any member who may read, a read-scope key), no editor check: the
 *  board and its state are a viewer's too. A board the signed-in caller plays on is refused 403 by the usecase, a board that is not an
 *  online board of this club (or a cancelled one with no open flag) 404. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "read");
    return loadMatchDayBoard(auth, id);
  });
}
