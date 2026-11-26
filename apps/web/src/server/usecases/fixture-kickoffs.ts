import "server-only";
// The division page's read of each live match's ACTUAL start, for the run sheet's "Needs result" clock. Its own module
// beside `fixtures.ts`: the one reader of a kick-off is `kickoffsOf` (engine-db/kickoff.ts), shared with Match Day and
// the competition desk, so the sheet and the desk's `result_missing` measure from the same instant.
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { kickoffsOf } from "@/server/engine-db/kickoff";

/** Fixture id → the actual start (ISO) of each of these fixtures that is in play. A live match with no active start is
 *  absent (the row falls back to its slot); with nothing in play, nothing is read. */
export async function listFixtureKickoffs(
  auth: AuthCtx,
  fixtures: readonly { id: string; status: string }[],
): Promise<Record<string, string>> {
  const live = fixtures.filter((f) => f.status === "in_play").map((f) => f.id);
  if (live.length === 0) return {};
  const kickoffs = await withTenant(auth.orgId, (tx) => kickoffsOf(tx, live));
  return Object.fromEntries([...kickoffs].map(([id, k]) => [id, k.at.toISOString()]));
}
