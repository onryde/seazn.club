import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { approveDeal } from "@/server/usecases/sponsor-deals";

type Ctx = { params: Promise<{ id: string; dealId: string }> };

/** Approve: an awaiting-approval deal goes live, or queues behind the sponsor's live deal. 409 when the deal does not offer it (F12). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, dealId } = await params;
    assertUuid(id, "organization");
    assertUuid(dealId, "deal");
    const auth = await requireOrgAuth(req, id, "write");
    return approveDeal(auth, dealId);
  });
}
