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

// ---------------------------------------------------------------------------
// R8 branch review, finding 2 — `warnings: []` used to mean EITHER "validated,
// nothing wrong" OR "validation threw and we swallowed it": the catch returned
// `[]` and the two were indistinguishable on the wire, so no caller could fail
// closed even if it wanted to. `checked` now discriminates them. Driven
// through the REAL crash path (an unresolvable pinned module_version makes
// `resolveModule` throw MODULE_NOT_FOUND inside the try) rather than by
// mocking the validator — a mock on both ends would only prove the mock.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("putLineup — validated-clean vs validation-crashed are distinguishable (R8 finding 2)", () => {
  it("a clean lineup reports checked: true alongside its empty warnings", async () => {
    const auth = await seedOrg();
    const { fixtureId, entrantId, playerOne } = await seedFixture(auth);

    const result = await putLineup(auth, fixtureId, entrantId, {
      slots: [{ person_id: playerOne.id, slot: "starting", position_key: null, order_no: 1, roles: [] }],
    });

    expect(result.warnings).toEqual([]);
    expect(result.checked).toBe(true);
  });

  it("a lineup whose validation CRASHES reports checked: false — not the same empty list a clean lineup returns", async () => {
    const auth = await seedOrg();
    const { fixtureId, entrantId, playerOne } = await seedFixture(auth);
    // Pin the division at a module_version no registry entry has, so
    // `resolveModule` throws inside `lineupValidationWarnings`'s try.
    await sql`
      update divisions set module_version = '9.9.9'
      where id = (select division_id from fixtures where id = ${fixtureId})`;

    const result = await putLineup(auth, fixtureId, entrantId, {
      slots: [{ person_id: playerOne.id, slot: "starting", position_key: null, order_no: 1, roles: [] }],
    });

    // Still non-blocking — the whole point of the warning-only posture is
    // that a registry problem must not turn a working save into a 500.
    const read = await getLineup(auth, fixtureId, entrantId);
    expect(read.slots).toHaveLength(1);

    // ...but the caller can now tell this apart from the clean case above,
    // which returns the SAME empty `warnings` with `checked: true`.
    expect(result.warnings).toEqual([]);
    expect(result.checked).toBe(false);
    if (!result.checked) expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R8 branch review, finding 3 — the warnings described the REQUEST
// (`input.slots`, with `orderNo` synthesised from the request's own index),
// not the rows that were actually stored. Witnessed through issue ORDER,
// which is the one place the two orderings are observably different today:
// `validateLineup` emits issues in the order it walks `lineup.slots`, and
// `readLineup` returns rows ordered by `order_no nulls last, full_name` while
// the request is in whatever order the caller sent. Send the two starting
// slots in the REVERSE of their `order_no` and the request-sourced list comes
// out backwards.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("putLineup — warnings describe the STORED lineup, not the request (R8 finding 3)", () => {
  it("issue order follows the read-back's own ordering, not the order the slots were sent in", async () => {
    const auth = await seedOrg();
    const { fixtureId, entrantId, playerOne, playerTwo } = await seedFixture(auth);

    // Sent Two-then-One; stored/read-back order is One-then-Two (order_no).
    // The generic catalog declares no position groups, so BOTH position keys
    // are `unknown_position` — one issue per person, in walk order.
    const result = await putLineup(auth, fixtureId, entrantId, {
      slots: [
        { person_id: playerTwo.id, slot: "starting", position_key: "bogus_two", order_no: 2, roles: [] },
        { person_id: playerOne.id, slot: "starting", position_key: "bogus_one", order_no: 1, roles: [] },
      ],
    });

    const read = await getLineup(auth, fixtureId, entrantId);
    const storedOrder = (read.slots as { person_id: string }[]).map((s) => s.person_id);
    expect(storedOrder).toEqual([playerOne.id, playerTwo.id]); // fixture proof: the read really does reorder

    const unknownPosition = result.warnings.filter((w) => /unknown position/i.test(w));
    expect(unknownPosition).toHaveLength(2);
    // The assertion that fails when the warnings are sourced from the
    // request: sent Two first, so a request-sourced list names Two first.
    expect(unknownPosition[0]).toContain(playerOne.id);
    expect(unknownPosition[1]).toContain(playerTwo.id);
  });
});
