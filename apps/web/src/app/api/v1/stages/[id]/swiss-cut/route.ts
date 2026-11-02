import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { getSwissCutDrift } from "@/server/usecases/swiss-cut-drift";

type Ctx = { params: Promise<{ id: string }> };

/** W3 T17 (RB3-19, X-SW-25): who a correction moved across a completed Swiss's cut after its knockout began — the desk's
 *  "the bracket stands" warning. Organiser-only, as the other Swiss routes: `drift` is `null` when nothing moved. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return { drift: await getSwissCutDrift(auth, id) };
  });
}
