import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PatchCourtInput, patchCourt, deleteCourt } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string; courtId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, courtId } = await params;
    assertUuid(id, "organization");
    assertUuid(courtId, "court");
    const body = await parseBody(req, PatchCourtInput);
    const auth = await requireOrgAuth(req, id, "write");
    return patchCourt(auth, courtId, body);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, courtId } = await params;
    assertUuid(id, "organization");
    assertUuid(courtId, "court");
    const auth = await requireOrgAuth(req, id, "write");
    await deleteCourt(auth, courtId);
    return { deleted: true };
  });
}
