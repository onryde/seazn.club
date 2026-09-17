import "server-only";
// ISR invalidation for the public dashboard (doc 09 §3): the SAME service-
// layer writes that publish realtime fire these tags. Fire-and-forget — a
// failed revalidation must never roll back a scoring write, and unit tests
// call use-cases outside a request scope where revalidateTag would throw.
import { revalidatePath, revalidateTag } from "next/cache";
import { sql } from "@/lib/db";
import { cacheDelPattern } from "@/lib/cache";
import { broadcastRevalidate } from "@/lib/peer-revalidate";
import { purgeCdn } from "@/lib/cdn-purge";
import { log } from "@/server/logger";
import { divisionTag, competitionTag, orgTag, personTag, DISCOVERY_TAG } from "./data";

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
 *   - the division and competition tags of every division they are rostered
 *     in, deduped, stale-while-revalidate ('max') — the tags the player's
 *     consent write has always fired: the entries that mask their name for
 *     others (`pub-div`, `pub-fixture`, and other players' cards through
 *     `pub-player-v16`), and the pages built on them. 'max' serves the
 *     PREVIOUS render while the background rebuild runs. Measured after a
 *     consent OFF (spectator W2, 2026-09-17): those pages kept serving the
 *     previous render for a few seconds — 2.8–4.3s, 2–3 loads — in a local
 *     prod build at a machine load average of 16–40, and in that window the
 *     match page can briefly show the full name and the masked name together
 *     (MEASURED: seen on the page; the likely cause, INFERRED, is one of its
 *     data entries rebuilt and another not yet). Owner ruling 2026-09-17:
 *     that window is accepted, no behaviour change. The person's own card is
 *     not in it: its tag EXPIRES (above).
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
  let scopeTags: string[] = [];
  try {
    const memberships = await sql<{ division_id: string; competition_id: string }[]>`
      select distinct e.division_id, d.competition_id
      from entrant_members em
      join entrants e on e.id = em.entrant_id
      join divisions d on d.id = e.division_id
      where em.person_id in ${sql([...personIds])}`;
    scopeTags = [
      ...new Set(memberships.flatMap((m) => [divisionTag(m.division_id), competitionTag(m.competition_id)])),
    ];
  } catch (err) {
    log.error(
      { err, personIds, ...context },
      "public pages: a person's rosters could not be read to revalidate the pages naming them (the write stands)",
    );
  }
  try {
    for (const tag of personTags) revalidateTag(tag, { expire: 0 });
    for (const tag of scopeTags) revalidateTag(tag, "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate(personTags, "expire");
  void broadcastRevalidate(scopeTags, "swr");
  void purgeCdn();
}

/** A SCORE write — `invalidatePublicCache` (usecases/scoring.ts) is the only
 *  caller. The division tag EXPIRES (`{ expire: 0 }`, not 'max') for the reason
 *  `fireOrgRevalidate` below gives: 'max' keeps serving the previous render
 *  while the rebuild runs (same SWR mechanism; measured once, for the
 *  consent-OFF pages — a few seconds and several loads, see
 *  `firePersonRevalidate` — never for a score write), and the reads that follow a score are
 *  read-your-own-writes (the smoke hub champion check reads a single time; a
 *  realtime push triggers one refresh). Every spectator
 *  entry a score changes carries the division tag (`pub-div`, `pub-fixture`,
 *  `pub-hub-v2`), and an expired tag beats a stale one on an entry carrying
 *  both. The competition tag keeps SWR. Cost accepted: the first reader after
 *  a score rebuilds instead of getting a stale answer immediately.
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
