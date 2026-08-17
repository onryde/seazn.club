// #404 Task 2 — a tombstoned person (persons.merged_into non-null, V349) is
// invisible to every read except the merge history. Nothing in the type system
// catches a read that forgot the filter, so these three tests stand in for the
// whole surface: the organiser list, both public views, and the identity upsert
// that arbitrates on the partial unique index the tombstone must stop holding.
//
// Real Postgres required (views, partial index, ON CONFLICT inference).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson, listPersons } from "../persons";
import { confirmRegistration } from "../registrations";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

async function seedPublicDivision(
  auth: AuthCtx,
): Promise<{ divisionId: string; orgSlug: string; compSlug: string }> {
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Tombstone Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
    eligibility: [],
  });
  return { divisionId: division.id, orgSlug, compSlug: competition.slug };
}

async function makeLoginUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`t404-${randomUUID().slice(0, 8)}@test.local`}, 'Session User', true)
    returning id`;
  return u.id;
}

/**
 * Direct V363/V364 fixture: the group → entry → player-row chain
 * `submitRegistration` used to write in one call (deleted, RS001 demolition
 *). `userId` lands on the ONE player row, mimicking what RS002/RS003
 * (submit) or RS008 (claim) will eventually stamp there — never the group's
 * own `user_id`, which belongs to the contact, not the player.
 */
async function seedLinkedEntry(
  divisionId: string,
  playerName: string,
  userId: string | null,
): Promise<{ id: string }> {
  const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash)
    values (
      ${competitionId}, 'Contact', ${`c-${randomUUID().slice(0, 8)}@test.local`},
      ${`tok-${randomUUID()}`}
    )
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name)
    values (${group.id}, ${divisionId}, ${playerName})
    returning id`;
  await sql`
    insert into registration_players (registration_id, full_name, user_id, source)
    values (${reg.id}, ${playerName}, ${userId}, 'captain_entered')`;
  return reg;
}

describe.skipIf(!HAS_DB)("#404 a tombstoned person is invisible", () => {
  it("listPersons omits a tombstoned person, on the first page and after a cursor", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await createPerson(auth, { full_name: "Alex Morgan", consent: {} });
    const absorbed = await createPerson(auth, { full_name: "Alex Morgan", consent: {} });
    const third = await createPerson(auth, { full_name: "Zoe Last", consent: {} });
    await sql`update persons set merged_into = ${survivor.id} where id = ${absorbed.id}`;

    const first = await listPersons(auth, { cursor: null, limit: 50 });
    const firstIds = first.items.map((p) => p.id);
    expect(firstIds).toEqual([survivor.id, third.id]);

    // The cursor branch is a SECOND hand-written statement in listPersons; a
    // filter added to only one of them passes the page-one assertion above.
    // The cursor is deliberately the epoch rather than survivor.created_at:
    // postgres returns timestamptz as a JS Date, which truncates the row's
    // microseconds and would make the page boundary itself the thing under test.
    const after = await listPersons(auth, {
      cursor: { createdAt: "1970-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000000" },
      limit: 50,
    });
    expect(after.items.map((p) => p.id)).toEqual([survivor.id, third.id]);
  });

  it("neither public view exposes a tombstoned person", async () => {
    const { auth } = await seedOrg("pro");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, 'dashboard.player_profiles', true, 'test')`;
    const consent = { public_name: true, public_photo: true };
    const survivor = await createPerson(auth, { full_name: "Alice Wonder", consent });
    const absorbed = await createPerson(auth, { full_name: "Alice Wonder", consent });
    const div = await seedPublicDivision(auth);
    // Both sit on ONE entrant: the merge repoints entrant_members, but a board
    // published before the merge still carries the absorbed row until then, and
    // the public read must not wait for that.
    await createEntrants(auth, div.divisionId, [
      {
        kind: "pair",
        display_name: "Wonder & Wonder",
        seed: 1,
        members: [
          { person_id: survivor.id, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
          { person_id: absorbed.id, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
        ],
      },
    ]);
    await sql`update persons set merged_into = ${survivor.id} where id = ${absorbed.id}`;

    const [entrant] = await sql<{ members: Record<string, unknown>[] }[]>`
      select members from public_entrants_v where division_id = ${div.divisionId}`;
    const memberIds = entrant.members.map((m) => m["person_id"]);
    expect(memberIds).toContain(survivor.id);
    expect(memberIds).not.toContain(absorbed.id);
    expect(entrant.members).toHaveLength(1);

    const players = await sql<{ id: string }[]>`
      select id from public_players_v where org_id = ${auth.orgId}`;
    const playerIds = players.map((p) => p.id);
    expect(playerIds).toContain(survivor.id);
    expect(playerIds).not.toContain(absorbed.id);
  });

  // "a registration upsert lands on the survivor, not the tombstone" — RESTORED
  // (RS001 follow-up): `resolvePlayerPerson` is back on `materialise`'s call
  // path (`registration_players.user_id`, not `registrations.user_id` —
  // that column moved with the group/entry split, V363/V364). Reached here by
  // seeding a player row directly rather than through the deleted
  // `submitRegistration` — see registration-user-link.test.ts's file header
  // for why the direct-SQL fixture is equivalent for this purpose.
  it("a registration upsert lands on the survivor, not the tombstone", async () => {
    const { auth } = await seedOrg("pro");
    const userId = await makeLoginUser();
    const divA = await seedPublicDivision(auth);
    const divB = await seedPublicDivision(auth);

    // The registration mints the account's player person...
    const a = await seedLinkedEntry(divA.divisionId, "Sam Player", userId);
    await confirmRegistration(auth, a.id);
    const [minted] = await sql<{ id: string }[]>`
      select id from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;

    // ...and an organiser then merges it into an imported duplicate. The
    // tombstone must release the (org, user, lane) identity slot so the
    // survivor can take it — this is the state the ON CONFLICT has to survive.
    const [survivor] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, lane) values (${auth.orgId}, 'Sam Player', 'player')
      returning id`;
    await sql`update persons set merged_into = ${survivor.id} where id = ${minted.id}`;
    await sql`update persons set user_id = ${userId} where id = ${survivor.id}`;

    // The next registration by the same account must land on the survivor. With
    // a statement predicate that no longer implies the index predicate Postgres
    // cannot infer the arbiter at all and this throws 42P10, not 23505.
    const b = await seedLinkedEntry(divB.divisionId, "Sam Player", userId);
    const confirmed = await confirmRegistration(auth, b.id);
    const [member] = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(member.person_id).toBe(survivor.id);

    const live = await sql<{ id: string }[]>`
      select id from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'
         and merged_into is null`;
    expect(live.map((r) => r.id)).toEqual([survivor.id]);
  });
});
