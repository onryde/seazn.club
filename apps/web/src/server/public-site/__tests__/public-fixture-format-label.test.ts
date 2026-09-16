// The match centre's `metaLine` names the FORMAT, and it named it by key.
//
// Found by looking at a rendered share image, not at the code: the fixture's
// poster carried a pill reading "t20", and the tennis one "grand-slam" —
// division.variant_key, printed to a spectator, on the one surface that gets
// posted to Instagram. `sport_variants.name` has had "T20" and "Grand Slam" in
// it the whole time. The header, the Info tab's format row, the OG card and the
// poster all read this one field, so the fix belongs at the loader.
//
// Pinned THROUGH getPublicFixture rather than through loadMatchCentre: the
// claim is about which column the query selects, and a builder test cannot see
// a loader that passes the wrong one.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double this directory's siblings use. Real Postgres required; skipped
// without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { getPublicFixture } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

// See `public-fixture-venue-tz.test.ts:34-42` — `'{}'` is refused, because
// getPublicFixture builds the match centre and parses this through the
// module's own configSchema.
const GENERIC_DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Seeded {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  fixtureId: string;
}

/** A public org/competition/division/fixture on a named variant key. The
 *  variant ROW is seeded separately per test, so the "no catalog row at all"
 *  fallback is reachable. */
async function seed(variantKey: string): Promise<Seeded> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "fmt-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, timezone)
    values (${"Fmt Org " + s}, ${orgSlug}, 'Europe/London') returning id`;
  const compSlug = "fmt-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"Fmt Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "open-" + s;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', ${variantKey}, 'active',
            ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  return { orgId, orgSlug, compSlug, divSlug, fixtureId };
}

const orgs: string[] = [];
const variants: string[] = [];
afterAll(async () => {
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`;
  for (const key of variants) await sql`delete from sport_variants where key = ${key}`;
});

const metaOf = async (s: Seeded): Promise<string | null> => {
  const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
  expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
  return data!.matchCentre.header.metaLine;
};

describe.skipIf(!HAS_DB)("getPublicFixture names the format, and does not print its key", () => {
  it("uses the catalog's NAME, not the division's variant_key", async () => {
    const key = "fmt-t20-" + uniq();
    variants.push(key);
    await sql`
      insert into sport_variants (sport_key, key, name, is_system, config)
      values ('generic', ${key}, 'T20', true, '{}')`;
    const s = await seed(key);
    orgs.push(s.orgId);
    const meta = await metaOf(s);
    expect(meta, "a spectator's poster read 't20' where the catalog says 'T20'").toContain("T20");
    expect(meta).not.toContain(key);
  });

  it("falls back to the key when the catalog has no row for it, rather than dropping the format", async () => {
    // A division can outlive the variant it points at. Saying something
    // slightly ugly beats silently losing a third of the meta line.
    const key = "fmt-orphan-" + uniq();
    const s = await seed(key);
    orgs.push(s.orgId);
    expect(await metaOf(s)).toContain(key);
  });

  it("an org's own renamed variant beats the system row", async () => {
    const key = "fmt-scoped-" + uniq();
    variants.push(key);
    await sql`
      insert into sport_variants (sport_key, key, name, is_system, config)
      values ('generic', ${key}, 'System Name', true, '{}')`;
    const s = await seed(key);
    orgs.push(s.orgId);
    await sql`
      insert into sport_variants (sport_key, key, name, is_system, org_id, config)
      values ('generic', ${key}, 'Our Own Name', false, ${s.orgId}, '{}')`;
    const meta = await metaOf(s);
    expect(meta, "renaming a variant is what org scope is FOR").toContain("Our Own Name");
    expect(meta).not.toContain("System Name");
  });

  it("another org's renamed variant is never borrowed", async () => {
    // The guard that matters: a bare match on (sport_key, key) would happily
    // return a stranger's rename, and nothing on the page would look wrong.
    const key = "fmt-foreign-" + uniq();
    variants.push(key);
    await sql`
      insert into sport_variants (sport_key, key, name, is_system, config)
      values ('generic', ${key}, 'System Name', true, '{}')`;
    const stranger = await seed(key);
    orgs.push(stranger.orgId);
    await sql`
      insert into sport_variants (sport_key, key, name, is_system, org_id, config)
      values ('generic', ${key}, 'Stranger Name', false, ${stranger.orgId}, '{}')`;

    const ours = await seed(key);
    orgs.push(ours.orgId);
    const meta = await metaOf(ours);
    expect(meta).toContain("System Name");
    expect(meta).not.toContain("Stranger Name");
  });
});
