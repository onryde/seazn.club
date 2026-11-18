import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { listStagePools } from "@/server/usecases/stage-standings-api";

type Ctx = { params: Promise<{ id: string }> };

/** The pools of a stage with several pools (ST-G28): the ids `GET /stages/{id}/standings?pool_id=` takes and the keys its rows' `pool`
 *  carries. A league, a knockout and a group of one pool list none. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    return listStagePools(auth, id);
  });
}
