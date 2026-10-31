import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CallFixtureInput } from "@/server/api-v1/schemas";
import { callFixtureToCourt, undoCall } from "@/server/usecases/match-day-call";

type Ctx = { params: Promise<{ id: string }> };

/** Match Day: call the match onto a free court, now (spec 2026-10-31 §7). The hard stops are 409s with their details
 *  (lib/match-day/call.ts). Authenticated before the body is read. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const body = await parseBody(req, CallFixtureInput);
    return callFixtureToCourt(auth, id, body.court_id);
  });
}

/** Match Day: Undo call — the match goes back to the court and time it had before it was called. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return undoCall(auth, id);
  });
}
