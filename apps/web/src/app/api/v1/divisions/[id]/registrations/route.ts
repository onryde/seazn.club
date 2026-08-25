import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { RegistrationStatus } from "@/server/api-v1/schemas";
import { listRegistrations } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

// RS005 W1b: was a hand-copied, short allowlist (missing expired/rejected —
// ?status=rejected 400d). Derives from RegistrationStatus.options (schemas.ts)
// now — the ONE source, shared with the OpenAPI query enum (openapi.ts).
const STATUSES = RegistrationStatus.options as readonly string[];

/** Organiser registration list (?status= filter). Response rows are the
 *  widened RegistrationListEntry shape (RS005 W1a's listRegistrations). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const status = new URL(req.url).searchParams.get("status");
    if (status !== null && !STATUSES.includes(status)) {
      throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
    }
    return listRegistrations(auth, id, status);
  });
}
