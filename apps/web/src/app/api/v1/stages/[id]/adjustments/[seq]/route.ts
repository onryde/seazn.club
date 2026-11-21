import { requireResourceAuth } from "@/server/api-v1/auth";
import { v1 } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { undoPointsAdjustment } from "@/server/usecases/points-adjustments";

type Ctx = { params: Promise<{ id: string; seq: string }> };

/** W5 app PR B Task 7 (X-ADJ-4): the adjustment's Undo - an append-only void row naming it; the table returns. Gated like the
 *  write (C5): a finished table is not re-ranked. 409 RR_ADJUST_ALREADY_UNDONE for a row already undone. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, seq } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const n = Number(seq);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "adjustment not found");
    return undoPointsAdjustment(auth, id, n);
  });
}
