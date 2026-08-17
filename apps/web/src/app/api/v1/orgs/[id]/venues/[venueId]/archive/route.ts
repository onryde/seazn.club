import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { archiveVenue, unarchiveVenue } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string; venueId: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, venueId } = await params;
    assertUuid(id, "organization");
    assertUuid(venueId, "venue");
    const auth = await requireOrgAuth(req, id, "write");
    return archiveVenue(auth, venueId);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, venueId } = await params;
    assertUuid(id, "organization");
    assertUuid(venueId, "venue");
    const auth = await requireOrgAuth(req, id, "write");
    return unarchiveVenue(auth, venueId);
  });
}
