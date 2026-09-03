// V356 (#428, S4) — persons.lane grows 'coach' and 'staff', closing S3/#426
// ruling 3's carried caveat: LineupSlot.role shipped 'player'|'coach'|'staff'
// engine-only, but persons.lane (V348) only knew 'player'/'official' (a MATCH
// official — referee/umpire — per V348's own comment), so a team coach had no
// lane to register under. Schema-only, additive, no backfill.
//
// Real Postgres required: this exercises the actual CHECK constraint and the
// actual partial unique index, not a mock of either.
//
// G1 (bench B03 product-gaps, 2026-09-02): the CHECK above shipped 18 months
// before any application writer could produce 'coach'/'staff' — CreatePerson
// had no `lane` field at all, and neither did the entrant-registration inline
// `new_person` path. The describe block below is that writer's own test: it
// goes through the real `createPerson`/`createEntrants` usecases (not a raw
// insert like the block above), because a usecase test is the only thing that
// can see whether the REQUEST SCHEMA actually threads the value through —
// the CHECK passing was never in doubt.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson, getPerson } from "../persons";
import { makeUser, seedOrg, GENERIC_CONFIG } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function insertPerson(
  orgId: string,
  fullName: string,
  lane: string,
  userId?: string | null,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, lane, user_id)
    values (${orgId}, ${fullName}, ${lane}, ${userId ?? null})
    returning id`;
  return row.id;
}

describe.skipIf(!HAS_DB)("persons.lane — coach/staff (V356, S4/#428)", () => {
  it("accepts 'coach' and 'staff' where only 'player'/'official' were legal before", async () => {
    const { auth } = await seedOrg();
    const coachId = await insertPerson(auth.orgId, "Coach One", "coach");
    const staffId = await insertPerson(auth.orgId, "Physio One", "staff");
    const rows = await sql<{ id: string; lane: string }[]>`
      select id, lane from persons where id in (${coachId}, ${staffId}) order by lane`;
    expect(rows).toEqual([
      { id: coachId, lane: "coach" },
      { id: staffId, lane: "staff" },
    ]);
  });

  it("still rejects a lane outside the closed set", async () => {
    const { auth } = await seedOrg();
    await expect(insertPerson(auth.orgId, "Bad Lane", "physio")).rejects.toThrow(
      /persons_lane_check/,
    );
  });

  it("persons_org_user_lane_uq (V348) still excludes the new lanes — two coach rows for the SAME (org,user) do not collide", async () => {
    const { auth } = await seedOrg();
    const user = await makeUser("SameHuman");
    const coach1 = await insertPerson(auth.orgId, "Coach A", "coach", user.id);
    const coach2 = await insertPerson(auth.orgId, "Coach A (dup)", "coach", user.id);
    expect(coach1).not.toBe(coach2); // both inserts succeeded — no unique violation
  });

  it("the partial index still enforces uniqueness on 'player', unchanged by this migration", async () => {
    const { auth } = await seedOrg();
    const user = await makeUser("OnePlayer");
    await insertPerson(auth.orgId, "Player A", "player", user.id);
    await expect(insertPerson(auth.orgId, "Player A (dup)", "player", user.id)).rejects.toThrow(
      /persons_org_user_lane_uq/,
    );
  });
});

describe.skipIf(!HAS_DB)("persons.lane writer (G1, bench B03 product-gaps)", () => {
  it("POST /persons' usecase (createPerson) writes and round-trips lane='coach'", async () => {
    const { auth } = await seedOrg();
    const created = await createPerson(auth, {
      full_name: "Coach Via API",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
      lane: "coach",
    });
    expect(created.lane).toBe("coach");
    const fetched = await getPerson(auth, created.id);
    expect(fetched.lane).toBe("coach");
  });

  it("omitting lane still defaults to 'player' — the pre-existing behavior is unchanged", async () => {
    const { auth } = await seedOrg();
    const created = await createPerson(auth, {
      full_name: "No Lane Given",
      consent: {},
      dob: null,
      gender: null,
      external_ref: null,
    });
    expect(created.lane).toBe("player");
  });

  it("registering a coach AS AN INLINE SQUAD MEMBER (V356's own motivating scenario) writes lane='staff'", async () => {
    const { auth } = await seedOrg();
    const [{ id: competitionId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, ends_on, visibility, branding)
      values (${auth.orgId}, 'G1 Cup', ${"g1-cup-" + auth.orgId.slice(0, 8)}, '2030-12-31', 'private', '{}')
      returning id`;
    const division = await createDivision(auth, competitionId, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const [entrant] = await createEntrants(auth, division.id, [
      {
        kind: "team" as const,
        display_name: "Squad",
        seed: 1,
        members: [
          { new_person: { full_name: "Team Physio", lane: "staff" }, is_captain: false, roles: [] },
        ],
      } as never,
    ]);
    expect(entrant).toBeTruthy();
    const rows = await sql<{ lane: string }[]>`
      select p.lane from entrant_members em
      join persons p on p.id = em.person_id
      where em.entrant_id = ${entrant!.id}`;
    expect(rows).toEqual([{ lane: "staff" }]);
  });
});
