import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { serialiseLevelRanks, type LevelRankRow } from "@/server/api-v1/level-rank";
import { getStandings } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    const poolId = new URL(req.url).searchParams.get("pool_id") ?? undefined;
    const snapshot = await getStandings(auth, id, poolId);
    // D11 b: a level table serves `rank: null`. Here, not in `getStandings` (which also feeds the division page and the
    // slideshow, E24): the usecase and the stored snapshot keep the places.
    return { ...snapshot, rows: serialiseLevelRanks(snapshot.rows as LevelRankRow[]) };
  });
}
