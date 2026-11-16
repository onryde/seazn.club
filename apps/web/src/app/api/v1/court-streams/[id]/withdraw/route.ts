import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { courtLinkOwner, withdrawCourtStream } from "@/server/usecases/court-streams";

type Ctx = { params: Promise<{ id: string }> };

/** Withdraw a court link (court stream §5.1): its code ends and the court is free for a new link. A session already live
 *  keeps streaming. Editor session only; idempotent (204 again); 404 for an unknown link or another organisation's. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const { competitionId } = await courtLinkOwner(id);
    const auth = await requireResourceAuth(req, "competition", competitionId, "write");
    await withdrawCourtStream(auth, id);
    return reply(204, null);
  });
}
