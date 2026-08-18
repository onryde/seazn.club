// P9 review finding #1 (2026-08-18): embedDivisionData (server/embed-data.ts)
// rendered <Schedule>, which this branch switched to f.court_name/
// f.venue_name, but it still selected only venue/court_label off
// public_fixtures_v (frozen since the venues/courts entities cutover,
// V367/V374) and never called withCourtVenueNames — the cast
// sql<PublicFixture[]> is unchecked, so tsc could not see the mismatch; it
// failed only at runtime, silently, as a missing column. Fixed by chaining
// the same withCourtVenueNames helper public-site/data.ts's own division
// read already uses.
//
// Sibling of server/__tests__/embed-data.test.ts (not-found/entitlement
// gating) rather than an addition to it — this covers a different axis
// (the fixture payload's shape) and needs its own stage+fixture+venue+court
// seed, which that file's existing seed() helper deliberately doesn't
// build. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { embedDivisionData } from "@/server/embed-data";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("embedDivisionData — venue_name/court_name post-cutover (P9 review #1)", () => {
  it("surfaces the real venue/court names for a fixture scheduled after the cutover", async () => {
    const s = uniq();
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"Emb CV " + s}, ${"emb-cv-" + s}) returning id`;
    // embeds.enabled is Pro-gated (server/__tests__/embed-data.test.ts's own
    // "public division on Community -> not_entitled" case proves this).
    await setOrgPlan(orgId, "pro");
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility)
      values (${orgId}, ${"Comp " + s}, ${"comp-" + s}, 'public') returning id`;
    // status must be 'active' (not the table default 'setup') — a setup
    // division redacts venue_name/court_name the same way public_fixtures_v
    // redacts venue/court_label, and that redaction is not what this test
    // is proving.
    const [{ id: divId }] = await sql<{ id: string }[]>`
      insert into divisions
        (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
      values (${orgId}, ${compId}, 'Div', ${"div-" + s}, 'generic', 'score', 'active', '{}', '1.0.0')
      returning id`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (org_id, division_id, kind, name, seq)
      values (${orgId}, ${divId}, 'league', 'League', 1) returning id`;
    const venueName = "Court Venue " + s;
    const [{ id: venueId }] = await sql<{ id: string }[]>`
      insert into venues (org_id, name) values (${orgId}, ${venueName}) returning id`;
    const [{ id: courtId }] = await sql<{ id: string }[]>`
      insert into courts (venue_id, org_id, name) values (${venueId}, ${orgId}, 'Center Court') returning id`;
    // Post-cutover shape: court_id/venue_id set, the frozen venue/
    // court_label columns left null (nothing writes them any more).
    await sql`
      insert into fixtures
        (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round, court_id, venue_id)
      values (${orgId}, ${divId}, ${stageId}, 1, 1, 1, ${courtId}, ${venueId})`;

    const res = await embedDivisionData(divId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.fixtures).toHaveLength(1);
    const fixture = res.data.fixtures[0]!;
    expect(fixture.venue).toBeNull();
    expect(fixture.court_label).toBeNull();
    expect(fixture.venue_name).toBe(venueName);
    expect(fixture.court_name).toBe("Center Court");
  });
});
