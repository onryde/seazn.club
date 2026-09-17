import "server-only";
// SPEC-2 / PROMPT-83 — server-side view helpers for the public news surfaces.
// Two jobs: (1) confine a post's hero image to the org's OWN public-storage
// prefix before it ever reaches an <img src> (SECURITY: org-authored value on a
// public page — never trust it as an external/data: URL), and (2) best-effort
// resolve the two crests for a result post's scorebug from its linked fixture.
import { sql } from "@/lib/db";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { publicStorageUrl } from "@/lib/storage-url";
import { maskPublicEntrantNames } from "@/server/public-site/data";
import type { OrgPost } from "@/server/usecases/org-posts";
import type { ScorebugSide } from "@/components/news/post-scorebug";

/** The public-URL prefix under which THIS org's uploads live (content-upload
 *  route: `orgs/{id}/content/…`). Exposed for the pure guard below. */
export function orgAssetPrefix(orgId: string, supabaseUrl: string): string {
  return `${supabaseUrl}/storage/v1/object/public/assets/orgs/${orgId}/`;
}

/**
 * Resolve a stored `hero_image_path` to a safe render URL, or null. Pure (env
 * injected) so it unit-tests the security guard directly. Accepts either a full
 * public URL already under this org's assets prefix, or a bare storage path
 * (`orgs/{orgId}/…`) which we build the URL for. ANYTHING else — an external
 * host, a `data:` URI, another org's path — resolves to null (no hero, fall back
 * to the scorebug/title). NEVER interpolate the raw value into an <img>.
 */
export function safeOrgHeroUrl(
  heroImagePath: string | null | undefined,
  orgId: string,
  supabaseUrl: string,
): string | null {
  const v = heroImagePath?.trim();
  if (!v || !supabaseUrl) return null;
  if (v.startsWith(orgAssetPrefix(orgId, supabaseUrl))) return v;
  if (v.startsWith(`orgs/${orgId}/`)) return `${supabaseUrl}/storage/v1/object/public/assets/${v}`;
  return null;
}

/** Env-reading wrapper used by the pages. */
export function postHeroUrl(post: Pick<OrgPost, "heroImagePath" | "orgId">): string | null {
  return safeOrgHeroUrl(post.heroImagePath, post.orgId, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

export interface PostSides {
  home: ScorebugSide;
  away: ScorebugSide;
}

interface SideRow {
  home_id: string | null;
  away_id: string | null;
  home_kind: string | null;
  away_kind: string | null;
  home_name: string | null;
  away_name: string | null;
  home_badge: string | null;
  away_badge: string | null;
  home_team: { logo_path: string | null } | null;
  away_team: { logo_path: string | null } | null;
  youth: boolean;
  player_name_display: string | null;
}

/**
 * Best-effort crest pair for a result post's scorebug, from its linked fixture's
 * two entrants (badge → team logo → null; the scorebug renders a monogram on
 * null). Any hiccup (no fixture id, view miss, error) yields null — the caller
 * then falls back to parseScoreline names + monograms. Never throws.
 *
 * The names REPLACE the ones parsed from the title, and a singles or pairs
 * entrant's display name is a person's name. So they go through the same
 * `maskPublicEntrantNames` pass as the division page, under the fixture's own
 * division policy (privacy hotfix, 2026-09-16): a youth result must not print
 * a full name the division page masks.
 */
export async function resolvePostSides(post: OrgPost): Promise<PostSides | null> {
  const fixtureId = post.kind === "result" ? post.autoSource?.fixture_id : undefined;
  if (!fixtureId) return null;
  try {
    const [row] = await sql<SideRow[]>`
      select h.id as home_id, a.id as away_id, h.kind as home_kind, a.kind as away_kind,
             h.display_name as home_name, a.display_name as away_name,
             h.badge_url as home_badge, a.badge_url as away_badge,
             h.team_display as home_team, a.team_display as away_team,
             d.youth, d.player_name_display
      from public_fixtures_v f
      join divisions d on d.id = f.division_id
      left join public_entrants_v h on h.id = f.home_entrant_id
      left join public_entrants_v a on a.id = f.away_entrant_id
      where f.id = ${fixtureId}`;
    if (!row || !row.home_id || !row.away_id || !row.home_kind || !row.away_kind || !row.home_name || !row.away_name) {
      return null;
    }
    const [home, away] = await maskPublicEntrantNames(
      [
        { id: row.home_id, kind: row.home_kind, display_name: row.home_name },
        { id: row.away_id, kind: row.away_kind, display_name: row.away_name },
      ],
      { youth: row.youth, player_name_display: row.player_name_display },
    );
    return {
      home: {
        name: home!.display_name,
        crest: resolveEntrantBadge({
          badge_url: row.home_badge,
          team_logo_path: row.home_team?.logo_path ?? null,
        }),
      },
      away: {
        name: away!.display_name,
        crest: resolveEntrantBadge({
          badge_url: row.away_badge,
          team_logo_path: row.away_team?.logo_path ?? null,
        }),
      },
    };
  } catch {
    return null;
  }
}

/**
 * The "related competition" card target for a competition-scoped post — name +
 * slug, only when the competition is publicly reachable (public|unlisted, the
 * same guard the post itself passed). Null for org-level posts or private comps.
 */
export async function relatedCompetition(
  post: OrgPost,
): Promise<{ name: string; slug: string } | null> {
  if (!post.competitionId) return null;
  try {
    const [row] = await sql<{ name: string; slug: string }[]>`
      select name, slug from competitions
      where id = ${post.competitionId} and visibility in ('public','unlisted')`;
    return row ?? null;
  } catch {
    return null;
  }
}

// re-export for the pages so they resolve URLs through this one module
export { publicStorageUrl };
