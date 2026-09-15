// Scoring auth (#707): requireScorable via owner/admin or accepted officials
// only — org-member scorers and assignment-table auth are retired. Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { PaymentRequiredError, HttpError } from "@/lib/errors";
import { createOrgForUser } from "@/lib/auth";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { OrgRole } from "@/lib/types";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent, finalizeFixture } from "../scoring";
import { putLineup } from "../fixtures";
import {
  requireScorable,
  fixtureScope,
  acceptedOfficialCovers,
} from "../scorers";
import {
  frozenMemberIds,
  assertMemberNotFrozen,
} from "../entitlement-freeze";
import {
  makeUser as makeSeedUser,
  seedOrg as seedSeedOrg,
  seedFutureDivision,
} from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name})
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string; slug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Org " + suffix}, ${"org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', 10, 'test probe')`;
  return { orgId, ownerId, slug: "org-" + suffix };
}

const asRole = (orgId: string, userId: string | null, role: OrgRole | null): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role,
  keyId: null,
});

async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(owner, division.id, ["A", "B", "C", "D"].map((n, i) => ({
    kind: "individual" as const, display_name: n, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(owner, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  });
  const { fixtures } = await generateStageFixtures(owner, stage.id);
  await startDivision(owner, division.id);
  return { competition, division, stage, fixtures };
}

async function addMember(orgId: string, role: OrgRole): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

async function acceptOfficial(
  orgId: string,
  userId: string,
  fixtureId: string,
): Promise<void> {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id)
    values (${orgId}, 'Official', ${userId}) returning id`;
  const [official] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${orgId}, ${person!.id}, 'Official', ${sql.json(["referee"])}) returning id`;
  await sql`
    insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
    values (${orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("requireScorable without assignments (#707)", () => {
  it("authz matrix: owner/admin pass; viewer and unassigned member 403", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { division, fixtures } = await rig(owner);
    const adminId = await addMember(orgId, "admin");
    const viewerId = await addMember(orgId, "viewer");
    const strangerId = await makeUser("stranger");
    const legacyScorerId = await makeUser("legacy-scorer");

    const gate: { role: string | null; userId: string; pass: boolean }[] = [
      { role: "owner", userId: ownerId, pass: true },
      { role: "admin", userId: adminId, pass: true },
      { role: "viewer", userId: viewerId, pass: false },
      { role: null, userId: strangerId, pass: false },
      // Synthetic AuthCtx — V404 CHECK forbids org_members.role = 'scorer'.
      { role: "scorer", userId: legacyScorerId, pass: false },
    ];
    for (const probe of gate) {
      const attempt = requireScorable(
        asRole(orgId, probe.userId, probe.role as unknown as OrgRole | null),
        fixtures[0].id,
      );
      if (probe.pass) {
        await expect(attempt, `${probe.role} gate`).resolves.toBeTruthy();
      } else {
        await expect(attempt, `${probe.role} gate`).rejects.toMatchObject({ status: 403 });
      }
    }

    // Accepted official with no org membership scores.
    await acceptOfficial(orgId, strangerId, fixtures[0].id);
    await expect(
      requireScorable(asRole(orgId, strangerId, null), fixtures[0].id),
    ).resolves.toMatchObject({ id: fixtures[0].id });

    // Official on a different fixture does not cover this one.
    await expect(
      requireScorable(asRole(orgId, strangerId, null), fixtures[1].id),
    ).rejects.toMatchObject({ status: 403 });

    void division;
  });

  it("accepted official scores with capability gates; editors bypass them", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { division, fixtures } = await rig(owner);
    const officialId = await makeUser("official");
    await acceptOfficial(orgId, officialId, fixtures[0].id);
    const official = asRole(orgId, officialId, null);

    const fx = fixtures[0].id;
    await scoreEvent(official, fx, { expected_seq: 0, type: "core.start", payload: {} });
    const note = await scoreEvent(official, fx, {
      expected_seq: 1, type: "core.note", payload: { text: "oops" },
    });
    const [noteRow] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fx} and seq = ${note.seq}`;
    const voided = await scoreEvent(official, fx, {
      expected_seq: note.seq, type: "core.void", payload: { event_id: noteRow.id },
    });
    const decided = await scoreEvent(official, fx, {
      expected_seq: voided.seq, type: "generic.result", payload: { p1Score: 2, p2Score: 1 },
    });
    expect(decided.status).toBe("decided");
    const finalized = await finalizeFixture(official, fx, decided.seq);
    expect(finalized.status).toBe("finalized");

    const [starter] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fx} and seq = 1`;
    await expect(
      scoreEvent(official, fx, {
        expected_seq: finalized.seq, type: "core.void", payload: { event_id: starter.id },
      }),
    ).rejects.toMatchObject({ status: 403 });

    const fx2 = fixtures[1];
    const entrantId = (fx2.home_entrant_id ?? fx2.away_entrant_id) as string;
    await expect(putLineup(official, fx2.id, entrantId, { slots: [] })).resolves.toBeTruthy();
    await sql`update divisions set scorer_can_enter_lineups = false where id = ${division.id}`;
    await expect(putLineup(official, fx2.id, entrantId, { slots: [] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(putLineup(owner, fx2.id, entrantId, { slots: [] })).resolves.toBeTruthy();

    await sql`update divisions set scorer_can_finalize = false where id = ${division.id}`;
    await scoreEvent(official, fx2.id, { expected_seq: 0, type: "core.start", payload: {} });
    const d2 = await scoreEvent(official, fx2.id, {
      expected_seq: 1, type: "generic.result", payload: { p1Score: 1, p2Score: 0 },
    });
    await expect(finalizeFixture(official, fx2.id, d2.seq)).rejects.toMatchObject({ status: 403 });
    await expect(finalizeFixture(owner, fx2.id, d2.seq)).resolves.toBeTruthy();
  });

  it("viewer role never scores; HttpError carries 403 not 401", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asRole(orgId, ownerId, "owner");
    const { fixtures } = await rig(owner);
    const viewerId = await addMember(orgId, "viewer");
    try {
      await requireScorable(asRole(orgId, viewerId, "viewer"), fixtures[0].id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
    }
  });

  it("orgs.max_owned (decision a): 2nd community org blocked at creation", async () => {
    const userId = await makeUser("founder");
    const first = await createOrgForUser(userId, "First club");
    expect(first.id).toBeTruthy();
    await expect(createOrgForUser(userId, "Second club")).rejects.toMatchObject({
      featureKey: "orgs.max_owned",
    });
    await expect(createOrgForUser(userId, "Second club")).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
  });

  it("downgrade freeze (doc 10 §2.4): over-quota member seats go read-only, owner exempt", async () => {
    const { orgId, ownerId } = await seedOrg();
    const [memberRow] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'community' and feature_key = 'members.max'`;
    const memberCap = memberRow?.int_value;
    expect(memberCap, "members.max must be a finite community cap").toBeTypeOf("number");
    const admins: string[] = [];
    for (let i = 0; i < memberCap!; i++) {
      const userId = await makeUser("admin");
      await sql`
        insert into org_members (org_id, user_id, role, created_at)
        values (${orgId}, ${userId}, 'admin', now() - make_interval(hours => ${memberCap! - i}))`;
      admins.push(userId);
    }

    const frozen = await frozenMemberIds(orgId);
    expect(frozen.size).toBe(1);
    const [oldest] = admins;
    expect(frozen.has(oldest)).toBe(true);
    expect(frozen.has(ownerId)).toBe(false);

    await expect(assertMemberNotFrozen(orgId, oldest)).rejects.toMatchObject({
      featureKey: "members.max",
    });
    await expect(assertMemberNotFrozen(orgId, admins[2])).resolves.toBeUndefined();
    await expect(assertMemberNotFrozen(orgId, ownerId)).resolves.toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("accepted-official scoring authority", () => {
  it("acceptedOfficialCovers + requireScorable pass only for an accepted official", async () => {
    const { auth } = await seedSeedOrg("pro");
    const { fixtures } = await seedFutureDivision(auth);
    const fixtureId = fixtures[0]!.id;
    const user = await makeSeedUser("Ref One");
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Ref One', ${user.id}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref One', ${sql.json(["referee"])}) returning id`;
    await sql`
      insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
      values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'pending')`;

    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(false);

    await sql`update fixture_officials set response = 'accepted'
              where fixture_id = ${fixtureId} and official_id = ${official!.id}`;
    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(true);

    const officialAuth = {
      orgId: auth.orgId, via: "session" as const, userId: user.id, role: null, keyId: null,
    } satisfies AuthCtx;
    await expect(requireScorable(officialAuth, fixtureId)).resolves.toMatchObject({ id: fixtureId });

    await sql`update fixture_officials set response = 'declined'
              where fixture_id = ${fixtureId} and official_id = ${official!.id}`;
    expect(await acceptedOfficialCovers(user.id, fixtureId)).toBe(false);
    await expect(requireScorable(officialAuth, fixtureId)).rejects.toThrow(/cannot record scores/);
  });

  it("fixtureScope returns division capability flags", async () => {
    const { auth } = await seedSeedOrg("pro");
    const { fixtures } = await seedFutureDivision(auth);
    const scope = await fixtureScope(fixtures[0]!.id);
    expect(scope).toMatchObject({
      id: fixtures[0]!.id,
      scorer_can_finalize: true,
      scorer_can_enter_lineups: true,
    });
  });
});
