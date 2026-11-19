import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { parseOptionalBody, v1 } from "@/server/api-v1/http";
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
 * otherwise); omitted, the entry at the head of that division's queue
 * promotes (promoteFromWaitlist's default: `promoteOldestWaitlisted`, which
 * takes the queue in `waitlistQueueKey` order - `coalesce(waitlisted_at,
 * created_at), id`, so a lapsed promotion or an organiser's move waits at the
 * back - the same order every surface counts a place in line by).
 * Returns null when the default path finds nothing waitlisted.
 *
 * A promotion into a division at or over its capacity is refused 409
 * `PROMOTE_OVER_CAPACITY` unless the body carries `confirm_over_capacity:
 * true`; one past the plan's per-division entrant limit is refused 422
 * `PROMOTE_PLAN_LIMIT` whatever the body says.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    const [row] = await sql<{ division_id: string }[]>`
      select division_id from registrations where id = ${id}`;
    if (!row) throw new HttpError(404, "registration not found");
    // A body-LESS POST is the documented default path (`registration_id` is optional, omitting it promotes the oldest waitlisted
    // entry): `parseOptionalBody` makes an empty body `{}` and keeps malformed JSON the same 400.
    const input = await parseOptionalBody(req, PromoteRegistration);
    const promoted = await promoteFromWaitlist(auth, row.division_id, {
      registrationId: input.registration_id,
      confirmOverCapacity: input.confirm_over_capacity === true,
    });
    if (!promoted) return null;
    return organiserRegistration(promoted, auth);
  });
}
