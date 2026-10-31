import "server-only";
// server/sponsors/card-source.ts — R4 sponsors on stream, S5: the content seam (spec 2026-10-27 §3.3). What a sponsor
// card shows comes from a `SponsorCardSource`; the MVP's reads the `sponsors` table, one card per sponsor.
//
// THE CARD ID IS THE SPONSOR ID (S8's contract): proof of play resolves a scene airing's sponsor from the card id it
// logged (`sponsorIdOfCard`, server/sponsors/airings.ts), so every card made here carries `id === sponsorId`. One maker,
// `sponsorCardOf`, for both of the planner's lists (the ticked cards here, the assigned cards in assign.ts).
//
// ORDER AND DEDUPE are `resolveSponsors`' (usecases/sponsors.ts) — called, never restated (preflight (e)5): competition
// rows first, then tier rank, display order, created_at, id, deduped by name, active only. This only narrows its answer
// to the rows ticked onto the stream (`on_stream`, V483).
//
// TIERS (ruling R13, D8): an org without `sponsors.tiers` gets every card as `partner`, exactly as its public board
// renders (`resolveSponsors({ tiered: false })`) — a downgraded org's leftover `title` row must not keep a title's weight
// in the rotation.
import { sql, type Tx } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import type { SponsorCard } from "@/lib/sponsor-plan";
import type { SponsorTier } from "@/lib/sponsor-tiers";
import { resolveSponsors } from "@/server/usecases/sponsors";

export interface SponsorCardSource {
  /** The TICKED cards for a fixture of this competition: active, `on_stream`, in `resolveSponsors` order. The rotation
   *  and the scene carousel draw on these only. */
  cardsFor(orgId: string, fixture: { competitionId: string | null }): Promise<SponsorCard[]>;
}

/** The `sponsors` columns a card is made of. */
export interface SponsorCardRow {
  id: string;
  name: string;
  logo_path: string | null;
  tier: SponsorTier;
  on_stream: boolean;
}

/** One sponsor row → its card. `logo_path` already holds the logo's public URL (the board renders it as an image src). */
export function sponsorCardOf(row: SponsorCardRow, tiered: boolean): SponsorCard {
  return {
    id: row.id,
    sponsorId: row.id,
    name: row.name,
    logoUrl: row.logo_path,
    tier: tiered ? row.tier : "partner",
    onStream: row.on_stream,
  };
}

/** Does this org's plan (or an Event Pass on this competition) carry sponsor tiers? The public board's own question. */
export function sponsorTiersOn(orgId: string, competitionId: string | null): Promise<boolean> {
  return hasFeature(orgId, "sponsors.tiers", competitionId ?? undefined);
}

/** The current card of each listed sponsor of this org, ticked or not, ACTIVE only: a pending (parked), inactive or
 *  deleted sponsor has none, so its assigned break airs nothing (controller ruling: such a sponsor never airs, not even
 *  on a frozen break). Order is not meaningful. */
export async function activeSponsorCards(
  exec: Tx | typeof sql,
  orgId: string,
  sponsorIds: readonly string[],
  tiered: boolean,
): Promise<SponsorCard[]> {
  if (sponsorIds.length === 0) return [];
  const rows = await exec<SponsorCardRow[]>`
    select id, name, logo_path, tier, on_stream from sponsors
     where org_id = ${orgId} and id = any(${sponsorIds as string[]}::uuid[]) and status = 'active'`;
  return rows.map((r) => sponsorCardOf(r, tiered));
}

export const sponsorsTableCardSource: SponsorCardSource = {
  async cardsFor(orgId, fixture) {
    const tiered = await sponsorTiersOn(orgId, fixture.competitionId);
    const resolved = await resolveSponsors(orgId, fixture.competitionId ?? undefined, { tiered });
    // A blob-shim entry (no `sponsors` row: id null) has nothing to tick, and so no card.
    const ids = resolved.flatMap((s) => (s.id === null ? [] : [s.id]));
    if (ids.length === 0) return [];
    const ticked = new Map(
      (await activeSponsorCards(sql, orgId, ids, tiered)).filter((c) => c.onStream).map((c) => [c.id, c]),
    );
    return ids.flatMap((id) => {
      const card = ticked.get(id);
      return card === undefined ? [] : [card];
    });
  },
};
