import { HttpError } from "@/lib/errors";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { unassignSoloSignUp } from "@/server/usecases/registration-assign";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Return a placed solo sign-up (`id`) to the pool. HTTP wiring only —
 * unassignSoloSignUp (registration-assign.ts) owns every rule: idempotent
 * when the entry is already unplaced, refused once the division has
 * fixtures or has started.
 *
 * Takes no body fields, so a body-LESS POST must succeed. `parseBody` does
 * `await req.json()`, which throws on an empty body — the same trap
 * `.../promote/route.ts` documents and works around, and this route copies
 * its rawBody/`req.text()` normalisation for the same reason: an empty body
 * is legal, malformed JSON still 400s rather than surfacing a raw
 * SyntaxError 500. Nothing in the body is ever read (unassign takes no
 * input beyond the URL `id`) — this only decides whether to accept it.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const rawBody = await req.text();
    if (rawBody.trim() !== "") {
      try {
        JSON.parse(rawBody);
      } catch {
        throw new HttpError(400, "Request body must be valid JSON");
      }
    }
    return unassignSoloSignUp(auth, { registration_id: id });
  });
}
