import "server-only";
// The public read path's slug -> id LOOKUPS, cached in Redis (public hub perf
// T2, 2026-09-24), and the invalidators every write path that can change one
// calls.
//
// `publicCompetitionHub`, `publicPlayerMatches` and `publicOrgLive`
// (usecases/public.ts) are POLLED by every open spectator tab, and each poll
// used to resolve its slugs in Postgres before it ever looked at Redis. The
// answer only changes when one of these changes, and these are ALL the paths
// that change it (grep -a, 2026-09-24 — `update competitions` /
// `delete from competitions` / `update organizations` across apps, packages,
// scripts and services):
//
//   competition visibility or slug  `patchCompetition` (usecases/competitions.ts)
//   — the only writer of either; a name change regenerates the slug there too
//   competition deleted            `deleteCompetition` (same file)
//   org slug                       PATCH /api/orgs/[id] (the only writer)
//   org deleted                    nothing in the app deletes an org
//
// Each of them calls one of the two drops below after its commit. The key
// never holds a REFUSAL (a 404 is not cached), so a competition that turns
// public is served on the next poll with nothing to drop; and the TTL
// (`PUBLIC_REF_TTL_SECONDS`) is the backstop for a drop that failed — the
// same 15 s the hub document itself may be stale.
//
// A lookup is filled under a lease (lib/single-flight-cache.ts), so a lookup
// that read Postgres before a visibility write and finishes after that write's
// drop cannot put the pre-write answer back.
import { cacheDel } from "@/lib/cache";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";

/** The backstop on a missed drop — the hub document's own 15 s
 *  (`HUB_TTL_SECONDS`), so a lookup can never outlive what it fronts by more
 *  than the document could anyway. */
export const PUBLIC_REF_TTL_SECONDS = 15;

/** `{ id, org_id }` of a publicly readable competition (`public_competitions_v`). */
export function publicCompetitionRefKey(orgSlug: string, compSlug: string): string {
  return `pub:v1:comp-ref:${orgSlug}:${compSlug}`;
}

/** `{ id }` of the org answering to a slug. */
export function publicOrgRefKey(orgSlug: string): string {
  return `pub:v1:org-ref:${orgSlug}`;
}

/** A competition's visibility, slug or existence may have changed: drop its
 *  lookup under every slug it answered to (old and new, after a rename).
 *  Never throws — the write it follows has committed. */
export async function dropPublicCompetitionRefs(
  orgSlug: string,
  ...compSlugs: (string | null | undefined)[]
): Promise<void> {
  const keys = [...new Set(compSlugs.filter((s): s is string => Boolean(s)))].map((s) =>
    publicCompetitionRefKey(orgSlug, s),
  );
  if (keys.length === 0) return;
  await cacheDel(...keys).catch((err: unknown) => {
    log.error({ err, keys }, "public lookups: a Redis delete failed (the write stands)");
  });
}

/** An org's slug changed: drop its own lookup and every competition lookup
 *  keyed under the old AND the new slug. Never throws. */
export async function dropPublicOrgRefs(
  orgId: string,
  ...orgSlugs: (string | null | undefined)[]
): Promise<void> {
  const slugs = [...new Set(orgSlugs.filter((s): s is string => Boolean(s)))];
  if (slugs.length === 0) return;
  try {
    const comps = await sql<{ slug: string }[]>`
      select slug from competitions where org_id = ${orgId}`;
    const keys = slugs.flatMap((orgSlug) => [
      publicOrgRefKey(orgSlug),
      ...comps.map((c) => publicCompetitionRefKey(orgSlug, c.slug)),
    ]);
    await cacheDel(...keys);
  } catch (err) {
    log.error({ err, orgId, slugs }, "public lookups: dropping an org's lookups failed (the write stands)");
  }
}
