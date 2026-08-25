import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
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
    const input = await parseBody(req, PromoteRegistration);
    const promoted = await promoteFromWaitlist(auth, row.division_id, {
      registrationId: input.registration_id,
    });
    if (!promoted) return null;
    // Strip the cart's access-token hash before it reaches an organiser
    // session — same reasoning as the approve/reject routes' identical strip.
    const { access_token_hash: _accessTokenHash, ...rest } = promoted;
    return rest;
  });
}
