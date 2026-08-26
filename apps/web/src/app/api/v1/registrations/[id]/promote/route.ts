import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { organiserRegistration } from "@/server/api-v1/registration-response";
import { PromoteRegistration } from "@/server/api-v1/schemas";
import { promoteFromWaitlist } from "@/server/usecases/registration-approval";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Promote from the waitlist (registration-approval.ts's `promoteFromWaitlist`,
 * which takes a DIVISION plus an optional explicit-registration override —
 * not a bare registration id). `id` here resolves which division to promote
 * within: every registration belongs to exactly one, so this route works
 * whether or not `id` itself ends up the row that gets promoted.
 *
 * `registration_id` in the body, when given, overrides which waitlisted entry
 * gets promoted (must belong to `id`'s division — promoteFromWaitlist 404s
 * otherwise); omitted, the oldest waitlisted entry in that division promotes
 * (promoteFromWaitlist's default, honouring the same order
 * promoteOldestWaitlisted's own `order by created_at, id` uses elsewhere).
 * Returns null when the default path finds nothing waitlisted.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const [row] = await sql<{ division_id: string }[]>`
      select division_id from registrations where id = ${id}`;
    if (!row) throw new HttpError(404, "registration not found");
    // A body-LESS POST is the documented default path: `registration_id` is
    // optional and omitting it promotes the oldest waitlisted entry. But
    // `parseBody` does `await req.json()`, which throws on an empty body and
    // becomes a 400 "Request body must be valid JSON" — so `curl -X POST
    // .../promote` with no body could never reach the behaviour this route's
    // own doc comment and its OpenAPI summary both advertise. Nothing local
    // caught it because the UI always sends `{}` or `{registration_id}`.
    //
    // Normalised HERE rather than in `parseBody`: that helper is shared by
    // every api-v1 route, and most of them genuinely require a body. Widening
    // it would make a missing body silently acceptable across the whole API.
    const rawBody = await req.text();
    let parsedBody: unknown = {};
    if (rawBody.trim() !== "") {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        // The SAME 400 parseBody would have produced. An empty body is now
        // legal; malformed JSON still is not, and must not surface as a raw
        // SyntaxError 500.
        throw new HttpError(400, "Request body must be valid JSON");
      }
    }
    const input = PromoteRegistration.parse(parsedBody);
    const promoted = await promoteFromWaitlist(auth, row.division_id, {
      registrationId: input.registration_id,
    });
    if (!promoted) return null;
    return organiserRegistration(promoted, auth);
  });
}
