// PROMPT-52 public reads: waitlist count on the division card and "#N in
// line" on the token-gated status page. New file — the PR #72 suite
// (registrations.test.ts) is normative and stays byte-identical; its seeding
// helpers are mirrored here rather than imported so neither suite can
// destabilise the other. Real Postgres, skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  publicRegistrationInfo,
  publicRegistrationStatus,
  putRegistrationSettings,
  hashRegistrationToken,
  REGISTRATION_TOKEN_PREFIX,
} from "../registrations";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(): Promise<{
  orgId: string;
  orgSlug: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "p52-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"P52 Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(owner: AuthCtx, capacity: number | null) {
  const competition = await createCompetition(owner, {
    name: "P52 Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await putRegistrationSettings(owner, division.id, {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "usd",
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity,
    refund_lock_at: null,
  });
  return { competition, division };
}

/**
 * `submitRegistration` is deleted (RS001 registration demolition, #588) — see
 * registrations.test.ts's own `seedRegistration` doc comment for the full
 * rationale. Kept as a SEPARATE, minimal helper here (not imported from that
 * suite) per this file's own header: neither suite may destabilise the
 * other. Both tests below read waitlist COUNT/POSITION off rows that already
 * hold a given status — overflow-at-submission itself was submitRegistration's
 * decision and isn't reproduced; the rows are seeded directly in the state a
 * capacity-1 submission run would have left them in.
 */
const seedEntry = async (
  competitionId: string,
  divisionId: string,
  name: string,
  status: "pending" | "waitlisted" = "pending",
): Promise<{ id: string; access_token: string }> => {
  const rawToken = REGISTRATION_TOKEN_PREFIX + randomUUID().replace(/-/g, "");
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash)
    values (
      ${competitionId}, ${name}, ${`${name.toLowerCase().replace(/ /g, ".")}@test.local`},
      ${hashRegistrationToken(rawToken)}
    )
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, status)
    values (${group.id}, ${divisionId}, ${name}, ${status})
    returning id`;
  return { id: reg.id, access_token: rawToken };
};

describe.skipIf(!HAS_DB)("PROMPT-52 public waitlist reads", () => {
  it("exposes waitlisted count on PublicDivisionInfo and #N on the status page", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, 1);

    await seedEntry(competition.id, division.id, "Holder One", "pending");
    const w1 = await seedEntry(competition.id, division.id, "First Wait", "waitlisted");
    const w2 = await seedEntry(competition.id, division.id, "Second Wait", "waitlisted");

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions).toHaveLength(1);
    expect(info.divisions[0]!.waitlisted).toBe(2);

    const s1 = await publicRegistrationStatus(w1.id, w1.access_token);
    const s2 = await publicRegistrationStatus(w2.id, w2.access_token);
    expect(s1.status).toBe("waitlisted");
    expect(s1.position).toBe(1);
    expect(s2.position).toBe(2);
  });

  it("position is null once not waitlisted, and count is 0 with free capacity", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, 5);

    const r = await seedEntry(competition.id, division.id, "In Room", "pending");
    const s = await publicRegistrationStatus(r.id, r.access_token);
    expect(s.status).not.toBe("waitlisted");
    expect(s.position).toBeNull();

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.waitlisted).toBe(0);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
