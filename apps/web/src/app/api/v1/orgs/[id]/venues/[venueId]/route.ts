import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PatchVenueInput, patchVenue, deleteVenue } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string; venueId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, venueId } = await params;
    assertUuid(id, "organization");
    assertUuid(venueId, "venue");
    const body = await parseBody(req, PatchVenueInput);
    const auth = await requireOrgAuth(req, id, "write");
    return patchVenue(auth, venueId, body);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, venueId } = await params;
    assertUuid(id, "organization");
    assertUuid(venueId, "venue");
    const auth = await requireOrgAuth(req, id, "write");
    await deleteVenue(auth, venueId);
    return { deleted: true };
  });
}
