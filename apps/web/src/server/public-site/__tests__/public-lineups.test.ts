// Spectator surface W1, Task 5 — the public lineup reader. Real Postgres
// required (persons/lineups tables); skipped without DATABASE_URL, same
// convention as consent.test.ts beside this file.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { readPublicLineups } from "../public-lineups";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx; orgId: string; suffix: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgId,
    suffix,
  };
}

async function seedPerson(orgId: string, fullName: string, consent: Record<string, boolean>): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, photo_path, consent)
    values (${orgId}, ${fullName}, '2000-04-03', 'f', ${"photos/" + fullName}, ${sql.json(consent)})
    returning id`;
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("readPublicLineups (Task 5)", () => {
  it("readPublicLineups resolves names through the consent resolver — a public_name:false member is masked, never blank", async () => {
    const { auth, orgId } = await seedOrg();
    const publicFullName = "Alice Wonder";
    const privateFullName = "Bob Private";
    const publicPersonId = await seedPerson(orgId, publicFullName, { public_name: true });
    const privatePersonId = await seedPerson(orgId, privateFullName, { public_name: false });
    const awayPersonId = await seedPerson(orgId, "Carol Away", { public_name: true });

    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Match Centre Cup",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    const [home, away] = await createEntrants(auth, division.id, [
      {
        kind: "team",
        display_name: "Home Side",
        seed: 1,
        members: [
          { person_id: publicPersonId, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
          { person_id: privatePersonId, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
        ],
      },
      {
        kind: "team",
        display_name: "Away Side",
        seed: 2,
        members: [
          { person_id: awayPersonId, squad_number: 3, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const fixtureId = fixtures[0]!.id;
    const homeEntrantId = home!.id;
    const awayEntrantId = away!.id;

    // Inserted with the private person at order_no 1 and the public person at
    // order_no 2 — deliberately the REVERSE of insertion order below, so the
    // assertion can only pass if the reader actually orders by order_no
    // rather than by insertion/select order.
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
      values (${fixtureId}, ${homeEntrantId}, ${privatePersonId}, 'starting', null, 1, ${sql.json([])}, 'player', null)`;
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
      values (${fixtureId}, ${homeEntrantId}, ${publicPersonId}, 'starting', null, 2, ${sql.json([])}, 'player', null)`;
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
      values (${fixtureId}, ${awayEntrantId}, ${awayPersonId}, 'starting', null, 1, ${sql.json([])}, 'player', null)`;

    const homePersonIdsInOrder = [privatePersonId, publicPersonId];

    const lineups = await readPublicLineups(sql, fixtureId, { youth: false, player_name_display: null });
    const homeLineup = lineups[homeEntrantId]!;
    expect(homeLineup.map((p) => p.personId)).toEqual(homePersonIdsInOrder); // order_no ascending
    const masked = homeLineup.find((p) => p.personId === privatePersonId)!;
    expect(masked.masked).toBe(true);
    expect(masked.name).not.toBe("");
    expect(masked.name).not.toBe(privateFullName); // the NEGATIVE needs its POSITIVE pair:
    expect(homeLineup.find((p) => p.personId === publicPersonId)!.name).toBe(publicFullName);
    expect(homeLineup.find((p) => p.personId === publicPersonId)!.masked).toBe(false);

    const awayLineup = lineups[awayEntrantId]!;
    expect(awayLineup.map((p) => p.personId)).toEqual([awayPersonId]);
  });
});
