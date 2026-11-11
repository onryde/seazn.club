import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { writeOffDeal } from "@/server/usecases/sponsor-deals";

type Ctx = { params: Promise<{ id: string; dealId: string }> };

/** Write off: the club waives an offline invoice still due after its deal ended; the invoice then reads "Nothing due". 409 when
 *  the deal has nothing still due (F12). Console-only. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, dealId } = await params;
    assertUuid(id, "organization");
    assertUuid(dealId, "deal");
    const auth = await requireOrgAuth(req, id, "write");
    return writeOffDeal(auth, dealId);
  });
}
