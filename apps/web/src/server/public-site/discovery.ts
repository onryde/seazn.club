import "server-only";
// Discovery read model for the marketing surfaces (doc 15 §2, PROMPT-19).
// Server Components only; every query starts from public_discovery_v (the
// consent/opt-in/block/quality filter is structurally unavoidable) and joins
// public_*_v views for live fixture info. Cached under the shared `discovery`
// ISR tag — revalidated on opt-in/out, staff curation and fixture-decided
// writes of discoverable competitions (see revalidate.ts).
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { DISCOVERY_TAG } from "./cache-tags";
import { REVALIDATE_FAST } from "./data";
import type { DiscoveryEntry } from "@/server/usecases/public";

export type { DiscoveryEntry };

export interface DiscoveryLiveFixture {
  id: string;
  sport_key: string;
  headline: string | null;
  /** "5v4" / "10v11" while a suspension runs (period-kernel sports) — the
   *  wall's power-play chip (v6/00 §5). */
  strength: string | null;
  competition_name: string;
  org_slug: string;
  comp_slug: string;
  division_slug: string;
}

/** The /live floodlit wall: every in-play fixture across discoverable
 *  competitions, page-sized cap. Summary comes from match_states via
 *  public_fixtures_v: render-agnostic score lines, never person data. */
export const getDiscoveryLiveAll = unstable_cache(
  async (): Promise<DiscoveryLiveFixture[]> => {
    const rows = await sql<
      (Omit<DiscoveryLiveFixture, "headline" | "strength"> & {
        summary: { headline?: string; detail?: { strength?: string | null } } | null;
      })[]
    >`
      select f.id, d.sport_key, f.summary,
             disc.name as competition_name, disc.org_slug,
             disc.slug as comp_slug, d.slug as division_slug
      from public_discovery_v disc
      join public_divisions_v d on d.competition_id = disc.id
      join public_fixtures_v f on f.division_id = d.id
      where f.status = 'in_play'
      order by f.scheduled_at nulls last, f.id
      limit 60`;
    return rows.map(({ summary, ...r }) => ({
      ...r,
      headline: summary?.headline ?? null,
      strength: summary?.detail?.strength ?? null,
    }));
  },
  ["discovery-live-all"],
  { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
);

export interface DirectoryFilters {
  sport?: string;
  country?: string;
  status?: "live" | "upcoming";
  q?: string;
}

/** /discover directory (doc 15 §2): filterable, searchable, ordered per doc
 *  15 §3 (featured → in-play → start proximity → entrant count). */
export async function getDiscoveryDirectory(
  filters: DirectoryFilters,
  limit = 48,
): Promise<DiscoveryEntry[]> {
  return unstable_cache(
    async () => {
      return sql<DiscoveryEntry[]>`
        select * from public_discovery_v
        where true
          ${filters.sport ? sql`and ${filters.sport} = any(sports)` : sql``}
          ${filters.country ? sql`and lower(country) = lower(${filters.country})` : sql``}
          ${filters.q ? sql`and (name ilike ${"%" + filters.q + "%"} or org_name ilike ${"%" + filters.q + "%"})` : sql``}
          ${
            filters.status === "live"
              ? sql`and in_play_count > 0`
              : filters.status === "upcoming"
                ? sql`and in_play_count = 0
                      and (starts_on >= current_date or next_fixture_at is not null)`
                : sql``
          }
        order by featured desc,
                 (in_play_count > 0) desc,
                 abs(extract(epoch from (coalesce(starts_on, current_date + 3650)::timestamp - now()))) asc,
                 entrant_count desc, id
        limit ${limit}`;
    },
    [
      "discovery-dir",
      filters.sport ?? "",
      filters.country ?? "",
      filters.status ?? "",
      filters.q ?? "",
      String(limit),
    ],
    { tags: [DISCOVERY_TAG], revalidate: REVALIDATE_FAST },
  )();
}

