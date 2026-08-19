// P9 review findings #1/#2 (2026-08-18): publicSchedule/publicFixture
// (server/usecases/public.ts) still read venue/court_label off
// public_fixtures_v, whose V369 definition selects the FROZEN
// fixtures.venue/fixtures.court_label columns — nothing writes those any
// more since the venues/courts entities cutover (V367/V374), so every
// public API v1 consumer got null court and venue for a fixture scheduled
// after the cutover. Fixed by routing both through public-site/data.ts's
// withCourtVenueNames/withCourtVenueName (the same helper the HTML
// schedule page already used), which derives venue_name/court_name from
// fixtures.venue_id/court_id and disambiguates same-named courts across
// venues via lib/court-directory.ts's buildCourtDirectory.
//
// Real Postgres required; skipped without DATABASE_URL. Rows are inserted
// directly (not through the venues/stages usecases, mirroring
// public-site/__tests__/pass-scope-public-realtime.test.ts's own
// precedent for this exact read path) — the point here is the READ path's
// derivation, and a hand-seeded fixture with a real court_id/venue_id set
// (frozen venue/court_label left null) is exactly the post-cutover shape
// those usecases would otherwise produce indirectly.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { publicFixture, publicSchedule } from "../public";

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

/**
 * A public, live division with two venues that legally share a court name
 * ("Court 1") — `courts_venue_name_active_idx` only scopes uniqueness
 * within a venue — and one fixture scheduled onto each, post-cutover:
 * court_id/venue_id set, the frozen venue/court_label columns left null
 * (nothing writes them any more).
 */
async function seed(): Promise<Seeded> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "pcv-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"PCV Org " + s}, ${orgSlug}) returning id`;
  const compSlug = "pcv-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"PCV Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
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
 * court_id/venue_id. withCourtVenueNames/withCourtVenueName redact this the
 * same way public_fixtures_v's own view redacts venue/court_label for a
 * setup division (V369's `case when d.status = 'setup' then null else
 * f.venue end`) — except this redaction is decided by a `divisions` join
 * INSIDE the helper now, not a caller-supplied status, so it needs its own
 * proof independent of the "real names surface" tests above. A fixture
 * with no court/venue set would pass this whether or not the redaction
 * works, which is why one is seeded here.
 */
async function seedSetupRedaction(): Promise<SeededSetup> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "pcv-setup-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"PCV Setup Org " + s}, ${orgSlug}) returning id`;
  const compSlug = "pcv-setup-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"PCV Setup Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
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
  "publicSchedule / publicFixture — venue_name/court_name post-cutover (P9 review #1/#2)",
  () => {
    it("publicSchedule surfaces the real venue/court names, not the frozen null columns", async () => {
      const seeded = await seed();
      const out = (await publicSchedule(seeded.orgSlug, seeded.compSlug, seeded.divSlug)) as {
        fixtures: {
          id: string;
          venue: string | null;
          court_label: string | null;
          venue_name: string | null;
          court_name: string | null;
        }[];
      };
      const alpha = out.fixtures.find((f) => f.id === seeded.fixtureAlphaId);
      const beta = out.fixtures.find((f) => f.id === seeded.fixtureBetaId);
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      // The frozen legacy columns stay null — nothing writes them post-cutover.
      expect(alpha!.venue).toBeNull();
      expect(alpha!.court_label).toBeNull();
      expect(alpha!.venue_name).toBe(seeded.alphaVenueName);
      expect(beta!.venue_name).toBe(seeded.betaVenueName);
      // Two venues legally sharing a bare court name ("Court 1") must render
      // as distinguishable entries, not two identical "Court 1" strings.
      expect(alpha!.court_name).not.toBe(beta!.court_name);
      expect(alpha!.court_name).toBe(`Court 1 (${seeded.alphaVenueName})`);
      expect(beta!.court_name).toBe(`Court 1 (${seeded.betaVenueName})`);
    });

    it("publicFixture surfaces the real venue/court name for a single fixture, still disambiguated", async () => {
      const seeded = await seed();
      const alpha = (await publicFixture(seeded.fixtureAlphaId)) as {
        venue: string | null;
        court_label: string | null;
        venue_name: string | null;
        court_name: string | null;
      };
      const beta = (await publicFixture(seeded.fixtureBetaId)) as {
        venue_name: string | null;
        court_name: string | null;
      };
      expect(alpha.venue).toBeNull();
      expect(alpha.court_label).toBeNull();
      expect(alpha.venue_name).toBe(seeded.alphaVenueName);
      expect(alpha.court_name).toBe(`Court 1 (${seeded.alphaVenueName})`);
      // A single-fixture read (no sibling fixture in the SAME query) still
      // resolves the org-wide disambiguated label, not the bare name — this
      // is the property that makes the org-wide directory scope (rather
      // than one scoped to whatever batch happened to be queried) correct.
      expect(beta.court_name).toBe(`Court 1 (${seeded.betaVenueName})`);
      expect(alpha.court_name).not.toBe(beta.court_name);
    });

    it("publicSchedule redacts venue_name/court_name for a setup division, then reveals them once active (array form)", async () => {
      const seeded = await seedSetupRedaction();
      const setupOut = (await publicSchedule(seeded.orgSlug, seeded.compSlug, seeded.divSlug)) as {
        fixtures: { id: string; venue_name: string | null; court_name: string | null }[];
      };
      const setupFixture = setupOut.fixtures.find((f) => f.id === seeded.fixtureId);
      expect(setupFixture).toBeDefined();
      expect(setupFixture!.venue_name).toBeNull();
      expect(setupFixture!.court_name).toBeNull();

      await sql`update divisions set status = 'active' where id = ${seeded.divId}`;
      const activeOut = (await publicSchedule(seeded.orgSlug, seeded.compSlug, seeded.divSlug)) as {
        fixtures: { id: string; venue_name: string | null; court_name: string | null }[];
      };
      const activeFixture = activeOut.fixtures.find((f) => f.id === seeded.fixtureId);
      expect(activeFixture!.venue_name).toBe(seeded.venueName);
      expect(activeFixture!.court_name).toBe(seeded.courtName);
    });

    it("publicFixture redacts venue_name/court_name for a setup division, then reveals them once active (single-row form)", async () => {
      const seeded = await seedSetupRedaction();
      const setupFixture = (await publicFixture(seeded.fixtureId)) as {
        venue_name: string | null;
        court_name: string | null;
      };
      expect(setupFixture.venue_name).toBeNull();
      expect(setupFixture.court_name).toBeNull();

      await sql`update divisions set status = 'active' where id = ${seeded.divId}`;
      const activeFixture = (await publicFixture(seeded.fixtureId)) as {
        venue_name: string | null;
        court_name: string | null;
      };
      expect(activeFixture.venue_name).toBe(seeded.venueName);
      expect(activeFixture.court_name).toBe(seeded.courtName);
    });
  },
);
