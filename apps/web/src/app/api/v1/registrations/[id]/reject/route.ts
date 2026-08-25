import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { rejectRegistration } from "@/server/usecases/registration-approval";

type Ctx = { params: Promise<{ id: string }> };

/** Manual-approval review: pending|paid → rejected. TERMINAL — a rejected row
 *  can never be approved (or re-rejected into a second transition) afterward.
 *  Frees the spot (auto-promotes the waitlist) and refunds a paid entry —
 *  rejectRegistration's own doc comment carries the full rule. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const row = await rejectRegistration(auth, id);
    // Strip the cart's access-token hash before it reaches an organiser
    // session — same reasoning as the approve route's identical strip.
    const { access_token_hash: _accessTokenHash, ...rest } = row;
    return rest;
  });
}
