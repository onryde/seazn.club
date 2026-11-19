import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { previewWithdrawal } from "@/server/usecases/withdrawal-preview";

type Ctx = { params: Promise<{ id: string }> };

/** W5 T8b (X-WDT-10, ruling 289): what withdrawing or disqualifying this entrant WOULD do — her remaining matches, her played
 *  count against her scheduled count, expunge or walkover, and how Reinstate undoes it. The cascade's own decision; read-only.
 *  The organiser's confirmation reads it before the write. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "read");
    const as = new URL(req.url).searchParams.get("as");
    if (as !== "withdrawn" && as !== "disqualified") throw new HttpError(422, "as must be withdrawn or disqualified");
    return previewWithdrawal(auth, id, as);
  });
}
