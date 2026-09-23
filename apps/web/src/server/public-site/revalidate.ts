import "server-only";
// ISR invalidation for the public dashboard (doc 09 §3): the SAME service-
// layer writes that publish realtime fire these tags. Fire-and-forget — a
// failed revalidation must never roll back a scoring write, and unit tests
// call use-cases outside a request scope where revalidateTag would throw.
import { revalidatePath, revalidateTag } from "next/cache";
import { sql } from "@/lib/db";
import { cacheDel, cacheDelPattern } from "@/lib/cache";
import { broadcastRevalidate } from "@/lib/peer-revalidate";
import { purgeCdn } from "@/lib/cdn-purge";
import { log } from "@/server/logger";
import { divisionTag, competitionTag, orgTag, personTag, DISCOVERY_TAG } from "./data";
import { deferred } from "@/lib/deferred";
import { publicFixtureCacheKey } from "./fixture-doc-cache-key";
import { publicDivisionCacheKeys } from "./division-doc-cache-keys";

export { DISCOVERY_TAG };

export function fireDivisionRevalidate(divisionId: string, competitionId?: string): void {
  const tags = [divisionTag(divisionId), ...(competitionId ? [competitionTag(competitionId)] : [])];
  try {
    // Next 16 signature: second arg = stale-while-revalidate window ('max' =
    // serve the previous render while fresh regenerates — right for spectator
    // pages). How long that lasts was MEASURED once, for the pages a consent
    // OFF touches (`firePersonRevalidate`); these division and competition
    // pages use the same SWR mechanism but were not measured.
    revalidateTag(tags[0], "max");
    if (competitionId) revalidateTag(competitionTag(competitionId), "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate(tags, "swr");
  void purgeCdn();
}

/** A write to what the public pages show about a PERSON: their consent
 *  (`setMyConsent`, `patchPerson`), name or date of birth (`patchPerson`),
 *  photo (`setMyPersonPhoto`, `setPersonPhoto`), or a merge and its reversal
 *  (`mergePersons` / `reverseMerge`, which rewrite consent). Pass every person
 *  whose public reads the write changed.
 *
 *  Two reaches, because a name is baked into DATA entries as well as pages, and
 *  Next checks a data entry against its OWN tags only — an expired page that
 *  rebuilds from an unexpired data entry puts the old name straight back:
 *   - each person's tag (`personTag`), EXPIRED: their card's page and data
 *     entries at every competition URL, allowed or refused, including a
 *     competition they are not rostered in (`public_players_v` is org-scoped);
 *   - the division tag of every division they are rostered in, deduped,
 *     EXPIRED: the entries that mask their name for others (`pub-div-v3`,
 *     `pub-fixture-v3`, `pub-hub-v3`, and other players' cards through
 *     `pub-player-v17`), and the pages built on them. It used to be 'max',
 *     which serves the PREVIOUS render while the rebuild runs (measured after
 *     a consent OFF: 2.8–4.3s, 2–3 loads, in a local prod build at load 16–40).
 *     Final review I2 closed that: the hub's Redis document is dropped below
 *     and rebuilt through `pub-div-v3`, so a stale entry baked the old names
 *     back into the hub for its 15s TTL;
 *   - the competition tag of each, deduped, still 'max' (as a score write
 *     fires it): no name is baked only under the competition tag, and an
 *     expired tag beats a stale one on an entry carrying both.
 *  Cost: a person on N rosters expires N divisions' entries, once per write,
 *  and the first reader of each rebuilds — the same a score write does to one
 *  division on every point.
 *  The public REDIS documents that print their name are dropped too (final
 *  review I2): the hub of every competition they are rostered in, the
 *  schedule, standings and entrants documents of every such division, and the
 *  match-centre document of every fixture their entrant plays or their lineup
 *  names (`dropNamedPublicDocuments`). Those serve a poll for up to 15–30s
 *  from Redis, beyond the reach of any tag.
 *  Never the org tag: that would expire every page and data entry of the org,
 *  hubs included, on each of these writes — and `PATCH /api/v1/persons/{id}`
 *  takes API keys, so a roster sync would be one org-wide expiry per person.
 *  One broadcast per profile and one CDN purge per write.
 *
 *  AWAIT it inside the request, after commit: it reads the rosters before
 *  firing, and Next flushes a handler's revalidations when the handler
 *  resolves and never after, so a voided call's tags go nowhere. It never rejects — the write
 *  it follows has committed — so the caller's next after-commit step (the Redis
 *  retire) always runs. A failed roster read is logged, and the person tags
 *  still fire. */
export async function firePersonRevalidate(
  personIds: readonly string[],
  context: Record<string, unknown>,
): Promise<void> {
  const personTags = [...new Set(personIds)].map(personTag);
  let divisionTags: string[] = [];
  let competitionTags: string[] = [];
  let memberships: { division_id: string; competition_id: string }[] = [];
  try {
    memberships = await sql<{ division_id: string; competition_id: string }[]>`
      select distinct e.division_id, d.competition_id
      from entrant_members em
      join entrants e on e.id = em.entrant_id
      join divisions d on d.id = e.division_id
      where em.person_id in ${sql([...personIds])}`;
    divisionTags = [...new Set(memberships.map((m) => divisionTag(m.division_id)))];
    competitionTags = [...new Set(memberships.map((m) => competitionTag(m.competition_id)))];
  } catch (err) {
    log.error(
      { err, personIds, ...context },
      "public pages: a person's rosters could not be read to revalidate the pages naming them (the write stands)",
    );
  }
  try {
    // Competition 'max' FIRST, for the reason `fireScoreRevalidate` gives: a
    // later 'max' for one of these divisions in the same request must join the
    // already-open 'max' group, never overwrite the expiry.
    for (const tag of competitionTags) revalidateTag(tag, "max");
    for (const tag of personTags) revalidateTag(tag, { expire: 0 });
    for (const tag of divisionTags) revalidateTag(tag, { expire: 0 });
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  const peersExpired = broadcastRevalidate([...personTags, ...divisionTags], "expire");
  void broadcastRevalidate(competitionTags, "swr");
  void purgeCdn();
  let fixtureIds: string[] = [];
  try {
    const fixtures = await sql<{ id: string }[]>`
      select f.id
      from entrant_members em
      join fixtures f on f.home_entrant_id = em.entrant_id or f.away_entrant_id = em.entrant_id
      where em.person_id in ${sql([...personIds])}
      union
      select l.fixture_id as id from lineups l where l.person_id in ${sql([...personIds])}`;
    fixtureIds = fixtures.map((f) => f.id);
  } catch (err) {
    log.error(
      { err, personIds, ...context },
      "public documents: the fixtures naming a person could not be read to drop their match-centre documents (the write stands)",
    );
  }
  dropNamedPublicDocuments(
    {
      competitionIds: memberships.map((m) => m.competition_id),
      divisionIds: memberships.map((m) => m.division_id),
      fixtureIds,
    },
    { personIds, ...context },
    peersExpired,
  );
}

/**
 * Drop the public REDIS documents that print names from these scopes (final
 * review I2): each competition's hub (`pub:v1:hub:{id}`, 15s), each division's
 * schedule, standings and entrants (`publicDivisionCacheKeys`, 30s), and each
 * fixture's match-centre document (`publicFixtureCacheKey`, 30s). A tag
 * reaches none of them, so without this a consent OFF or a name-policy change
 * kept serving the old name to every poll until the TTL ran out. The same keys
 * a score (`invalidatePublicCache`), a schedule write (`afterScheduleWrite`)
 * and a stats refresh drop. All by name, in one DEL: never a keyspace SCAN
 * (review r2-m4), since a person write can be a photo upload or one row of an
 * API roster sync.
 *
 * TWICE (review r2-m1). The first DEL runs now, mid-request. But the tags the
 * caller fired reach this machine only at the flush after the handler resolves,
 * and other machines only when `peersExpired` (the caller's "expire" broadcast)
 * lands. A poll in that gap rebuilds the document from a data entry not yet
 * expired and bakes the old name back for its TTL. So the same DEL runs again
 * in the after-window (`deferred`: after the response, so after the flush),
 * once the broadcast has settled. It never rejects and is bounded by the
 * broadcast's own per-peer timeout.
 *
 * Not awaited: ioredis has no command timeout (`PUSH_AFTER_DELETE_BOUND_MS`),
 * so an unanswering Redis must not hold the organiser's request. Never
 * rejects: a failure is logged and the committed write stands.
 */
export function dropNamedPublicDocuments(
  scope: { competitionIds: readonly string[]; divisionIds: readonly string[]; fixtureIds: readonly string[] },
  context: Record<string, unknown>,
  peersExpired: Promise<unknown> = Promise.resolve(),
): void {
  const keys = [
    ...[...new Set(scope.competitionIds)].map((id) => `pub:v1:hub:${id}`),
    ...[...new Set(scope.divisionIds)].flatMap(publicDivisionCacheKeys),
    ...[...new Set(scope.fixtureIds)].map(publicFixtureCacheKey),
  ];
  if (keys.length === 0) return;
  const drop = () =>
    void cacheDel(...keys).catch((err: unknown) => {
      log.warn({ err, keys, ...context }, "public documents: a Redis delete failed (the write stands)");
    });
  drop();
  deferred(async () => {
    await peersExpired;
    drop();
  });
}

/** A SCORE write — `invalidatePublicCache` (usecases/scoring.ts) — and a
 *  division NAME-POLICY change (`patchDivision`, final review I2), which needs
 *  exactly the same two tags: a route rebuilding a dropped Redis document must
 *  not read a stale `pub-div-v3` and bake the old names back in. The division tag EXPIRES (`{ expire: 0 }`, not 'max') for the reason
 *  `fireOrgRevalidate` below gives: 'max' keeps serving the previous render
 *  while the rebuild runs (same SWR mechanism; measured once, for the
 *  consent-OFF pages — a few seconds and several loads, see
 *  `firePersonRevalidate` — never for a score write), and the reads that follow a score are
 *  read-your-own-writes (the smoke hub champion check reads a single time; a
 *  realtime push triggers one refresh). Every spectator
 *  entry a score changes carries the division tag: `pub-div-v3`,
 *  `pub-fixture-v3` and `pub-hub-v3` carry their own division's, and the
 *  player card's `pub-player-v17` carries every division of its competition,
 *  because its match lines can come from any of them (final review I1). An
 *  expired tag beats a stale one on an entry carrying both. The competition
 *  tag keeps SWR. Cost accepted: the first reader after
 *  a score rebuilds instead of getting a stale answer immediately.
 *
 *  ORDER IS LOAD-BEARING: competition 'max' first, division expiry second. A
 *  flush groups its tags by profile in first-seen order and Next's tag
 *  manifest is last-write-wins, so a 'max' for the same division fired later
 *  in the same request (`completeStage`'s voided `fireStageRevalidate`, reached
 *  from scoreEvent's auto-advance) joins the already-open 'max' group and can
 *  no longer overwrite the expiry. */
export function fireScoreRevalidate(divisionId: string, competitionId: string): Promise<void> {
  try {
    revalidateTag(competitionTag(competitionId), "max");
    revalidateTag(divisionTag(divisionId), { expire: 0 });
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  const peersExpired = broadcastRevalidate([divisionTag(divisionId)], "expire");
  void broadcastRevalidate([competitionTag(competitionId)], "swr");
  void purgeCdn();
  // Settles when the division's expiry has been sent to every peer; never
  // rejects. Nothing need wait on it: `patchDivision` hands it to
  // `dropNamedPublicDocuments` (review r2-m1).
  return peersExpired;
}

/** A player-stats refresh landed (`player-stats-refresh.ts`). The same two tags
 *  and the same effect as `fireScoreRevalidate` — competition stale-while-
 *  revalidate, division expired — but it runs inside `after()`, and there the
 *  score request's own profiles would be DROPPED without a sound:
 *
 *  Next's flush never clears `workStore.pendingRevalidatedTags`. `revalidateTag`
 *  skips a tag whose tag AND profile are already on that list, and
 *  `AfterContext.runCallbacks` flushes only the entries its callbacks ADDED,
 *  keyed `tag:profile` (node_modules/next/dist/server/revalidation-utils.js
 *  `diffRevalidationState`, web/spec-extension/revalidate.js). The score
 *  request already put `competition:x "max"` and `division:y {"expire":0}` on
 *  it, so repeating either call from the after-task adds nothing and flushes
 *  nothing, and a hub document rebuilt between the score and the fold stays
 *  cached with the old leaders.
 *
 *  So these profiles are spelled differently and mean the same thing:
 *  `revalidateTags` reads only `expire` from a profile, and "max" is
 *  `expire: 31536000` in Next's defaults (`config-shared` `cacheLife.max`),
 *  which `next.config.js` does not override. If it ever does, this number has
 *  to follow: `player-stats-refresh-after.test.ts` loads the app's RESOLVED
 *  config and fails when the two differ, and drives both profiles through
 *  Next's real AfterContext and tag manifest. */
export const STATS_REFRESH_COMPETITION_PROFILE = { revalidate: 0, expire: 31_536_000 } as const;
export const STATS_REFRESH_DIVISION_PROFILE = { revalidate: 0, expire: 0 } as const;

/** False when Next REFUSED the tags: the call ran inside a cache scope
 *  (`unstable_cache`, "use cache") or a render, where `revalidateTag` throws
 *  (E306, E7) and nothing is cleared (final review m7). The caller owns the
 *  retry. True when the tags were registered, or when there is no Next scope
 *  at all (E263: tests, scripts), where there is nothing to invalidate. */
export function fireStatsRevalidate(divisionId: string, competitionId: string): boolean {
  let registered = true;
  try {
    // Same order as fireScoreRevalidate, for the same reason.
    revalidateTag(competitionTag(competitionId), { ...STATS_REFRESH_COMPETITION_PROFILE });
    revalidateTag(divisionTag(divisionId), { ...STATS_REFRESH_DIVISION_PROFILE });
  } catch (err) {
    registered = (err as { __NEXT_ERROR_CODE?: unknown } | null)?.__NEXT_ERROR_CODE === "E263";
  }
  void broadcastRevalidate([divisionTag(divisionId)], "expire");
  void broadcastRevalidate([competitionTag(competitionId)], "swr");
  void purgeCdn();
  return registered;
}

/** Org chrome changes (name, logo, brand color) show on every page of the
 *  org's public tree — bust the whole org tag. `{ expire: 0 }`, NOT 'max':
 *  'max' is stale-while-revalidate, so the organiser's very next look at
 *  their public page would still show the old chrome (exactly the smoke
 *  failure "pro org landing carries the org color"). Chrome edits are
 *  read-your-own-writes; scoring pages keep SWR above. */
export function fireOrgRevalidate(orgSlug: string): void {
  try {
    revalidateTag(orgTag(orgSlug), { expire: 0 });
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate([orgTag(orgSlug)], "expire");
  void purgeCdn();
}

/** Fire the shared discovery ISR tag (doc 15, PROMPT-19): home strips,
 *  /discover and the per-sport pages — on opt-in/out, staff curation and
 *  fixture-decided writes of discoverable competitions. */
export function fireDiscoveryRevalidate(): void {
  try {
    revalidateTag(DISCOVERY_TAG, "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate([DISCOVERY_TAG], "swr");
  void purgeCdn();
}

/** News post status flips (publish/archive/republish/delete): the post page
 *  is route-level ISR (revalidate 30) with no fetch tags, so purge by PATH.
 *  Archive must read-your-own-writes — the organiser (and the smoke test)
 *  checks the public page right after clicking; a 30s stale 200 on a post
 *  they just pulled reads as a bug. Peers aren't broadcast (tag-based rail
 *  only) — cross-instance staleness stays bounded by the 30s ISR window. */
export function firePostRevalidate(orgSlug: string, postSlug: string): void {
  try {
    revalidatePath(`/shared/${orgSlug}/news/${postSlug}`);
    revalidatePath(`/shared/${orgSlug}/news`);
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void purgeCdn();
}

/** Redis layer in front of GET /api/v1/public/discovery (doc 15 §4). */
export async function invalidateDiscoveryCache(): Promise<void> {
  await cacheDelPattern("pub:v1:discovery:*");
}
