import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { computeSeedProposal } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Compute (or recompute) a DRAFT seed proposal for a `.seeding`-declared
 *  stage (D4a design doc — propose + confirm, never fully automatic). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return reply(201, await computeSeedProposal(auth, id));
  });
}
