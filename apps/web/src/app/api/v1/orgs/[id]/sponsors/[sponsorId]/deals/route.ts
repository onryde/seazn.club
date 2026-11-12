import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { CreateDealInput, createDeal } from "@/server/usecases/sponsor-deals";

type Ctx = { params: Promise<{ id: string; sponsorId: string }> };

/** Add a deal to a sponsor (plan 2026-11-07-sponsor-deals, Task 6). 201 `{ deal, invoice_url }` (F11; T23 review I1): the
 *  link an online deal's invoice email carries, null for an offline or complimentary deal. An editor's write, console-only (never key-accessible). Auth precedes the body, so a
 *  viewer is refused before anything it sent is read. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sponsorId } = await params;
    assertUuid(id, "organization");
    assertUuid(sponsorId, "sponsor");
    const auth = await requireOrgAuth(req, id, "write");
    const body = await parseBody(req, CreateDealInput);
    return reply(201, await createDeal(auth, sponsorId, body, baseUrl(req)));
  });
}
