// V439 video + flags + audit. Four claims that are not derivable from the DDL:
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
import { SUPERUSER_ONLY } from "../../../../../../scripts/rls-exempt.ts";

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

describe.skipIf(!HAS_DB)("video, flags and audit schema (V439)", () => {
  let orgId = "";
  let fixtureId = "";
  /** A second fixture in the same stage, with NO meeting row — the only way to
   *  reach the participant FK with a fixture that genuinely exists.
   *  `seedOnlineChessFixture` creates exactly one fixture, so this suite seeds
   *  the second one itself. */
  let meetinglessFixtureId = "";
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

  // V442 (T13, controller ruling C1): camera evidence is read after the
  // meeting ends — never before — and a settled stamp is what stops a re-run
  // writing a second flag. Every write here is rolled back (a sentinel), so
  // the shared meeting row stays as beforeAll made it.
  const ROLLBACK = new Error("rollback sentinel");
  const rolledBack = (write: (tx: typeof sql) => Promise<unknown>): Promise<Outcome> =>
    sql
      .begin(async (tx) => {
        await write(tx as unknown as typeof sql);
        throw ROLLBACK;
      })
      .then(
        () => ({ accepted: false as const, code: "NO_ROLLBACK", constraint: undefined }),
        (err: { code?: string; constraint_name?: string }) =>
          err === ROLLBACK
            ? { accepted: true as const }
            : { accepted: false as const, code: err.code, constraint: err.constraint_name },
      );

  it("C1: a meeting's camera evidence starts unsettled (null)", async () => {
    const [row] = await sql<{ camera_evidence_at: Date | null }[]>`
      select camera_evidence_at from fixture_video_meetings where fixture_id = ${fixtureId}`;
    expect(row, "premise: the meeting row exists").toBeDefined();
    expect(row!.camera_evidence_at).toBeNull();
  });

  it("C1: camera evidence cannot be settled on a meeting that has not ENDED", async () => {
    expect(await rolledBack((tx) => tx`
      update fixture_video_meetings set camera_evidence_at = now() where fixture_id = ${fixtureId}`,
    )).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_meetings_camera_evidence_check" });
  });

  it("C1 (the pair): an ENDED meeting's evidence settles", async () => {
    expect(await rolledBack((tx) => tx`
      update fixture_video_meetings set ended_at = now(), camera_evidence_at = now() where fixture_id = ${fixtureId}`,
    )).toEqual({ accepted: true });
  });

  // V442 (T14 re-review 3, I-1): a guard fault is OUR safeguard taking the
  // player's camera out of the meeting. Every write is rolled back.
  describe("guard faults (I-1): our safeguard's gap, never the player's", () => {
    const fault = (tx: typeof sql, o: { startedAt?: string; endedAt?: string | null; fixture?: string } = {}) => tx`
      insert into fixture_video_guard_faults (fixture_id, person_id, started_at, ended_at)
      values (${o.fixture ?? fixtureId}, ${personId}, ${o.startedAt ?? "2026-10-12T10:00:00Z"}, ${o.endedAt ?? null})`;

    it("an open fault, and a closed one whose end follows its start, are accepted", async () => {
      expect(await rolledBack((tx) => fault(tx))).toEqual({ accepted: true });
      expect(await rolledBack((tx) => fault(tx, { endedAt: "2026-10-12T10:00:20Z" }))).toEqual({ accepted: true });
      expect(await rolledBack((tx) => fault(tx, { endedAt: "2026-10-12T10:00:00Z" })), "a zero-length fault").toEqual({ accepted: true });
    });

    it("an end BEFORE its start is refused, by name", async () => {
      expect(await rolledBack((tx) => fault(tx, { endedAt: "2026-10-12T09:59:59Z" }))).toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_guard_faults_interval_check",
      });
    });

    it("at most ONE open fault per player per fixture — and any number of closed ones beside it", async () => {
      expect(await rolledBack(async (tx) => {
        await fault(tx);
        await fault(tx, { startedAt: "2026-10-12T10:05:00Z" });
      })).toEqual({ accepted: false, code: "23505", constraint: "fixture_video_guard_faults_open_idx" });
      expect(await rolledBack(async (tx) => {
        await fault(tx, { endedAt: "2026-10-12T10:00:10Z" });
        await fault(tx, { startedAt: "2026-10-12T10:01:00Z", endedAt: "2026-10-12T10:01:10Z" });
        await fault(tx, { startedAt: "2026-10-12T10:02:00Z" });
      })).toEqual({ accepted: true });
    });

    it("a fault needs the fixture's MEETING — a real fixture with none is refused", async () => {
      expect(meetinglessFixtureId).not.toBe(fixtureId);
      expect(await rolledBack((tx) => fault(tx, { fixture: meetinglessFixtureId }))).toEqual({
        accepted: false, code: FK_VIOLATION, constraint: "fixture_video_guard_faults_fixture_id_fkey",
      });
    });

    it("sealed: row security enabled AND forced, with no policy (reached only through the privileged client)", async () => {
      const [t] = await sql<{ enabled: boolean; forced: boolean; policies: number }[]>`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
               (select count(*)::int from pg_policies p where p.tablename = c.relname and p.schemaname = n.nspname) as policies
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relname = 'fixture_video_guard_faults' and n.nspname = current_schema()`;
      expect(t).toEqual({ enabled: true, forced: true, policies: 0 });
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

  // camera_connection_problems (T14 fix round 5, ruling 1): the NEUTRAL flag
  // job 5 raises when our safeguard's stamps pile up in one match.
  it.each(["camera_lost", "out_of_band_play", "camera_connection_problems"])("accepts an open %s flag", async (kind) => {
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

  // T6 ruling Q2: a camera-policy change is a competition SETTINGS change, so
  // it is recorded once, in competition_events (`chess.camera_policy_changed`),
  // never here too. `policy_downgrade` left this table's vocabulary; what was
  // its well-formed row must now be refused — by the KIND check, not by the
  // shape check that also rejects an unknown kind (`else false`). Rolled back
  // so a mutant that lets it in leaves nothing behind.
  it("policy_downgrade is no longer an audit kind here — refused by the kind check", async () => {
    // BOTH checks refuse this row: the kind check, and the shape check, whose
    // CASE falls to `else false` for any kind but video_override. Postgres
    // evaluates CHECK constraints in name order, so `online_chess_audit_kind_check`
    // (k < s) is the one reported; dropping it would surface the shape check
    // instead and fail this assertion.
    const ROLLBACK = new Error("rollback sentinel");
    let outcome: Outcome | undefined;
    await sql
      .begin(async (tx) => {
        outcome = await attempt(tx`
          insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
          values (${orgId}, ${fixtureId}, 'policy_downgrade', ${userId}, 'vendor outage')`);
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
    expect(outcome).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: "online_chess_audit_kind_check",
    });
  });

  // T6 fix round 1 (review M-3): with policy_downgrade gone, the columns only
  // it used (stage_id, from_policy, to_policy) were dropped from the unmerged
  // V439. Expected set typed from that ruling, not read from the table.
  it("the audit table carries only what a video override needs", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'online_chess_audit'
       order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ["actor_user_id", "created_at", "fixture_id", "id", "kind", "note", "org_id"],
    );
  });

  it("a video override audit row needs its fixture", async () => {
    expect(await attempt(sql`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
      values (${orgId}, ${fixtureId}, 'video_override', ${userId}, 'realtimekit 503, proceeding')`,
    )).toEqual({ accepted: true });
    expect(await attempt(sql`
      insert into online_chess_audit (org_id, kind, actor_user_id, note)
      values (${orgId}, 'video_override', ${userId}, 'no fixture')`,
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
  // CI's RLS guard (scripts/check-rls.ts, and rls-coverage.test.ts beside it) exempts a table by NAME, in
  // scripts/rls-exempt.ts. That name is a claim that no app_user connection can reach the table. These cases make the
  // claim the DATABASE's: a sealed table has no policy AND no grant, so an app_user query on it is refused (42501),
  // never silently empty.
  describe("sealed tables (V439, V442): forced RLS, no policy, no app_user privilege; the org_id ones exempt by name", () => {
    /** Typed from the migrations' own words (V439: "Sealed like V410's tables … no app_user policy"; stage_round_opens
     *  and V442's guard faults enable + force with no policy), never read from the catalogue. */
    const SEALED = [
      "fixture_play_flags", "fixture_video_guard_faults", "fixture_video_meetings",
      "fixture_video_participants", "online_chess_audit", "stage_round_opens",
    ];
    /** The four with an org_id column: the ones the RLS guard selects (CI red, 2026-10-13). */
    const WITH_ORG_ID = ["fixture_play_flags", "fixture_video_meetings", "online_chess_audit", "stage_round_opens"];
    const ANY_PRIVILEGE = "select, insert, update, delete, truncate, references, trigger";

    it("each is sealed: enabled AND forced, zero policies, and app_user holds no privilege on it", async () => {
      const rows = await sql<{ name: string; enabled: boolean; forced: boolean; policies: number; granted: boolean; hasOrgId: boolean }[]>`
        select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
               (select count(*)::int from pg_policies p where p.tablename = c.relname and p.schemaname = n.nspname) as policies,
               has_table_privilege('app_user', c.oid, ${ANY_PRIVILEGE}) as granted,
               exists (select 1 from information_schema.columns col
                        where col.table_schema = n.nspname and col.table_name = c.relname
                          and col.column_name = 'org_id') as "hasOrgId"
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relkind = 'r' and c.relname = any(${SEALED}::text[])
         order by c.relname`;
      expect(rows.map((r) => r.name), "tables checked").toEqual(SEALED);
      for (const r of rows) {
        expect({ name: r.name, enabled: r.enabled, forced: r.forced, policies: r.policies, granted: r.granted })
          .toEqual({ name: r.name, enabled: true, forced: true, policies: 0, granted: false });
      }
      expect(rows.filter((r) => r.hasOrgId).map((r) => r.name)).toEqual(WITH_ORG_ID);
    });

    it("the pair: the same probe reads app_user's grant on fixture_external_play, V439's one TENANT table", async () => {
      const [t] = await sql<{ granted: boolean; policies: number }[]>`
        select has_table_privilege('app_user', c.oid, ${ANY_PRIVILEGE}) as granted,
               (select count(*)::int from pg_policies p where p.tablename = c.relname and p.schemaname = n.nspname) as policies
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relname = 'fixture_external_play'`;
      expect(t).toEqual({ granted: true, policies: 1 });
    });

    it("the four with org_id are exempt by name, so the RLS guard reads them as sealed rather than as missing a policy", () => {
      expect(WITH_ORG_ID.filter((t) => SUPERUSER_ONLY.has(t))).toEqual(WITH_ORG_ID);
    });
  });
});
