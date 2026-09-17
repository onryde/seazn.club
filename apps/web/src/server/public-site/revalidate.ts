import "server-only";
// ISR invalidation for the public dashboard (doc 09 §3): the SAME service-
// layer writes that publish realtime fire these tags. Fire-and-forget — a
// failed revalidation must never roll back a scoring write, and unit tests
// call use-cases outside a request scope where revalidateTag would throw.
import { revalidatePath, revalidateTag } from "next/cache";
import { cacheDelPattern } from "@/lib/cache";
import { broadcastRevalidate } from "@/lib/peer-revalidate";
import { purgeCdn } from "@/lib/cdn-purge";
import { divisionTag, competitionTag, orgTag, DISCOVERY_TAG } from "./data";

export { DISCOVERY_TAG };

export function fireDivisionRevalidate(divisionId: string, competitionId?: string): void {
  const tags = [divisionTag(divisionId), ...(competitionId ? [competitionTag(competitionId)] : [])];
  try {
    // Next 16 signature: second arg = stale-while-revalidate window ('max' =
    // serve stale while fresh regenerates — right for spectator pages).
    revalidateTag(tags[0], "max");
    if (competitionId) revalidateTag(competitionTag(competitionId), "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate(tags, "swr");
  void purgeCdn();
}

/** A SCORE write — `invalidatePublicCache` (usecases/scoring.ts) is the only
 *  caller. The division tag EXPIRES (`{ expire: 0 }`, not 'max') for the reason
 *  `fireOrgRevalidate` below gives: 'max' serves one more stale read, and the
 *  reads that follow a score are read-your-own-writes (the smoke hub champion
 *  check reads once; a realtime push triggers one refresh). Every spectator
 *  entry a score changes carries the division tag (`pub-div`, `pub-fixture`,
 *  `pub-hub-v2`), and an expired tag beats a stale one on an entry carrying
 *  both. The competition tag keeps SWR. Cost accepted: the first reader after
 *  a score rebuilds instead of getting a stale answer at once.
 *
 *  ORDER IS LOAD-BEARING: competition 'max' first, division expiry second. A
 *  flush groups its tags by profile in first-seen order and Next's tag
 *  manifest is last-write-wins, so a 'max' for the same division fired later
 *  in the same request (`completeStage`'s voided `fireStageRevalidate`, reached
 *  from scoreEvent's auto-advance) joins the already-open 'max' group and can
 *  no longer overwrite the expiry. */
export function fireScoreRevalidate(divisionId: string, competitionId: string): void {
  try {
    revalidateTag(competitionTag(competitionId), "max");
    revalidateTag(divisionTag(divisionId), { expire: 0 });
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate([divisionTag(divisionId)], "expire");
  void broadcastRevalidate([competitionTag(competitionId)], "swr");
  void purgeCdn();
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
