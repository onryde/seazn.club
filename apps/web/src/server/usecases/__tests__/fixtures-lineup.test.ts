// S12/#421 pass D — `putLineup`/`getLineup` (fixtures.ts) round-trip `role`
// and the new `pair_order` (V361) through real Postgres. Real Postgres
// required; skipped without DATABASE_URL, same convention as every other
// DB-backed usecase suite in this directory (see scorers.test.ts).
//
// Nothing in this directory called `putLineup`/`getLineup` with a real
// `person_id` before this file (scorers.test.ts only ever exercises
// `slots: []`, which skips the entrant_members membership check entirely) —
// this is new ground, not an extension of an existing suite.
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

describe.skipIf(!HAS_DB)("putLineup/getLineup — role and pair_order round-trip (S12/#421 pass D, V361)", () => {
  it("a coach's role and a starter's pairOrder both survive save -> read", async () => {
    const auth = await seedOrg();
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

    const [player] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Player One') returning id`;
    const [coach] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Coach One') returning id`;
    await sql`
      insert into entrant_members (entrant_id, person_id)
      values (${entrantA.id}, ${player.id}), (${entrantA.id}, ${coach.id})`;

    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    const fx = fixtures[0];

    await putLineup(auth, fx.id, entrantA.id, {
      slots: [
        {
          person_id: player.id,
          slot: "starting",
          position_key: null,
          order_no: 1,
          roles: [],
          role: "player",
          pair_order: 1,
        },
        {
          person_id: coach.id,
          slot: "starting",
          position_key: null,
          order_no: 2,
          roles: [],
          role: "coach",
          pair_order: null,
        },
      ],
    });

    const read = await getLineup(auth, fx.id, entrantA.id);
    const rows = read.slots as { person_id: string; role: string; pair_order: number | null }[];
    const playerRow = rows.find((r) => r.person_id === player.id);
    const coachRow = rows.find((r) => r.person_id === coach.id);
    expect(playerRow?.role).toBe("player");
    expect(playerRow?.pair_order).toBe(1);
    expect(coachRow?.role).toBe("coach");
    expect(coachRow?.pair_order).toBeNull();
  });

  it("omitting role/pair_order defaults to player and null (pre-existing callers keep working)", async () => {
    const auth = await seedOrg();
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
    const [entrantA] = await createEntrants(auth, division.id, [
      { kind: "individual" as const, display_name: "A", seed: 1, members: [] },
      { kind: "individual" as const, display_name: "B", seed: 2, members: [] },
    ]);
    const [player] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Player One') returning id`;
    await sql`insert into entrant_members (entrant_id, person_id) values (${entrantA.id}, ${player.id})`;
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    const fx = fixtures[0];

    await putLineup(auth, fx.id, entrantA.id, {
      slots: [{ person_id: player.id, slot: "starting", position_key: null, order_no: 1, roles: [] }],
    });
    const read = await getLineup(auth, fx.id, entrantA.id);
    const row = (read.slots as { person_id: string; role: string; pair_order: number | null }[])[0];
    expect(row?.role).toBe("player");
    expect(row?.pair_order).toBeNull();
  });

  // R8 sweep, WS-SQ fix round 1 (IMPORTANT 1). `readLineup` is the pad's ONLY
  // producer — both pad loaders reach it through `getLineup`
  // (`f/[no]/page.tsx`, `score/[token]/page.tsx`) — and it is the one hop in
  // the squadNumber chain that was already correct, so nothing tested it.
  // Drop `em.squad_number` from that query and every other test in this wave
  // stays green while the swap badge goes dark: the identical defect, on the
  // hop that actually feeds the screen.
  //
  // `squad_number` is NOT a `lineups` column — it lives on `entrant_members`
  // and arrives through `readLineup`'s LEFT join, which is why the
  // un-numbered member below is a real case and not defensive padding.
  it("a member's squad number rides the lineup read model — the pad's only producer", async () => {
    const auth = await seedOrg();
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
    const [entrantA] = await createEntrants(auth, division.id, [
      { kind: "individual" as const, display_name: "A", seed: 1, members: [] },
      { kind: "individual" as const, display_name: "B", seed: 2, members: [] },
    ]);
    const [numbered] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Numbered Nine') returning id`;
    const [unnumbered] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'No Number') returning id`;
    // The number is declared on the MEMBERSHIP, which is the whole point of
    // the join under test.
    await sql`
      insert into entrant_members (entrant_id, person_id, squad_number)
      values (${entrantA.id}, ${numbered.id}, 9), (${entrantA.id}, ${unnumbered.id}, null)`;

    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    const fx = fixtures[0];

    await putLineup(auth, fx.id, entrantA.id, {
      slots: [
        { person_id: numbered.id, slot: "starting", position_key: null, order_no: 1, roles: [] },
        { person_id: unnumbered.id, slot: "bench", position_key: null, order_no: 2, roles: [] },
      ],
    });

    const read = await getLineup(auth, fx.id, entrantA.id);
    const rows = read.slots as { person_id: string; squad_number: number | null }[];
    expect(rows).toHaveLength(2); // non-vacuous: the read really returned both slots
    expect(rows.find((r) => r.person_id === numbered.id)?.squad_number).toBe(9);
    // A member with no declared number reads back as null, never absent and
    // never invented — `toLineupSlot` relies on `!= null` to omit the field.
    expect(rows.find((r) => r.person_id === unnumbered.id)?.squad_number).toBeNull();
  });
});
