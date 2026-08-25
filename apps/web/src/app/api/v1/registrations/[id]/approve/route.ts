import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
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
    // registration-approval.ts returns the RegistrationWithGroupRow it reads
    // internally, access_token_hash included (it needs the hash nowhere
    // itself — the column just rides along on regGroupCols, same as every
    // other confirm/mark-paid/waive/waitlist/withdraw/refund sibling route).
    // Stripped here the same way listRegistrations does it for the list/
    // export surface (RS005 W1a) — an organiser session must never receive
    // the registrant's own access-token hash.
    const { access_token_hash: _accessTokenHash, ...rest } = row;
    return rest;
  });
}
