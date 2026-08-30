import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { listAssignTargets } from "@/server/usecases/registration-assign";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Assignable teams for a pooled solo sign-up (`id`): every non-free-agent,
 * non-terminal registration in the same division, with enough roster state
 * (`roster_count`/`roster_cap`/`is_full`/`genders`) for the UI to explain,
 * BEFORE the click, why a mixed division will refuse a placement — the same
 * rule `assignSoloSignUp` enforces server-side once the organiser actually
 * presses Assign. 404s when `id` is not itself a solo sign-up: the list is
 * meaningless for anything else (listAssignTargets, registration-assign.ts).
 *
 * Scope "write", not "read", deliberately: this list exists only to feed a
 * write action (Assign), and READ_ROLES here includes `viewer` — RS005's
 * close note records that widening the hub to viewers silently promoted
 * controls a read-only role could then press. A viewer must not be handed
 * this list.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    return listAssignTargets(auth, id);
  });
}
