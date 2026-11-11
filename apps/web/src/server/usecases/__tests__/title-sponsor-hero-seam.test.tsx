// Title sponsor poster, Task 5: the SEAM between the real producer and the real consumer (AGENTS.md failure class 1, the inert seam).
// Spec: docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §7.1, §9.
//
// Every other test of the hero's poster feeds `TitleSponsorPanel` / `TitleSponsorBand` a hand-typed `ResolvedSponsor`, and the page test
// mocks `resolveSponsors` at the usecase boundary. Both ends of a fixture prove the fixture: a resolver that stopped returning `poster`
// (or named it differently) would leave every one of them green while the panel quietly drew no poster. So this drives the REAL path:
//   the write usecases -> the `sponsors` table -> `resolveSponsors` (the exact call the competition page makes) -> the panel and band
//   components -> the markup, and reads the poster's URL back out of that markup. The sequence matters as much as the happy path:
//   a poster removed AFTER it was shown must fall back to the logo card on the next read, and a free org must get nothing at all.
//
// Sport-agnostic: no sport sweep, one reason, stated once. Real Postgres required (skipped without DATABASE_URL, like every DB suite
// under src/server; this file lives there so the smoke-db job selects it by path).
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import en from "@/dictionaries/en/public.json";
import { TitleSponsorBand, TitleSponsorPanel, hasTitleSponsor } from "@/components/public-site/sponsors-board";
import type { Dict } from "@/lib/i18n-constants";
import { createCompetition } from "../competitions";
import { createSponsor, patchSponsor, resolveSponsors } from "../sponsors";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The values this file wrote: the expected markup is built from THESE, never from anything the resolver returned. */
const POSTER = "https://cdn.example/storage/v1/object/public/assets/orgs/o/content/cup-title.png";
const LOGO = "https://cdn.example/storage/v1/object/public/assets/orgs/o/content/org-title-logo.png";
const SITE = { source: "site" } as const;

/** What the competition page does: resolve, then hand the WHOLE list to each component. */
async function drawHero(orgId: string, competitionId: string, tiered: boolean) {
  const sponsors = await resolveSponsors(orgId, competitionId, { tiered });
  const props = { sponsors, tiered, dict: en as Dict, clickTag: SITE };
  return {
    hasTitle: hasTitleSponsor(sponsors, tiered),
    panel: renderToStaticMarkup(<TitleSponsorPanel {...props} />),
    band: renderToStaticMarkup(<TitleSponsorBand {...props} />),
  };
}

describe.skipIf(!HAS_DB)("the hero's poster, driven from the real resolver", () => {
  it("empty first: a competition with no title sponsor draws neither the panel nor the band", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Bare Cup", visibility: "public", branding: {} });
    await createSponsor(auth, { name: "Only Gold", tier: "gold", status: "active", poster_path: POSTER });

    const none = await drawHero(auth.orgId, comp.id, true);
    expect(none.hasTitle).toBe(false);
    expect(none.panel).toBe("");
    expect(none.band).toBe("");
  });

  it("a title sponsor's poster written through the usecase reaches the panel and the band, and a removed poster falls back to the logo card on the next read", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Seam Cup", visibility: "public", branding: {} });
    const gold = await createSponsor(auth, { name: "Harbour Motors", tier: "gold", status: "active", poster_path: POSTER });
    // Two title rows: a competition-scoped one with a poster and a link, and an org-wide one with a logo, no poster and NO link.
    const scoped = await createSponsor(auth, {
      name: "Cup Title", tier: "title", status: "active", competition_id: comp.id, url: "https://cup-title.example", poster_path: POSTER,
    });
    const orgWide = await createSponsor(auth, { name: "Org Title", tier: "title", status: "active", logo_path: LOGO });

    const shown = await drawHero(auth.orgId, comp.id, true);
    expect(shown.hasTitle).toBe(true);
    // The poster the row stores is the poster the panel asks the optimiser for: the field's name agrees at both ends.
    expect(shown.panel).toContain(`/_next/image?url=${encodeURIComponent(POSTER)}`);
    expect(shown.band).toContain(`/_next/image?url=${encodeURIComponent(POSTER)}`);
    // Both title rows are slides, the competition-scoped one first (the resolver's order), each carrying the ROW'S OWN id.
    expect([...shown.panel.matchAll(/data-sponsor-id="([^"]+)"/g)].map((m) => m[1])).toEqual([scoped.id, orgWide.id]);
    // The link is the tracked redirect to the scoped row only: the org-wide row gave no url, so it is no anchor.
    expect(shown.panel).toContain(`href="/s/${scoped.id}?src=site"`);
    expect(shown.panel).not.toContain(`/s/${orgWide.id}`);
    expect(shown.panel.match(/<a\b/g), "anchors in the panel").toHaveLength(1);
    // The org-wide row has no poster: its slide is the logo card, with the stored logo.
    expect(shown.panel).toContain(`/_next/image?url=${encodeURIComponent(LOGO)}`);
    expect(shown.panel).toContain('data-testid="title-slide-fallback"');
    // The sentence names the sponsor, whole, and gold is nowhere in either placement.
    expect(shown.band).toContain("Presented by Cup Title");
    expect(shown.band).toContain("Presented by Org Title");
    for (const markup of [shown.panel, shown.band]) {
      expect(markup).not.toContain(gold.id);
      expect(markup).not.toContain("Harbour Motors");
    }

    // The sequence: the organiser removes the poster, and the very next read draws the card where the poster was.
    await patchSponsor(auth, scoped.id, { poster_path: null });
    const removed = await drawHero(auth.orgId, comp.id, true);
    expect(removed.panel, "the removed poster is no longer asked for").not.toContain(encodeURIComponent(POSTER));
    expect(removed.band).not.toContain(encodeURIComponent(POSTER));
    expect(removed.panel.match(/data-testid="title-slide-fallback"/g), "both slides are cards now").toHaveLength(2);
    // The scoped row has no logo either, so its card is the monogram; the link is untouched by the poster's removal.
    expect(removed.panel).toContain('data-testid="title-slide-monogram"');
    expect(removed.panel).toContain(`href="/s/${scoped.id}?src=site"`);
  });

  it("a free org holding a title row gets neither placement, and is not asked for the poster", async () => {
    const { auth } = await seedOrg("pro");
    authState.userId = auth.userId!;
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Lapsed Cup", visibility: "public", branding: {} });
    await createSponsor(auth, { name: "Lapsed Title", tier: "title", status: "active", poster_path: POSTER });

    // The org's plan lapsed: the page asks `resolveSponsors` with `tiered: false` and hands the same answer to every component.
    const lapsed = await drawHero(auth.orgId, comp.id, false);
    expect(lapsed.hasTitle).toBe(false);
    expect(lapsed.panel).toBe("");
    expect(lapsed.band).toBe("");
    // The twin: the same row, tiered, IS a placement, so the three lines above are the gate and not an empty table.
    expect((await drawHero(auth.orgId, comp.id, true)).panel).toContain(encodeURIComponent(POSTER));
  });
});
