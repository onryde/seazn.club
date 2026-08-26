import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { organiserRegistration } from "@/server/api-v1/registration-response";
import { approveRegistration } from "@/server/usecases/registration-approval";

type Ctx = { params: Promise<{ id: string }> };

/** Manual-approval review: pending|paid → confirmed, materialising the
 *  entrant exactly as /confirm does (registration-approval.ts). Refused on
 *  an auto-approval division, an already-rejected row, or one already
 *  refunded — approveRegistration's own doc comment carries the full rule;
 *  not reimplemented here. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const row = await approveRegistration(auth, id);
    return organiserRegistration(row, auth);
  });
}
