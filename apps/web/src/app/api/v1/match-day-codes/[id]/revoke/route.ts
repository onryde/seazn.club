import { v1, reply } from "@/server/api-v1/http";
import { requireOrgAuth } from "@/server/api-v1/auth";
import { matchDayCodeOrg, revokeMatchDayCode } from "@/server/usecases/match-day-codes";

type Ctx = { params: Promise<{ id: string }> };

/** Withdraw a Match Day code (capture S4 design §3): from now on it lists and opens nothing; links it already opened
 *  keep working. Editor session only; idempotent (204 again). 404 for an unknown code or another organisation's. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireOrgAuth(req, await matchDayCodeOrg(id), "write");
    await revokeMatchDayCode(auth, id);
    return reply(204, null);
  });
}
