// RS006 (public stepper) entry condition: the public register panel
// (`publicRegistrationInfo` / `PublicDivisionInfo`) did not expose
// `category`/`age_min`/`age_max`/`allow_free_agents`/`requires_gender` even
// though the columns backing them have existed since V364 and RS004's org
// hub already reads/writes them (`app/o/.../registration/data.ts`). Step 2
// (ENTRIES) needs category/age badges and the free-agent option — without
// these fields the client would have had to re-derive eligibility rules
// itself, which is exactly the client/server fork `_RULES.md` and the RS006
// prompt both forbid. Widened additively; no migration (columns pre-exist).
// Real Postgres, skipped without DATABASE_URL (repo convention).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { publicRegistrationInfo, putRegistrationSettings } from "../registrations";
import { asOwner, rig, seedOrg } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("publicRegistrationInfo — RS006 eligibility/free-agent fields", () => {
  it("returns category/age_min/age_max/allow_free_agents/requires_gender for a configured team division", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`update divisions set category = 'womens', age_min = 16, age_max = 35 where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 1500,
      capacity: 10,
      payment_method: "offline",
      allow_free_agents: true,
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions).toHaveLength(1);
    const d = info.divisions[0]!;
    expect(d.category).toBe("womens");
    expect(d.age_min).toBe(16);
    expect(d.age_max).toBe(35);
    expect(d.allow_free_agents).toBe(true);
    // womens ⇒ gender is needed to tell a self-registering contact apart —
    // same rule requiresGender's own unit tests pin, proven here end to end
    // through the real query rather than only against a hand-built object.
    expect(d.requires_gender).toBe(true);
  });

  it("defaults: open/null category, unset age band, free agents off, gender not required", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions[0]!;
    expect(d.category).toBeNull();
    expect(d.age_min).toBeNull();
    expect(d.age_max).toBeNull();
    expect(d.allow_free_agents).toBe(false);
    expect(d.requires_gender).toBe(false);
    expect(d.eligibility_note).toBeNull();
  });

  // RS007/V380 defect #3: the wizard's custom rule was written and shown
  // NOWHERE. eligibility_note is now a first-class column on the SAME
  // publicRegistrationInfo read model as category/age_min/age_max above —
  // this is that column's own entry condition proof.
  it("returns eligibility_note for a division that has one set", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`update divisions set eligibility_note = 'School-registered students only' where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.eligibility_note).toBe("School-registered students only");
  });

  it("a mixed category requires gender (roster-composition signal) even with no age band", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`update divisions set category = 'mixed' where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.requires_gender).toBe(true);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
