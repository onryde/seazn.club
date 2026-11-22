import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseBody, reply, v1 } from "@/server/api-v1/http";
import { AdjustPointsInput } from "@/server/api-v1/schemas";
import { adjustPoints, listPointsAdjustments } from "@/server/usecases/points-adjustments";

type Ctx = { params: Promise<{ id: string }> };

/** W5 app PR B Task 7 (C5; X-ADJ-4; R24 pick 15 A): "Adjust points" - move an entrant's table points by `delta`, with a required
 *  `reason` shown under the table on every surface. A started, not-complete league, group or Swiss stage only; every refusal is
 *  named (RR_ADJUST_*, the engine's reasons by name). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, AdjustPointsInput);
    return reply(201, await adjustPoints(auth, id, body));
  });
}

/** The stage's active adjustments, in ledger order (`held`: its entrant is no member of the table now, preflight C8). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    return listPointsAdjustments(auth, id);
  });
}
