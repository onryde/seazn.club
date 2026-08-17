import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PutCourtCalendarInput, putCourtCalendar } from "@/server/usecases/venues";

type Ctx = { params: Promise<{ id: string; courtId: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, courtId } = await params;
    assertUuid(id, "organization");
    assertUuid(courtId, "court");
    const body = await parseBody(req, PutCourtCalendarInput);
    const auth = await requireOrgAuth(req, id, "write");
    return putCourtCalendar(auth, courtId, body);
  });
}
