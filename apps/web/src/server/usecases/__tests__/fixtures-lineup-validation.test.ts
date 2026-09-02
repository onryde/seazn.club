// R7-15/R8 WS-F — `validateLineup` (packages/engine/src/sport/catalog.ts) had
// ZERO production callers before this task. `putLineup` now runs the saved
// lineup through it WARNING-ONLY: a lineup `validateLineup` flags still
// saves (2xx), and the issues ride the response as `warnings: string[]`.
// Real Postgres required; skipped without DATABASE_URL, same convention as
// fixtures-lineup.test.ts (S12/#421 pass D) beside this file — the harness
// below is copied from there rather than imported, since that file's
// `seedOrg`/`makeUser` are local, not exported.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { getLineup, putLineup } from "../fixtures";
import { GENERIC_CONFIG } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name})
    returning id`;
  return id;
}

// The 'generic' sport's seeded catalog is `lineup: { size: 1, benchMax: 0 }`
// with no groups/roles — a single starting slot is the only shape
// `validateLineup` accepts, which is exactly what makes it useful here: a
// 2-player starting lineup deterministically trips `starting_size`.
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

async function seedFixture(auth: AuthCtx) {
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
  return { fixtureId: fixtures[0]!.id, entrantId: entrantA.id, playerOne, playerTwo };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("putLineup — validateLineup warnings (R7-15/R8 WS-F)", () => {
  it("a lineup validateLineup flags STILL SAVES, and the issue rides the response as a warning string", async () => {
    const auth = await seedOrg();
    const { fixtureId, entrantId, playerOne, playerTwo } = await seedFixture(auth);

    // catalog says starting size 1 — two starting slots trips `starting_size`.
    const result = await putLineup(auth, fixtureId, entrantId, {
      slots: [
        { person_id: playerOne.id, slot: "starting", position_key: null, order_no: 1, roles: [] },
        { person_id: playerTwo.id, slot: "starting", position_key: null, order_no: 2, roles: [] },
      ],
    });

    // Non-blocking: the save went through — both slots are really persisted.
    const read = await getLineup(auth, fixtureId, entrantId);
    expect(read.slots).toHaveLength(2);

    // The warning is the RIGHT one, not just any string — pins content, not
    // just presence (a stub `warnings: ["x"]` would pass a bare non-empty
    // check but fail this).
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/starting/i);
    expect(result.warnings[0]).toContain("2");
    expect(result.warnings[0]).toContain("1");
  });

  it("a lineup that matches the catalog saves with NO warnings", async () => {
    const auth = await seedOrg();
    const { fixtureId, entrantId, playerOne } = await seedFixture(auth);

    const result = await putLineup(auth, fixtureId, entrantId, {
      slots: [{ person_id: playerOne.id, slot: "starting", position_key: null, order_no: 1, roles: [] }],
    });

    expect(result.warnings).toEqual([]);
  });
});
