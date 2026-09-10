import { v1, reply, parseBody, assertOneOf } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateSuspension, SuspensionStatus } from "@/server/api-v1/schemas";
import { createManualSuspension, listSuspensions } from "@/server/usecases/discipline";

type Ctx = { params: Promise<{ id: string }> };

/** List suspensions in the division, optionally filtered by ?status= (SPEC-1). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    // Same rule as the org news feed: an unrecognised ?status= 400s rather
    // than quietly widening the list. A discipline read that silently returns
    // waived and served suspensions when "pending" was asked for is a worse
    // answer than an error.
    const status = new URL(req.url).searchParams.get("status");
    assertOneOf(status, SuspensionStatus.options, "status");
    return listSuspensions(auth, id, status ?? undefined);
  });
}

/** Record a manual suspension (pending until the organiser confirms it). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const body = await parseBody(req, CreateSuspension);
    const created = await createManualSuspension(auth, id, {
      personId: body.person_id,
      matchesTotal: body.matches_total,
      reason: body.reason,
    });
    return reply(201, created);
  });
}
