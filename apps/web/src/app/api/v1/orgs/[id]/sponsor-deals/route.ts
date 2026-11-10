import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { listDeals } from "@/server/usecases/sponsor-deals";

type Ctx = { params: Promise<{ id: string }> };

/** The org's sponsor deals, newest first; `?sponsor_id=` narrows to one sponsor's. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    const sponsorId = new URL(req.url).searchParams.get("sponsor_id");
    if (sponsorId !== null) assertUuid(sponsorId, "sponsor");
    return listDeals(auth, sponsorId === null ? {} : { sponsorId });
  });
}
