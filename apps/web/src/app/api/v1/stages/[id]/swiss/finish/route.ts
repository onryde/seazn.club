import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { finishSwissNow } from "@/server/usecases/swiss-rounds-admin";

type Ctx = { params: Promise<{ id: string }> };

/** W3 T13 (RB3-20, X-SW-26): "Finish the Swiss now" — end a running Swiss after its last complete round, then complete
 *  the stage (which seeds what follows). No body. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return finishSwissNow(auth, id);
  });
}
