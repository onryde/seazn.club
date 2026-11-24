import "server-only";
import { cacheDel, sendAfterDeleteOrBound } from "@/lib/cache";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { publicFixtureCacheKey } from "@/server/public-site/fixture-doc-cache-key";
import { publicDivisionCacheKeys } from "@/server/public-site/division-doc-cache-keys";
import { publicHubCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import { broadcast, divisionMessages, fixtureMessage, realtimePublishEnabled, type RealtimeMessage } from "@/lib/realtime";
import { log } from "@/server/logger";
import { courtPairingNudges, fireNudge, hasCourtReadableId } from "@/server/usecases/stream-sessions/nudge";
import { matchDayNudgesFor } from "@/server/usecases/match-day-nudges";

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
   *  not seen (owner 2026-11-13: 30 broadcasts for six sides playing twice, measured). Every other caller leaves it.
   *  `reason: "call"` (match-day-call.ts only) names the Match Day nudge a call sends; every other write sends `schedule`. */
  opts: { fixturePushes?: boolean; reason?: "call" } = {},
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
  // Realtime push-nudges T0.2: the division message and every fixture message go out in ONE broadcast (one POST under
  // the cap), where they used to be one POST each.
  //
  // T1.5: the `next-match` nudges to the courts' camera phones ride in that SAME broadcast, so a write is still one POST. Their
  // read starts NOW — the write has committed, and the read needs nothing the DEL does — and the push only AWAITS it, so the
  // push time is the later of the DEL and the read, never DEL + read: R10c's "never longer than PUSH_AFTER_DELETE_BOUND_MS"
  // (1500 ms) holds because the read has its own, tighter bound (COURT_NUDGE_READ_BOUND_MS). A slow or dead pool costs the
  // write its court nudges and nothing else. The read is made only under the cap (`pushFixtures`: past it nobody is told per
  // fixture) and only when publishing is on (`realtimePublishEnabled`: a kill switch sends nothing, so it reads nothing).
  //
  // Not nudged, by design: the OLD court of a moved fixture, and a fixture cleared off its court. That phone catches up on its
  // own poll. And a link live now nudges its court's phone whichever day the fixture is on: a nudge only makes the phone beat,
  // and the beat decides, so a spare nudge is harmless.
  const court = pushFixtures && realtimePublishEnabled() ? courtNudges(fixtureIds) : Promise.resolve<RealtimeMessage[]>([]);
  // T2.3: the competition's open Match Day codes hear of the write in the same POST. That read starts now too, under the same rules
  // (publishing on, a bound, never a second POST), and is skipped for `fixturePushes: false` — the quick match's create, whose
  // competition has no Match Day code. Unlike the court read it is NOT held back by SCHEDULE_FIXTURE_PUSH_CAP: a whole-division
  // apply, publish or start changes the day a Match Day screen shows, and costs one message per open code, not per fixture.
  const matchDay = opts.fixturePushes === false ? Promise.resolve<RealtimeMessage[]>([]) : matchDayNudgesFor(competitionId, opts.reason ?? "schedule");
  sendAfterDeleteOrBound(deleted, () => {
    fireNudge(
      (async () => {
        const nudges = await court;
        const dayNudges = await matchDay;
        await broadcast(
          [...divisionMessages(divisionId, reason), ...(pushFixtures ? fixtureIds.map((id) => fixtureMessage(id, "schedule")) : []), ...nudges, ...dayNudges],
          "schedule",
        );
      })().catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.name : "error", divisionId }, "schedule: the realtime push failed (the write stands)");
      }),
    );
  });
}

/**
 * How long a schedule write's court read may take before the push goes without the court nudges. Tighter than
 * PUSH_AFTER_DELETE_BOUND_MS (1500 ms, cache.ts) on purpose: the read runs beside the DEL, so the push is never later than the
 * larger of the two, and 750 ms is half the DEL's bound — a healthy pool answers one indexed read in single-digit ms, so this only
 * ever trips on a stalled pool, and then losing one nudge (the phone beats on its poll anyway) is the cheap side of the trade.
 */
export const COURT_NUDGE_READ_BOUND_MS = 750;

/** The court nudges of a write, or [] — never rejects, and never takes longer than COURT_NUDGE_READ_BOUND_MS (the read is
 *  abandoned, not cancelled: a pooled statement cannot be). A fixture set with nothing to read (empty, or no uuid) reads nothing
 *  and arms no timer. */
async function courtNudges(fixtureIds: readonly string[]): Promise<RealtimeMessage[]> {
  if (!hasCourtReadableId(fixtureIds)) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = new Promise<RealtimeMessage[]>((resolve) => {
      timer = setTimeout(() => { resolve([]); }, COURT_NUDGE_READ_BOUND_MS);
    });
    return await Promise.race([courtPairingNudges(fixtureIds), bound]);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.name : "error" }, "schedule: the courts' next-match nudges could not be read");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** R10d n2: a schedule write that changed MORE fixtures than this sends no
 *  per-fixture push. Its DEL still drops every one of their keys. */
export const SCHEDULE_FIXTURE_PUSH_CAP = 50;
