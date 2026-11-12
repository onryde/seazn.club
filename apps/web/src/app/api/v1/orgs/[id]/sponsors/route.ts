import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateSponsorInput, listSponsors, createSponsor } from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    // Archive spec D12: archived rows are left out unless `?archived=1` (the house "1"/"0" convention); any other value excludes.
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    return listSponsors(auth, { includeArchived });
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, CreateSponsorInput);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await createSponsor(auth, body));
  });
}
