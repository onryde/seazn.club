import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateCourtInput, createCourt } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string; venueId: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, venueId } = await params;
    assertUuid(id, "organization");
    assertUuid(venueId, "venue");
    const body = await parseBody(req, CreateCourtInput);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await createCourt(auth, venueId, body));
  });
}
