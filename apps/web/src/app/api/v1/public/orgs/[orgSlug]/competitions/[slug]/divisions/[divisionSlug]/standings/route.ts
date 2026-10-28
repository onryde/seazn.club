import { v1, reply } from "@/server/api-v1/http";
import { serialiseLevelRanks, type LevelRankRow } from "@/server/api-v1/level-rank";
import { publicStandings, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string; slug: string; divisionSlug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug, divisionSlug } = await params;
    // The cached document is the stored shape (`publicStandings` is untouched, E24); each table is judged on its own rows
    // and a level one serves `rank: null` (D11 b), the same as `GET /stages/{id}/standings` serves it.
    const doc = (await publicStandings(orgSlug, slug, divisionSlug)) as { standings: { rows: LevelRankRow[] }[] };
    const data = { ...doc, standings: doc.standings.map((table) => ({ ...table, rows: serialiseLevelRanks(table.rows) })) };
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
