import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateVenueInput, listVenues, createVenue } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    return listVenues(auth);
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, CreateVenueInput);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await createVenue(auth, body));
  });
}
