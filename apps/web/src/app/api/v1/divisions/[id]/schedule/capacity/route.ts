import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CapacityPrecheckInput, assessCapacityForDivision } from "@/server/usecases/capacity-guard";

type Ctx = { params: Promise<{ id: string }> };

/** D2's live capacity precheck (P10 §4): the board's own live, unsaved
 *  config/fixtures in the body — see capacity-guard.ts's
 *  assessCapacityForDivision for why this computation had to move to the
 *  server rather than back onto the board's RSC payload. Read-only, same
 *  scope as its sibling /schedule/validate: nothing is persisted, and a bad
 *  verdict is a 200 with `verdict: "impossible"`, never a throw. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const body = await parseBody(req, CapacityPrecheckInput);
    return assessCapacityForDivision(auth, id, body);
  });
}
