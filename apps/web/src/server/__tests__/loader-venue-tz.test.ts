// m3 — the venue zone as the two SPECTATOR loaders actually resolve it.
//
// Both `getPublicDivision` (the public division page, and via it calendar.ics,
// poster.pdf, the OG images and the /present kiosk) and `embedDivisionData`
// (the embed door, rendered on third-party sites) resolve the zone INLINE in
// SQL as `coalesce(ss.tz, o.timezone, 'UTC')`. Neither had any timezone
// coverage at all.
//
// The distinction this file exists to pin: SQL `coalesce` rescues NULL and
// nothing else. Every other venue-lane reader goes through `resolveVenueTz`
// (lib/tz.ts), which validates each candidate with Intl and DEGRADES to the
// next lane when it fails — so `public-fixture-venue-tz.test.ts` can assert
// that a junk zone becomes "UTC". These two loaders cannot: a stored value
// that is merely invalid, rather than null, is passed through verbatim. That
// asymmetry is the last case in each block below, and it is recorded as
// OBSERVED behaviour, not as the behaviour one might want.
//
// The write path that feeds this column now refuses a junk zone on the way in
// (`PutScheduleSettings.tz`, see lib/__tests__/venue-tz.test.ts), but rows
// stored before that guard existed are unaffected, which is why the loaders'
// own behaviour still needs pinning.
//
// unstable_cache is a Next server-runtime API — passthrough under vitest, the
// same double the sibling public-site tests use. Real Postgres required.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { resolveVenueTz } from "@/lib/tz";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { getPublicDivision } from "@/server/public-site/data";
import { embedDivisionData } from "@/server/embed-data";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

// `divisions.config` is parsed through the module's own configSchema by the
// readers below — '{}' does not survive it. Copied from the sibling
// public-site/__tests__/public-fixture-venue-tz.test.ts.
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
}

const seeded: string[] = [];

/**
 * A public org/competition/division reachable by BOTH loaders from one seed.
 *
 * The org is put on Pro deliberately: `embedDivisionData` gates on
 * `embeds.enabled`, which V396 took back on Free, so a community org answers
 * `not_entitled` and every zone assertion below would be unreachable.
 */
async function seedDivision(orgTz: string | null): Promise<Seeded> {
  const s = uniq();
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = "ltz-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, timezone)
    values (${"LTZ Org " + s}, ${orgSlug}, ${orgTz}) returning id`;
  seeded.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const compSlug = "ltz-comp-" + s;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"LTZ Comp " + s}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = "open-" + s;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions
      (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active',
            ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  await sql`
    insert into stages (org_id, division_id, kind, name, seq)
    values (${orgId}, ${divisionId}, 'league', 'League', 1)`;
  return { orgId, orgSlug, compSlug, divSlug, divisionId };
}

/** V305 dropped this column's NOT NULL and its 'UTC' default, so `null` here
 *  is a real, storable state meaning "inherit from the org" — distinct from
 *  having no row at all. Both shapes are exercised below. */
async function setSettingsTz(s: Seeded, tz: string | null): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, org_id, tz)
    values (${s.divisionId}, ${s.orgId}, ${tz})
    on conflict (division_id) do update set tz = excluded.tz`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
});

const LOADERS = [
  {
    name: "getPublicDivision",
    read: async (s: Seeded) => {
      const data = await getPublicDivision(s.orgSlug, s.compSlug, s.divSlug);
      expect(data, "the seeded division must be publicly visible").not.toBeNull();
      return data!.tz;
    },
  },
  {
    name: "embedDivisionData",
    read: async (s: Seeded) => {
      const res = await embedDivisionData(s.divisionId);
      if (!res.ok) throw new Error(`embed door refused the seed: ${res.reason}`);
      return res.data.tz;
    },
  },
];

describe.skipIf(!HAS_DB).each(LOADERS)("$name — venue zone resolution", ({ read }) => {
  it("the division's own schedule_settings zone wins over the org's", async () => {
    const s = await seedDivision("Asia/Kolkata");
    await setSettingsTz(s, "Europe/Amsterdam");
    expect(
      await read(s),
      "a London organiser running an event in Malaga — the venue lane's reason to exist",
    ).toBe("Europe/Amsterdam");
  });

  it("falls back to the org timezone when the division has no settings row", async () => {
    const s = await seedDivision("Asia/Kolkata");
    const tz = await read(s);
    expect(tz).toBe("Asia/Kolkata");
    expect(tz, "a UTC label is the wrong time for this club").not.toBe("UTC");
  });

  it("falls back to the org timezone when the settings row stores tz = null", async () => {
    // The other shape of "no division override", reachable only since V305
    // dropped the NOT NULL. A row that merely EXISTS must not shadow the org.
    const s = await seedDivision("Asia/Kolkata");
    await setSettingsTz(s, null);
    expect(await read(s)).toBe("Asia/Kolkata");
  });

  it("is UTC when neither the division nor the org has a zone", async () => {
    const s = await seedDivision(null);
    expect(await read(s)).toBe("UTC");
  });

  // OBSERVED, not desired. `coalesce` tests for NULL, so a stored value that
  // is present-but-invalid satisfies it and is returned verbatim. The contrast
  // assertion is the point: handed the same two candidates, the validating
  // resolver every other venue-lane reader uses answers "UTC".
  it("passes a stored zone Intl rejects straight through instead of degrading", async () => {
    const s = await seedDivision("Asia/Kolkata");
    await setSettingsTz(s, "Mars/Olympus_Mons");
    const tz = await read(s);
    expect(tz).toBe("Mars/Olympus_Mons");
    expect(tz, "coalesce rescues NULL only — it cannot see an invalid zone").not.toBe("UTC");
    expect(
      resolveVenueTz("Mars/Olympus_Mons", "Asia/Kolkata"),
      "the validating lane degrades to the org zone from the same inputs",
    ).toBe("Asia/Kolkata");
  });

  it("passes an invalid ORG zone through too, when there is no division override", async () => {
    const s = await seedDivision("Mars/Olympus_Mons");
    const tz = await read(s);
    expect(tz).toBe("Mars/Olympus_Mons");
    expect(resolveVenueTz(null, "Mars/Olympus_Mons")).toBe("UTC");
  });
});
