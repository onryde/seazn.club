// T15 fix round 1, C1 (D7 safeguarding): the ONE predicate "does this user
// play on this board?" that the arbiter's join, the arbiter panel's loader
// and the sweep's arbiter removal all ask. Every way a user maps to a seat is
// a yes:
//   - a member of either entrant, through a person linked to the user;
//   - a player camera participant on the fixture (T8's seat claim), which
//     outlives a roster edit;
//   - a check-in on the fixture (fixture_availability);
// each following the person-merge tombstone in both directions. The empty
// case first: no fixtures asked about ⇒ an empty answer, and a user who maps
// to none of them ⇒ no.
//
// Single-sport by construction: online play exists only for `boardgame`.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { stampFixtureCheckIn } from "../me";
import { fixturesSeating, isSeatedOn } from "../external-play/seated";
import { seedOnlineChessRound, seedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function meeting(fixtureId: string, orgId: string): Promise<void> {
  await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id)
            values (${fixtureId}, ${orgId}, ${`m-${randomUUID().slice(0, 8)}`}, (select home_entrant_id from fixtures where id = ${fixtureId}), (select away_entrant_id from fixtures where id = ${fixtureId}))`;
}

/** The roster edit a re-seat is: the entrant's member person replaced. */
async function replaceMember(entrantId: string, orgId: string): Promise<void> {
  const stand = await seedPlayer(orgId, "Stand-in", `s-${randomUUID().slice(0, 8)}`, false);
  await sql`delete from entrant_members where entrant_id = ${entrantId}`;
  await sql`insert into entrant_members (entrant_id, person_id, is_captain, roles) values (${entrantId}, ${stand.personId}, false, '{}')`;
}

describe.runIf(HAS_DB)("the seated predicate — the empty case first", () => {
  it("no fixtures asked about: an empty answer", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    expect([...(await fixturesSeating(r.boards[0]!.home.userId, []))]).toEqual([]);
  });

  it("the organiser who plays nowhere, and a stranger: seated on no board", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const ids = r.boards.map((b) => b.fixtureId);
    const stranger = await seedPlayer(r.orgId, "Nobody", `n-${randomUUID().slice(0, 8)}`, false);
    expect([...(await fixturesSeating(r.ownerUserId, ids))]).toEqual([]);
    expect([...(await fixturesSeating(stranger.userId, ids))]).toEqual([]);
  });
});

describe.runIf(HAS_DB)("the seated predicate — every way a user maps to a seat", () => {
  it("an entrant member, either side: seated on THAT board only", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [one, two] = r.boards;
    const ids = r.boards.map((b) => b.fixtureId);
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      expect([...(await fixturesSeating(one![side].userId, ids))], `board 1, ${side}`).toEqual([one!.fixtureId]);
      expect(await isSeatedOn(one![side].userId, one!.fixtureId)).toBe(true);
      expect(await isSeatedOn(one![side].userId, two!.fixtureId), "the positive pair: not board 2").toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("re-seated off the roster, still in the meeting as a player: seated", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    const b = r.boards[0]!;
    await meeting(b.fixtureId, r.orgId);
    // T8's seat claim (preflight seatPlayer) writes this row.
    await sql`insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
              values (${b.fixtureId}, ${b.home.personId}, 'player', ${`pp-${randomUUID().slice(0, 8)}`})`;
    await replaceMember(b.home.entrantId, r.orgId);
    expect(await isSeatedOn(b.home.userId, b.fixtureId)).toBe(true);
    // The positive pair: with no participant row, the roster edit WOULD free them.
    const bare = await seedOnlineChessRound({ fixtures: 1 });
    const c = bare.boards[0]!;
    await replaceMember(c.home.entrantId, bare.orgId);
    expect(await isSeatedOn(c.home.userId, c.fixtureId)).toBe(false);
  });

  it("re-seated off the roster after checking in: seated", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    const b = r.boards[0]!;
    await stampFixtureCheckIn(b.away.personId, b.fixtureId, r.orgId);
    await replaceMember(b.away.entrantId, r.orgId);
    expect(await isSeatedOn(b.away.userId, b.fixtureId)).toBe(true);
  });

  it("through a merge, both ways: the user's own person absorbed into the member, and the member absorbed into the user's", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [one, two] = r.boards;
    // (a) The member person is a tombstone merged into a live person whose
    //     user is the watcher — the roster still names the tombstone.
    const live = await seedPlayer(r.orgId, "Merged-into", `m-${randomUUID().slice(0, 8)}`, false);
    await sql`update persons set merged_into = ${live.personId}, user_id = null where id = ${one!.home.personId}`;
    expect(await isSeatedOn(live.userId, one!.fixtureId), "absorbed member ⇒ the survivor's user").toBe(true);
    // (b) The watcher's user sits on a tombstone merged INTO the member person.
    const ghost = await seedPlayer(r.orgId, "Ghost", `g-${randomUUID().slice(0, 8)}`, false);
    await sql`update persons set merged_into = ${two!.away.personId} where id = ${ghost.personId}`;
    expect(await isSeatedOn(ghost.userId, two!.fixtureId), "the user's tombstone ⇒ the survivor's seat").toBe(true);
    expect(await isSeatedOn(ghost.userId, one!.fixtureId), "the positive pair: only the survivor's board").toBe(false);
  });
});
