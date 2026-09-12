import { v1, reply } from "@/server/api-v1/http";
import { publicFixture, publicRateLimit } from "@/server/usecases/public";

type Ctx = { params: Promise<{ id: string }> };

/** Live public fixture summary (doc 08 §3). Same no-store rule as the overlay
 *  poll target — `PUBLIC_CACHE_CONTROL` (s-maxage=30) left match-centre polls
 *  holding a pre-ball body while the ledger moved. */
const LIVE_CACHE_CONTROL = "private, no-store";

/** Live public fixture summary (doc 08 §3). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const data = await publicFixture(id);
    return reply(200, data, { "Cache-Control": LIVE_CACHE_CONTROL });
  });
}
