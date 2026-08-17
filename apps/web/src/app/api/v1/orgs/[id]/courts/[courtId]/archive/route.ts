import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { archiveCourt, unarchiveCourt } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string; courtId: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, courtId } = await params;
    assertUuid(id, "organization");
    assertUuid(courtId, "court");
    const auth = await requireOrgAuth(req, id, "write");
    return archiveCourt(auth, courtId);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, courtId } = await params;
    assertUuid(id, "organization");
    assertUuid(courtId, "court");
    const auth = await requireOrgAuth(req, id, "write");
    return unarchiveCourt(auth, courtId);
  });
}
