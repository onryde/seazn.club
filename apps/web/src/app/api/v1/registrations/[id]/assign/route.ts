import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AssignSoloSignUp } from "@/server/api-v1/schemas";
import { assignSoloSignUp } from "@/server/usecases/registration-assign";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Place a pooled solo sign-up (`id`) onto a team entry
 * (`target_registration_id`) in the same division. HTTP wiring only —
 * assignSoloSignUp (registration-assign.ts) owns every rule this can fail:
 * same-division, roster cap, mixed-division composition, idempotent
 * re-assign, 409 when the player is already on a different team. This route
 * does not re-implement or re-word any of that — it returns whatever
 * assignSoloSignUp returns.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const input = await parseBody(req, AssignSoloSignUp);
    return assignSoloSignUp(auth, {
      registration_id: id,
      target_registration_id: input.target_registration_id,
    });
  });
}
