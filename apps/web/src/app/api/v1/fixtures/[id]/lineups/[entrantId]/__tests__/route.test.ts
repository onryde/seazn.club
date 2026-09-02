// R7-15/R8 WS-F, review fix round 1 — the reviewer's Important finding:
// fixtures-lineup-validation.test.ts (usecases/__tests__) proves
// `putLineup` computes `warnings` correctly, but calls the USECASE directly.
// Nothing proved that the HTTP envelope actually carries it through —
// `v1Inner` (api-v1/http.ts:150) does `NextResponse.json({ ok: true, data:
// result, requestId })`, and a future edit there (or to this route) could
// drop/rename the field without any existing test noticing. This test
// drives the REAL `PUT` route handler — real `putLineup`, real DB, real
// `validateLineup` call — through `v1()`, and reads `data.warnings` off the
// actual `Response`.
//
// Harness mirrors format-preview/__tests__/route.test.ts (named by the
// reviewer as the pattern): mock the auth door only (`requireFixtureActor`
// needs a real session/cookie otherwise, which is out of scope for what
// this test verifies), leave every usecase real. Same seeded 'generic'
// sport catalog (`lineup: { size: 1, benchMax: 0 }`) as
// fixtures-lineup-validation.test.ts, so 2 starting slots deterministically
// trips `starting_size`.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";

const requireFixtureActorMock = vi.hoisted(() => vi.fn<() => Promise<AuthCtx>>());
vi.mock("@/server/api-v1/auth", () => ({ requireFixtureActor: requireFixtureActorMock }));

import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { PUT } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name})
    returning id`;
  return id;
}

async function seedOrg(): Promise<AuthCtx> {
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
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

function putReq(fixtureId: string, entrantId: string, body: unknown): Request {
  return new Request(`http://localhost/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_DB)("PUT /api/v1/fixtures/{id}/lineups/{entrantId} — validateLineup warnings ride the HTTP envelope", () => {
  it("a lineup validateLineup flags returns 2xx with data.warnings non-empty", async () => {
    const auth = await seedOrg();
    requireFixtureActorMock.mockResolvedValue(auth);

    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Cup " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const [entrantA, entrantB] = await createEntrants(auth, division.id, [
      { kind: "individual" as const, display_name: "A", seed: 1, members: [] },
      { kind: "individual" as const, display_name: "B", seed: 2, members: [] },
    ]);
    expect(entrantB).toBeTruthy(); // needed only so generateStageFixtures has a pair
    const [playerOne] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Player One') returning id`;
    const [playerTwo] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Player Two') returning id`;
    await sql`
      insert into entrant_members (entrant_id, person_id)
      values (${entrantA.id}, ${playerOne.id}), (${entrantA.id}, ${playerTwo.id})`;
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    const fixtureId = fixtures[0]!.id;

    // catalog says starting size 1 — two starting slots trips `starting_size`.
    const res = await PUT(
      putReq(fixtureId, entrantA.id, {
        slots: [
          { person_id: playerOne.id, slot: "starting", position_key: null, order_no: 1, roles: [] },
          { person_id: playerTwo.id, slot: "starting", position_key: null, order_no: 2, roles: [] },
        ],
      }),
      { params: Promise.resolve({ id: fixtureId, entrantId: entrantA.id }) },
    );

    // Non-blocking: a 2xx, not a 422/500.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { ok: boolean; data: { warnings?: string[]; slots?: unknown[] } };
    expect(body.ok).toBe(true);
    // Content, not just presence — pins the actual issue reaching the wire,
    // not a stub `warnings: ["x"]` that would pass a bare non-empty check.
    expect(body.data.warnings).toHaveLength(1);
    expect(body.data.warnings?.[0]).toMatch(/starting/i);
    expect(body.data.warnings?.[0]).toContain("2");
    expect(body.data.warnings?.[0]).toContain("1");
    // And the save actually went through the HTTP path too.
    expect(body.data.slots).toHaveLength(2);
  });
});
