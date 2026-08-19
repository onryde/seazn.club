// P9 review finding #14 (2026-08-18): public-site/data.ts's own
// withCourtVenueNames selected the BARE crt.name for court_name. Two
// venues may legally each name one "Court 1" (courts_venue_name_active_idx
// only scopes uniqueness WITHIN a venue), so the public page showed two
// identical "Court 1" entries for two different courts while the board
// (which already routes through lib/court-directory.ts's
// buildCourtDirectory) showed "Court 1 (Riverside)" for the same
// fixtures. Fixed by routing court_name through that SAME buildCourtDirectory
// rule, resolved org-wide (see withCourtVenueNames's own doc comment for
// why org-wide rather than scoped to whatever batch happened to be
// queried).
//
// unstable_cache is a Next server-runtime API — passthrough under vitest,
// the same double this directory's own pass-scope-public-realtime.test.ts
// and player-stats-public.test.ts already use. Real Postgres required;
// skipped without DATABASE_URL. Rows are inserted directly rather than
// through the venues/stages usecases — the point is the venue/court
// derivation, not the scheduling engine (same reasoning
// pass-scope-public-realtime.test.ts gives for its own seed).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { getPublicDivision, getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Seeded {
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  fixtureAlphaId: string; // Court 1 @ Alpha Sports Hall
  fixtureBetaId: string; // Court 1 @ Beta Arena — same bare name, different venue
  alphaVenueName: string;
  betaVenueName: string;
}

/** A public, live division with two venues that legally share a court name,
 *  and one fixture scheduled onto each (court_id/venue_id set, the frozen
 *  venue/court_label columns left null — nothing writes them post-cutover). */
