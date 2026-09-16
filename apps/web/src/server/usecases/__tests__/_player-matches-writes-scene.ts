// Spectator W2, Task 14 — the shared scene for the organiser-write suites that
// prove a write retires the public player page's cached match lines
// (`person-writes-player-matches-cache.test.ts`,
// `division-writes-player-matches-cache.test.ts`).
//
// Real rows end to end: a Pro org, one PUBLIC competition, one division, and
// one fixture IN PLAY between Ada (born 2013) and Ben (an adult), both
// consenting to a public name. The division starts with no age band and no
// name-display setting, so both names publish in full.
//
// The CALLER owns the mocks (`@/lib/cache`, `next/cache`, the logger): vitest
// hoists `vi.mock` per test file, and the modules imported here resolve
// through that file's mocks.
import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db/append-event";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { publicPlayerMatches } from "../public";

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

export async function scene(tag: string) {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = `pwc-${tag}-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Person writes ${tag} ${suffix}`}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })}, true)
    on conflict do nothing`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  const competition = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Writes Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const ada = await createPerson(owner, { full_name: "Ada Lovelace", consent: { public_name: true }, dob: "2013-01-01" });
  const ben = await createPerson(owner, { full_name: "Ben Stokes", consent: { public_name: true }, dob: null });
  await createEntrants(
    owner,
    division.id,
    [ada, ben].map((p, i) => ({
      kind: "individual" as const,
      display_name: p.full_name,
      seed: i + 1,
      members: [{ person_id: p.id, squad_number: null, default_position_key: null, is_captain: false, roles: [] }],
    })),
  );
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const { fixtures } = await generateStageFixtures(owner, stage!.id);
  await startDivision(owner, division.id);
  await appendEvent(orgId, fixtures[0]!.id, 0, { type: "core.start", payload: {}, recordedBy: null });
  const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtures[0]!.id}`;
  expect(status, "premise: the fixture is in play, so both players have a line").toBe("in_play");
  const genKey = `pub:v1:player-matches-gen:${competition.id}`;
  return { orgId, orgSlug, owner, ownerId, competition, division, ada, ben, genKey };
}

export type Scene = Awaited<ReturnType<typeof scene>>;

export const read = (s: Scene, personId: string) => publicPlayerMatches(s.orgSlug, s.competition.slug, personId);

export const opponentOf = async (s: Scene, personId: string) =>
  (await read(s, personId)).matches.map((m) => m.opponentName);

/** Every writer's DEL is sent, not awaited; let it land. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** End the pooled client so the worker exits (call from `afterAll`). */
export async function endSql(): Promise<void> {
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
}
