// Review fix (RS007, 2026-08-27) — an explicit `youth` override set via the
// API must survive a hub Save that never intends to touch it. Real Postgres;
// skipped without DATABASE_URL (same convention as division-settings.test.ts,
// this file's sibling — kept SEPARATE rather than appended there so this
// regression's own verify command can name it directly).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`div-${suffix}@test.local`}, 'Division Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Division Org " + suffix}, ${"div-org-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return {
    orgId,
    via: "session",
    userId,
    role: "owner",
    keyId: null,
  } as AuthCtx;
}

async function rig(owner: AuthCtx, ageMax: number | null = 99) {
  const competition = await createCompetition(owner, {
    name: "Youth Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    age_max: ageMax ?? undefined,
  });
  return { competition, division };
}

// The hub config panel's PATCH body (toDivisionPatchBody,
// registration-hub-config-state.ts) always sends these SIX keys together on
// every save, whatever the organiser actually touched in the Eligibility
// accordion — and never sends `youth` at all (there is no youth control in
// the hub UI; `youth` is reachable only via a direct API PATCH). Shaped to
// match that body exactly, so this reproduces a REAL hub Save, not a
// synthetic one that happens to dodge the bug.
function hubSavePatch(ageMax: number | null) {
  return {
    category: null,
    age_min: null,
    age_max: ageMax,
    age_cutoff_month: null,
    age_cutoff_day: null,
    eligibility_note: null,
  };
}

describe.skipIf(!HAS_DB)("patchDivision — an explicit youth override survives a hub Save (review fix)", () => {
  it("a youth override set via the API is NOT clobbered by a later hub Save that resends the SAME age_max", async () => {
    const owner = await seedOwner();
    // age_max: 99 -> deriveYouth(99) is false, so an explicit override to
    // TRUE is unambiguously an override, never a coincidence of derivation.
    const { division } = await rig(owner, 99);
    expect(division.youth).toBe(false);

    // Set the override the ONLY way it can be set: a PATCH naming `youth`
    // alone, exactly what "reachable only via the API today" means (the hub
    // form has no youth field to send one from).
    const overridden = await patchDivision(owner, division.id, { youth: true });
    expect(overridden.youth).toBe(true);

    // A hub Save: all six eligibility keys together, age_max UNCHANGED, no
    // `youth` key at all — the panel never intends to touch it.
    const afterHubSave = await patchDivision(owner, division.id, hubSavePatch(99));
    expect(afterHubSave.youth).toBe(true); // <- fails pre-fix: silently re-derived to false

    // Not just the in-memory return value — a fresh read proves it actually
    // persisted, not merely echoed back off the patch input.
    const fetched = await getDivision(owner, division.id);
    expect(fetched.youth).toBe(true);
  });

  it("the override survives even when that SAME hub Save changes age_max to a new value", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner, 99);
    await patchDivision(owner, division.id, { youth: true });

    // The organiser widens the age band in the SAME save that (per the
    // branch's own rule) must not touch youth — "an explicit override
    // always wins over the derivation" is not scoped to "only while
    // age_max stays byte-identical".
    const afterHubSave = await patchDivision(owner, division.id, hubSavePatch(30));
    expect(afterHubSave.youth).toBe(true);
  });

  it("does NOT over-correct: a division with no override still re-derives normally on a hub Save", async () => {
    const owner = await seedOwner();
    // age_max: 10 -> deriveYouth(10) is true, and youth was never explicitly
    // touched, so this is a plain derived value, not an override.
    const { division } = await rig(owner, 10);
    expect(division.youth).toBe(true);

    // Organiser widens the band past 18 in the hub — youth should still
    // flip off, exactly as it did before this fix.
    const afterHubSave = await patchDivision(owner, division.id, hubSavePatch(25));
    expect(afterHubSave.youth).toBe(false);
  });

  it("an explicit `youth` in the SAME request as an age_max change still wins (pre-existing, unregressed)", async () => {
    const owner = await seedOwner();
    const { division } = await rig(owner, 10); // deriveYouth(10) would be true
    const patched = await patchDivision(owner, division.id, { age_max: 10, youth: false });
    expect(patched.youth).toBe(false);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
