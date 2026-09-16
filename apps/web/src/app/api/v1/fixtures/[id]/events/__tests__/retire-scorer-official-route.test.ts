// #707 Task 6 — an accepted fixture official with no org membership scores through
// POST /api/v1/fixtures/{id}/events (THE production scoring route), not only
// via requireScorable/scoreEvent called directly. Auth door mocked at requireUser
// only; requireFixtureActor and scoreEvent run for real.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

const sessionState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => {
      const rows = await sql<
        { id: string; display_name: string; email: string; avatar_url: string | null; timezone: string | null; locale: string | null }[]
      >`
        select id, display_name, email, avatar_url, timezone, locale
        from users where id = ${sessionState.userId}`;
      if (!rows[0]) throw new AuthError("Not signed in");
      return rows[0];
    },
  };
});

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOwnerOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Official Route " + suffix}, ${"official-route-" + suffix}, ${ownerId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
}

async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(owner, division.id, ["A", "B", "C", "D"].map((n, i) => ({
    kind: "individual" as const,
    display_name: n,
    seed: i + 1,
    members: [],
  })));
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(owner, stage!.id);
  await startDivision(owner, division.id);
  return { fixtures };
}

function postEvent(fixtureId: string, body: unknown): Request {
  return new Request(`http://localhost/api/v1/fixtures/${fixtureId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("POST /api/v1/fixtures/{id}/events — accepted official (#707)", () => {
  it("appends core.start with 201 when the session is a non-member accepted official", async () => {
    const owner = await seedOwnerOrg();
    const { fixtures } = await rig(owner);
    const fixtureId = fixtures[0]!.id;
    const officialUserId = await makeUser("official");
    sessionState.userId = officialUserId;

    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${owner.orgId}, 'Ref', ${officialUserId}) returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${owner.orgId}, ${person!.id}, 'Ref', ${sql.json(["referee"])}) returning id`;
    await sql`
      insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
      values (${owner.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;

    const res = await POST(postEvent(fixtureId, { expected_seq: 0, type: "core.start", payload: {} }), {
      params: Promise.resolve({ id: fixtureId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; data?: { seq: number; status: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.seq).toBe(1);
    expect(body.data?.status).toBe("in_play");

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(1);
  });
});
