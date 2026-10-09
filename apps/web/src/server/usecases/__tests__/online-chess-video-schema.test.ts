// V432 video + flags + audit. Four claims that are not derivable from the DDL:
//  - D6: N participants per fixture is the MODEL, so (fixture_id, person_id)
//    is deliberately NOT unique — a second angle is config later, not a
//    migration. The test proves two rows for one person are accepted.
//  - a participant cannot exist without a meeting (FK to the meeting row).
//  - a flag's resolution is all-or-nothing (closed_at ⇔ resolved_by).
//  - an audit row's actor cannot be deleted out from under it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "./_external-play-seed";

const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";
const HAS_DB = !!process.env.DATABASE_URL;

type Outcome =
  | { accepted: true }
  | { accepted: false; code: string | undefined; constraint: string | undefined };

const attempt = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ accepted: true as const })).catch(
    (err: { code?: string; constraint_name?: string }) => ({
      accepted: false as const, code: err.code, constraint: err.constraint_name,
    }),
  );

describe.skipIf(!HAS_DB)("video, flags and audit schema (V432)", () => {
  let orgId = "";
  let fixtureId = "";
  /** A second fixture in the same stage, with NO meeting row — the only way to
   *  reach the participant FK with a fixture that genuinely exists.
   *  `seedOnlineChessFixture` creates exactly one fixture, so this suite seeds
   *  the second one itself. */
  let meetinglessFixtureId = "";
  let stageId = "";
  let personId = "";
  let userId = "";

  beforeAll(async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess", divisionStarted: false, linked: true,
      scheduledAt: new Date(Date.now() + 86_400_000),
    });
    orgId = s.orgId;
    fixtureId = s.fixtureId;
    personId = s.home.personId;
    userId = s.home.userId;
    const [st] = await sql<{ id: string }[]>`
      select id from stages where division_id = ${s.divisionId}`;
    stageId = st!.id;
    const [other] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at)
      select stage_id, division_id, org_id, round_no, seq_in_round + 1,
             ${`nomeeting-${randomUUID().slice(0, 8)}`}, status, home_entrant_id,
             away_entrant_id, scheduled_at
        from fixtures where id = ${fixtureId}
      returning id`;
    meetinglessFixtureId = other!.id;
    await sql`
      insert into fixture_video_meetings (fixture_id, org_id, meeting_id)
      values (${fixtureId}, ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`})`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("one meeting per fixture — a second insert collides on the primary key", async () => {
    expect(await attempt(sql`
      insert into fixture_video_meetings (fixture_id, org_id, meeting_id)
      values (${fixtureId}, ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`})`,
    )).toEqual({
      accepted: false, code: "23505", constraint: "fixture_video_meetings_pkey",
    });
  });

  it("D6: two participants for ONE person are accepted — N angles are config, not a migration", async () => {
    for (const n of ["a", "b"]) {
      expect(await attempt(sql`
        insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
        values (${fixtureId}, ${personId}, 'player', ${`p-${n}-${randomUUID().slice(0, 8)}`})`,
      )).toEqual({ accepted: true });
    }
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from fixture_video_participants
       where fixture_id = ${fixtureId} and person_id = ${personId}`;
    expect(Number(count)).toBe(2);
  });

  it("a participant cannot exist without a meeting", async () => {
    // Anti-vacuity: the fixture this case uses is REAL and is not the one that
    // has a meeting — otherwise the rejection below would prove nothing.
    expect(meetinglessFixtureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(meetinglessFixtureId).not.toBe(fixtureId);
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from fixtures where id = ${meetinglessFixtureId}`;
    expect(Number(count)).toBe(1);
    expect(await attempt(sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${meetinglessFixtureId}, ${personId}, 'player', ${`p-${randomUUID().slice(0, 8)}`})`,
    )).toEqual({
      accepted: false, code: FK_VIOLATION,
      constraint: "fixture_video_participants_fixture_id_fkey",
    });
  });

  it.each(["camera_lost", "out_of_band_play"])("accepts an open %s flag", async (kind) => {
    expect(await attempt(sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, person_id)
      values (${fixtureId}, ${orgId}, ${kind}, ${personId})`,
    )).toEqual({ accepted: true });
  });

  it("refuses a flag kind outside the vocabulary", async () => {
    expect(await attempt(sql`
      insert into fixture_play_flags (fixture_id, org_id, kind)
      values (${fixtureId}, ${orgId}, 'suspicious_engine_use')`,
    )).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: "fixture_play_flags_kind_check",
    });
  });

  it("refuses a half-resolved flag in BOTH directions", async () => {
    expect(await attempt(sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, closed_at)
      values (${fixtureId}, ${orgId}, 'camera_lost', now())`,
    )).toEqual({
      accepted: false, code: CHECK_VIOLATION,
      constraint: "fixture_play_flags_resolution_check",
    });
    expect(await attempt(sql`
      insert into fixture_play_flags (fixture_id, org_id, kind, resolved_by)
      values (${fixtureId}, ${orgId}, 'camera_lost', ${userId})`,
    )).toEqual({
      accepted: false, code: CHECK_VIOLATION,
      constraint: "fixture_play_flags_resolution_check",
    });
  });

  it("a policy downgrade audit row needs its stage and both policies", async () => {
    expect(await attempt(sql`
      insert into online_chess_audit (org_id, stage_id, kind, actor_user_id, from_policy, to_policy, note)
      values (${orgId}, ${stageId}, 'policy_downgrade', ${userId}, 'required', 'optional', 'vendor outage')`,
    )).toEqual({ accepted: true });
    // The wrong shape differs from the right one by more than a missing field:
    // a downgrade carrying a fixture is a video override wearing the wrong kind.
    expect(await attempt(sql`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, from_policy, to_policy, note)
      values (${orgId}, ${fixtureId}, 'policy_downgrade', ${userId}, 'required', 'optional', 'wrong shape')`,
    )).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: "online_chess_audit_shape_check",
    });
  });

  it("a video override audit row needs its fixture and no policies", async () => {
    expect(await attempt(sql`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
      values (${orgId}, ${fixtureId}, 'video_override', ${userId}, 'realtimekit 503, proceeding')`,
    )).toEqual({ accepted: true });
    expect(await attempt(sql`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, from_policy, to_policy, note)
      values (${orgId}, ${fixtureId}, 'video_override', ${userId}, 'required', 'off', 'wrong shape')`,
    )).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: "online_chess_audit_shape_check",
    });
  });

  // Assumption as a guard, not a comment: "an audit row always has an actor".
  it("refuses deleting the actor of an audit row", async () => {
    expect(await attempt(sql`delete from users where id = ${userId}`)).toEqual({
      accepted: false, code: FK_VIOLATION,
      constraint: "online_chess_audit_actor_user_id_fkey",
    });
  });
});
