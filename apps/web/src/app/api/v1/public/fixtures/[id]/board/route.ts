import { v1, reply } from "@/server/api-v1/http";
import { publicPollRateLimit } from "@/server/usecases/public";
import { publicFixtureBoard } from "@/server/usecases/external-play-read";

type Ctx = { params: Promise<{ id: string }> };

/** T16 — an online chess board's view-only state, polled by the public page's
 *  watch island (the push carries each move to entitled spectators; this is
 *  everyone else's, and a lost push's, way to catch up). Polled on a timer, so
 *  it spends the poll bucket. A short PUBLIC window, like the live fixture
 *  summary's: a crowd on one board collapses at the edge, and the island's
 *  ply order refuses a board older than one it already shows. */
const BOARD_CACHE_CONTROL = "public, s-maxage=2, stale-while-revalidate=5";

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicPollRateLimit(req);
    const { id } = await params;
    return reply(200, await publicFixtureBoard(id), { "Cache-Control": BOARD_CACHE_CONTROL });
  });
}
