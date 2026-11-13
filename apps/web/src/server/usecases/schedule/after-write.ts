import "server-only";
import { cacheDel, sendAfterDeleteOrBound } from "@/lib/cache";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { publicFixtureCacheKey } from "@/server/public-site/fixture-doc-cache-key";
import { publicDivisionCacheKeys } from "@/server/public-site/division-doc-cache-keys";
import { publicHubCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import { publishDivisionUpdate, publishFixtureUpdate } from "@/lib/realtime";
import { log } from "@/server/logger";

// Every schedule write invalidates both public cache layers (the same pattern
// as scoring, doc 09 §3 / doc 12 §2) and refreshes any open boards.
// Exported for the #350 joint apply (competition-schedule-apply.ts), which fires
// it once per written division AFTER its single transaction commits — same
// placement as `applySchedule`, not a second copy of the invalidation list.
export function afterScheduleWrite(
  divisionId: string,
  competitionId: string,
  reason: "schedule" | "publish" | "start",
  /** R10d n2: every fixture this write changed. A write that moves no single
   *  fixture (publish, start) passes its division's fixtures, read in its own
   *  transaction, never found by a keyspace SCAN. */
  fixtureIds: readonly string[],
  /** `fixturePushes: false` sends no per-fixture push (the DEL still drops every key, and the division push still goes).
   *  For a write whose fixtures nobody can be watching yet: a quick match's create, which starts a division its guest has
   *  not seen (owner 2026-11-13: 30 broadcasts for six sides playing twice, measured). Every other caller leaves it. */
  opts: { fixturePushes?: boolean } = {},
): void {
  fireDivisionRevalidate(divisionId, competitionId);
  // W2 — the competition HUB document (`pub:v1:hub:{competitionId}`) carries
  // every fixture's kick-off time and venue, so a RESCHEDULE makes it stale
  // exactly as a score does. Scoring's own `invalidatePublicCache` drops the
  // same key; a hub whose matches go stale on a reschedule is precisely the
  // defect that costs a spectator the trip.
  //
  // R10c m1: scoring's shape. The key is literal, so it goes out in one direct
  // DEL instead of a SCAN over the whole keyspace, and the division push waits
  // for that DEL, never longer than PUSH_AFTER_DELETE_BOUND_MS, exactly once. A
  // push sent first sends the hub's refetch to a Redis copy the delete has not
  // reached yet.
  //
  // Final review r2-m4: the division's own schedule, standings and entrants
  // documents ride the same DEL by name (`publicDivisionCacheKeys`), where a
  // `pub:v1:div:{id}:*` SCAN over the whole keyspace used to find them.
  //
  // R10d n2: the match centre and the overlay read `pub:v1:fixture:{id}`
  // (`publicFixture`, usecases/public.ts), a 30s cache of a fixture's kick-off,
  // venue and court. Every fixture this write changed has its key in the SAME
  // one DEL and its `fixture:{id}` push in the same bounded send, so an open
  // match centre refetches now instead of at its poll, and never before the
  // delete. A write that changed more than SCHEDULE_FIXTURE_PUSH_CAP fixtures
  // (a whole-division apply, publish or start) still drops every key but sends
  // no per-fixture push: one write must not fan out hundreds of broadcasts, and
  // those match centres catch up on their poll.
  const keys = [
    publicHubCacheKey(competitionId),
    ...fixtureIds.map(publicFixtureCacheKey),
    ...publicDivisionCacheKeys(divisionId),
  ];
  // F4: never left to reject unhandled. `cacheDel` fails open inside its own
  // try, but its `client()` call sits outside it (cache.ts), and ioredis's
  // constructor throws synchronously on a REDIS_URL it cannot parse.
  const deleted = cacheDel(...keys).catch((err: unknown) => {
    log.error({ err, keys }, "schedule: a public Redis delete failed (the write stands)");
  });
  const pushFixtures = (opts.fixturePushes ?? true) && fixtureIds.length <= SCHEDULE_FIXTURE_PUSH_CAP;
  sendAfterDeleteOrBound(deleted, () => {
    void publishDivisionUpdate(divisionId, reason);
    if (pushFixtures) for (const id of fixtureIds) void publishFixtureUpdate(id, "schedule");
  });
}

/** R10d n2: a schedule write that changed MORE fixtures than this sends no
 *  per-fixture push. Its DEL still drops every one of their keys. */
export const SCHEDULE_FIXTURE_PUSH_CAP = 50;
