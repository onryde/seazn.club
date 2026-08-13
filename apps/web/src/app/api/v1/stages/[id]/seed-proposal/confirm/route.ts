import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ConfirmSeedProposal } from "@/server/api-v1/schemas";
import { confirmSeedProposal } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Confirm a draft seed proposal: fills the stage's TBD fixtures via
 *  fillSlot (D4a design doc's Fill algorithm), never regenerates. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const input = await parseBody(req, ConfirmSeedProposal);
    return confirmSeedProposal(auth, id, input);
  });
}
