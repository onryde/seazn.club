import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { serialiseLevelRanksPerPool } from "@/server/api-v1/level-rank";
import { getStageStandings } from "@/server/usecases/stage-standings-api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    const poolId = new URL(req.url).searchParams.get("pool_id") ?? undefined;
    const snapshot = await getStageStandings(auth, id, poolId);
    // D11 b: a level table serves `rank: null`. Here, not in the usecase (which, like `getStandings` under the division page and the
    // slideshow, E24, keeps the stored places). Each pool of an all-pools answer is judged on its own rows.
    return { ...snapshot, rows: serialiseLevelRanksPerPool(snapshot.rows) };
  });
}
