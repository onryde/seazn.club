import { parseOptionalBody, v1 } from "@/server/api-v1/http";
import { ConfirmRegistration } from "@/server/api-v1/schemas";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { organiserRegistration } from "@/server/api-v1/registration-response";
import { confirmRegistration } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Organiser approve: materialises the entrant (idempotent). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    // Optional body: `confirm_over_capacity` lifts the division's own capacity refusal for a waitlisted entry (never the plan limit).
    const input = await parseOptionalBody(req, ConfirmRegistration);
    return organiserRegistration(await confirmRegistration(auth, id, { confirmOverCapacity: input.confirm_over_capacity === true }), auth);
  });
}
