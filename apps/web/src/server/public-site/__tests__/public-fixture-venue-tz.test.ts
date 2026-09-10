// Owner answer 12 (Q1): the public fixture payload carries the VENUE zone, so
// a pre-match overlay prints a start time an Indian or Dutch club audience
// recognises instead of UTC.
//
// The competition-desk programme's ruling is "one zone per fixture" and its
// resolver is `resolveVenueTz` (lib/tz.ts:44) — the VENUE lane, never the
// personal lane. This test pins the three branches THROUGH getPublicFixture,
// not through the helper (the helper already has its own unit cover): the
// claim is about what the payload carries, and a helper test cannot see a
// query that forgot to select `organizations.timezone`.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double this directory's data-court-venue-names.test.ts uses. Real
// Postgres required; skipped without DATABASE_URL.
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

// Deviation from the brief (RE-PIN, 2026-09-09): the brief's seed wrote
// `divisions.config = '{}'`. `getPublicFixture` builds `matchCentre` (Task 9),
// which resolves the division's module and PARSES this column through its
// `configSchema` — which is exactly why the sibling
// `data-court-venue-names.test.ts` stopped using `'{}'` and declared this
// constant (see its comment at :34-42). Copied verbatim from there.
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
  divisionId: string;
  fixtureId: string;
}

/**
 * A public org / competition / division / fixture, seeded by direct insert.
 * Inlined from `data-court-venue-names.test.ts:63-108`'s `seed()` (which is
 * NOT exported — review 2026-09-08 finding 40), minus its venue/court rows,
 * plus the ONE column this test turns on: `organizations.timezone` (V305).
 * That file is the working reference for which columns are NOT NULL; if an
 * insert below is refused, diff against it rather than guessing.
 */
async function seedPublicFixture(orgTz: string | null): Promise<Seeded> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "ovl-tz-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, timezone)
    values (${"OVL TZ Org " + s}, ${orgSlug}, ${orgTz}) returning id`;
  const compSlug = "ovl-tz-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"OVL TZ Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "open-" + s;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active',
            ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  return { orgId, orgSlug, compSlug, divSlug, divisionId, fixtureId };
}

const seeded: string[] = [];
afterAll(async () => {
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
});

describe.skipIf(!HAS_DB)("getPublicFixture carries the venue zone", () => {
  it("falls back to the organisation's zone when the division has no schedule_settings row", async () => {
    const s = await seedPublicFixture("Asia/Kolkata");
    seeded.push(s.orgId);
    // Deliberately NO schedule_settings row: `tz` is `not null default 'UTC'`
    // (V114:48), so a row that merely exists would SHADOW the org zone, and a
    // test that wrote 'UTC' here would be asserting the wrong branch.
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data, "the seeded fixture must be publicly visible").not.toBeNull();
    expect(
      data!.venueTz,
      "a UTC label is the wrong time for this club — that is the whole point of the field",
    ).toBe("Asia/Kolkata");
    expect(data!.venueTz).not.toBe("UTC");
  });

  it("the division's own override wins over the organisation's zone", async () => {
    const s = await seedPublicFixture("Asia/Kolkata");
    seeded.push(s.orgId);
    await sql`
      insert into schedule_settings (division_id, org_id, tz)
      values (${s.divisionId}, ${s.orgId}, 'Europe/Amsterdam')
      on conflict (division_id) do update set tz = excluded.tz`;
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(
      data!.venueTz,
      "a London organiser running an event in Malaga — the venue lane's whole reason to exist",
    ).toBe("Europe/Amsterdam");
  });

  it("is UTC when neither is set, and never a personal or browser zone", async () => {
    const s = await seedPublicFixture(null);
    seeded.push(s.orgId);
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data!.venueTz).toBe("UTC");
  });

  it("rejects a stored zone Intl does not accept rather than passing it through", async () => {
    // `resolveVenueTz` validates with Intl.DateTimeFormat construction, so a
    // legacy/typo'd zone degrades to the next lane instead of reaching
    // Intl.DateTimeFormat({ timeZone }) in the page and throwing a RangeError
    // that would 500 the overlay mid-broadcast.
    const s = await seedPublicFixture("Mars/Olympus_Mons");
    seeded.push(s.orgId);
    const data = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, s.fixtureId);
    expect(data!.venueTz).toBe("UTC");
  });
});