async function seed(): Promise<Seeded> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "dcv-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"DCV Org " + s}, ${orgSlug}) returning id`;
  const compSlug = "dcv-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"DCV Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "open-" + s;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active', '{}', '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divId}, 'league', 'League', 1) returning id`;

  const alphaVenueName = "Alpha Sports Hall " + s;
  const betaVenueName = "Beta Arena " + s;
  const [{ id: alphaVenueId }] = await sql<{ id: string }[]>`
    insert into venues (org_id, name) values (${orgId}, ${alphaVenueName}) returning id`;
  const [{ id: betaVenueId }] = await sql<{ id: string }[]>`
    insert into venues (org_id, name) values (${orgId}, ${betaVenueName}) returning id`;
  const [{ id: alphaCourtId }] = await sql<{ id: string }[]>`
    insert into courts (venue_id, org_id, name) values (${alphaVenueId}, ${orgId}, 'Court 1') returning id`;
  const [{ id: betaCourtId }] = await sql<{ id: string }[]>`
    insert into courts (venue_id, org_id, name) values (${betaVenueId}, ${orgId}, 'Court 1') returning id`;

  const [{ id: fixtureAlphaId }] = await sql<{ id: string }[]>`
    insert into fixtures
      (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round, court_id, venue_id)
    values (${orgId}, ${divId}, ${stageId}, 1, 1, 1, ${alphaCourtId}, ${alphaVenueId})
    returning id`;
  const [{ id: fixtureBetaId }] = await sql<{ id: string }[]>`
    insert into fixtures
      (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round, court_id, venue_id)
    values (${orgId}, ${divId}, ${stageId}, 2, 1, 2, ${betaCourtId}, ${betaVenueId})
    returning id`;

  return { orgSlug, compSlug, divSlug, fixtureAlphaId, fixtureBetaId, alphaVenueName, betaVenueName };
}

interface SeededSetup {
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divId: string;
  fixtureId: string;
  venueName: string;
  courtName: string;
}

/**
 * A division in 'setup' status with ONE fixture that already carries a real
 * court_id/venue_id. The redaction that used to be driven by a
 * caller-supplied `divisionStatus` argument is now decided by a `divisions`
 * join INSIDE withCourtVenueNames/withCourtVenueName itself, so it needs
 * its own proof independent of the disambiguation tests above — a fixture
 * with no court/venue set would pass this whether or not the redaction
 * still works.
 */
async function seedSetupRedaction(): Promise<SeededSetup> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "dcv-setup-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"DCV Setup Org " + s}, ${orgSlug}) returning id`;
  const compSlug = "dcv-setup-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"DCV Setup Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "setup-" + s;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Setup Division', ${divSlug}, 'generic', 'score', 'setup', '{}', '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divId}, 'league', 'League', 1) returning id`;
  const venueName = "Setup Venue " + s;
  const courtName = "Setup Court " + s;
  const [{ id: venueId }] = await sql<{ id: string }[]>`
    insert into venues (org_id, name) values (${orgId}, ${venueName}) returning id`;
  const [{ id: courtId }] = await sql<{ id: string }[]>`
    insert into courts (venue_id, org_id, name) values (${venueId}, ${orgId}, ${courtName}) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures
      (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round, court_id, venue_id)
    values (${orgId}, ${divId}, ${stageId}, 1, 1, 1, ${courtId}, ${venueId})
    returning id`;
  return { orgSlug, compSlug, divSlug, divId, fixtureId, venueName, courtName };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)(
  "getPublicDivision / getPublicFixture — court_name disambiguation (P9 review #14)",
  () => {
    it("the schedule page shows two same-named courts in different venues as distinguishable entries", async () => {
      const seeded = await seed();
      const page = await getPublicDivision(seeded.orgSlug, seeded.compSlug, seeded.divSlug);
      expect(page).not.toBeNull();
      const alpha = page!.fixtures.find((f) => f.id === seeded.fixtureAlphaId);
      const beta = page!.fixtures.find((f) => f.id === seeded.fixtureBetaId);
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha!.venue).toBeNull();
      expect(alpha!.court_label).toBeNull();
      expect(alpha!.venue_name).toBe(seeded.alphaVenueName);
      expect(beta!.venue_name).toBe(seeded.betaVenueName);
      // The actual bug: both used to read the bare "Court 1" for both rows.
      expect(alpha!.court_name).not.toBe(beta!.court_name);
      expect(alpha!.court_name).toBe(`Court 1 (${seeded.alphaVenueName})`);
      expect(beta!.court_name).toBe(`Court 1 (${seeded.betaVenueName})`);
    });

    it("the live match page resolves the same disambiguated name for a single fixture", async () => {
      const seeded = await seed();
      const alphaPage = await getPublicFixture(
        seeded.orgSlug,
        seeded.compSlug,
        seeded.divSlug,
        seeded.fixtureAlphaId,
      );
      const betaPage = await getPublicFixture(
        seeded.orgSlug,
        seeded.compSlug,
        seeded.divSlug,
        seeded.fixtureBetaId,
      );
      expect(alphaPage).not.toBeNull();
      expect(betaPage).not.toBeNull();
      // A single-fixture read (no sibling fixture in the SAME query) still
      // resolves the org-wide disambiguated label, not the bare name.
      expect(alphaPage!.fixture.court_name).toBe(`Court 1 (${seeded.alphaVenueName})`);
      expect(betaPage!.fixture.court_name).toBe(`Court 1 (${seeded.betaVenueName})`);
      expect(alphaPage!.fixture.court_name).not.toBe(betaPage!.fixture.court_name);
    });

    it("getPublicDivision redacts venue_name/court_name for a setup division, then reveals them once active", async () => {
      const seeded = await seedSetupRedaction();
      const setupPage = await getPublicDivision(seeded.orgSlug, seeded.compSlug, seeded.divSlug);
      expect(setupPage).not.toBeNull();
      const setupFixture = setupPage!.fixtures.find((f) => f.id === seeded.fixtureId);
      expect(setupFixture).toBeDefined();
      expect(setupFixture!.venue_name).toBeNull();
      expect(setupFixture!.court_name).toBeNull();

      await sql`update divisions set status = 'active' where id = ${seeded.divId}`;
      const activePage = await getPublicDivision(seeded.orgSlug, seeded.compSlug, seeded.divSlug);
      const activeFixture = activePage!.fixtures.find((f) => f.id === seeded.fixtureId);
      expect(activeFixture!.venue_name).toBe(seeded.venueName);
      expect(activeFixture!.court_name).toBe(seeded.courtName);
    });

    it("getPublicFixture redacts venue_name/court_name for a setup division, then reveals them once active", async () => {
      const seeded = await seedSetupRedaction();
      const setupPage = await getPublicFixture(
        seeded.orgSlug,
        seeded.compSlug,
        seeded.divSlug,
        seeded.fixtureId,
      );
      expect(setupPage).not.toBeNull();
      expect(setupPage!.fixture.venue_name).toBeNull();
      expect(setupPage!.fixture.court_name).toBeNull();

      await sql`update divisions set status = 'active' where id = ${seeded.divId}`;
      const activePage = await getPublicFixture(
        seeded.orgSlug,
        seeded.compSlug,
        seeded.divSlug,
        seeded.fixtureId,
      );
      expect(activePage!.fixture.venue_name).toBe(seeded.venueName);
      expect(activePage!.fixture.court_name).toBe(seeded.courtName);
    });
  },
);
