// V356 (#428, S4) — persons.lane grows 'coach' and 'staff', closing S3/#426
// ruling 3's carried caveat: LineupSlot.role shipped 'player'|'coach'|'staff'
// engine-only, but persons.lane (V348) only knew 'player'/'official' (a MATCH
// official — referee/umpire — per V348's own comment), so a team coach had no
// lane to register under. Schema-only, additive, no backfill.
//
// Real Postgres required: this exercises the actual CHECK constraint and the
// actual partial unique index, not a mock of either.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { makeUser, seedOrg } from "./_seed";

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
