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

  // "a registration upsert lands on the survivor, not the tombstone" DELETED
  // (RS001 registration demolition, #588): its subject was `resolvePlayerPerson`
  // — the ON-CONFLICT-by-(org_id,user_id,lane) upsert this test proved keeps
  // arbitrating correctly even across a tombstone — reached via
  // submitRegistration's session capture + confirmRegistration. Both links in
  // that chain are gone: submitRegistration is deleted, AND (independently)
  // `materialise`/`confirmRegistration` no longer CALLS `resolvePlayerPerson`
  // at all — `registration_players` carries no user_id for it to resolve
  // against (see registrations.ts's `resolvePlayerPerson`/`loadPlayers` doc
  // comments: "Orphaned by the RS001 registration demolition… RS002/RS008
  // need this exact upsert once the claim flow supplies a real link"). A
  // seeded input cannot fix this — the upsert call site itself does not run
  // today, so nothing would land on the survivor to assert against. Tracked
  // for #404's review queue; RS002/RS008 own re-wiring the call and
  // re-testing this file's premise once the claim flow supplies a real link.
});
