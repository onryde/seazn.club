// V439 video + flags + audit. Four claims that are not derivable from the DDL:
//  - D6: N participants per fixture is the MODEL, so (fixture_id, person_id)
//    is deliberately NOT unique — a second angle is config later, not a
//    migration. The test proves two rows for one person are accepted.
//  - a participant cannot exist without a meeting (FK to the meeting row).
//  - a flag's resolution is all-or-nothing (closed_at ⇔ resolved_by).
//  - an audit row's actor cannot be deleted out from under it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      values (${fixtureId}, 'home', ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`}, (select home_entrant_id from fixtures where id = ${fixtureId}), (select away_entrant_id from fixtures where id = ${fixtureId}))`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("one meeting per (fixture, side) — a second insert for the same side collides on the primary key", async () => {
    expect(await attempt(sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      values (${fixtureId}, 'home', ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`}, (select home_entrant_id from fixtures where id = ${fixtureId}), (select away_entrant_id from fixtures where id = ${fixtureId}))`,
    )).toEqual({
      accepted: false, code: "23505", constraint: "fixture_video_meetings_pkey",
    });
  });

  it("R2-2: a meeting names the pairing it was made for — an insert without either entrant is refused, on the meetingless fixture (counted)", async () => {
    // On the fixture with NO meeting, so the primary key cannot answer first (the not-null check would win anyway; this
    // keeps the refusal the column's alone).
    let checked = 0;
    for (const missing of ["home_entrant_id", "away_entrant_id"] as const) {
      const [f] = await sql<{ home: string; away: string }[]>`
        select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${meetinglessFixtureId}`;
      const got = await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        values (${meetinglessFixtureId}, 'home', ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`},
                ${missing === "home_entrant_id" ? null : f!.home}, ${missing === "away_entrant_id" ? null : f!.away})`.then(
        () => ({ accepted: true as const }),
        (err: { code?: string; column_name?: string }) => ({ accepted: false as const, code: err.code, column: err.column_name }),
      );
      expect(got, missing).toEqual({ accepted: false, code: "23502", column: missing });
      checked += 1;
    }
    expect(checked).toBe(2);
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
    const fault = (tx: typeof sql, o: { startedAt?: string; endedAt?: string | null; fixture?: string; side?: string } = {}) => tx`
      insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at, ended_at)
      values (${o.fixture ?? fixtureId}, ${o.side ?? "home"}, ${personId}, ${o.startedAt ?? "2026-10-12T10:00:00Z"}, ${o.endedAt ?? null})`;

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

    it("at most ONE open fault per player per meeting — and any number of closed ones beside it", async () => {
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
        accepted: false, code: FK_VIOLATION, constraint: "fixture_video_guard_faults_fixture_id_side_fkey",
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
        insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
        values (${fixtureId}, 'home', ${personId}, 'player', ${`p-${n}-${randomUUID().slice(0, 8)}`})`,
      )).toEqual({ accepted: true });
    }
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from fixture_video_participants
       where fixture_id = ${fixtureId} and person_id = ${personId}`;
    expect(Number(count)).toBe(2);
  });

  // V446 (D21): the seat gate's per-participant evidence cache. A participant starts with no read on file; the columns
  // move together (no outstanding read ⇒ nothing cached), and only the two not-yet verdicts are ever cached.
  describe("D21: the seat-read cache columns", () => {
    const insertWith = (cols: { reads?: number; at?: Date | null; state?: string | null; since?: Date | null }) =>
      rolledBack((tx) => tx`
        insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, seat_reads, seat_read_at, seat_read_state, seat_read_since)
        values (${fixtureId}, 'home', ${personId}, 'player', ${`p-c-${randomUUID().slice(0, 8)}`}, ${cols.reads ?? 0}, ${cols.at ?? null}, ${cols.state ?? null}, ${cols.since ?? null})`);
    const NOW = new Date("2026-10-15T09:00:00Z");

    it("a participant starts with no read on file (never read, zero reads, nothing cached)", async () => {
      const pid = `p-cache-${randomUUID().slice(0, 8)}`;
      await sql`
        insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
        values (${fixtureId}, 'home', ${personId}, 'player', ${pid})`;
      const [row] = await sql<{ seat_read_at: Date | null; seat_reads: number; seat_read_state: string | null; seat_read_since: Date | null }[]>`
        select seat_read_at, seat_reads, seat_read_state, seat_read_since from fixture_video_participants where participant_id = ${pid}`;
      expect(row).toEqual({ seat_read_at: null, seat_reads: 0, seat_read_state: null, seat_read_since: null });
    });

    it("the read count cannot be negative (the pair: zero is accepted)", async () => {
      expect(await insertWith({ reads: -1 })).toMatchObject({ accepted: false, code: CHECK_VIOLATION });
      expect(await insertWith({ reads: 0 })).toEqual({ accepted: true });
    });

    it("no outstanding read ⇒ nothing cached: a stamp, a state or a since beside a zero count is refused — each alone, counted", async () => {
      let checked = 0;
      for (const cols of [{ at: NOW }, { state: "starting", since: NOW }, { since: NOW }]) {
        expect(await insertWith({ reads: 0, ...cols }), JSON.stringify(cols)).toMatchObject({
          accepted: false, code: CHECK_VIOLATION,
        });
        checked += 1;
      }
      expect(checked).toBe(3);
      // The pairs: the same columns beside an outstanding read are fine.
      expect(await insertWith({ reads: 1, at: NOW })).toEqual({ accepted: true });
      expect(await insertWith({ reads: 2, at: NOW, state: "unreadable", since: NOW })).toEqual({ accepted: true });
    });

    it("only the two not-yet verdicts are cached, and a cached verdict always carries its peer's join time", async () => {
      for (const state of ["on", "off", "blocked", "absent", ""]) {
        expect(await insertWith({ reads: 1, at: NOW, state, since: NOW }), `state ${state}`).toMatchObject({
          accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_participants_seat_read_state_check",
        });
      }
      expect(await insertWith({ reads: 1, at: NOW, state: "starting", since: null }), "a verdict with no since").toMatchObject({
        accepted: false, code: CHECK_VIOLATION,
      });
      expect(await insertWith({ reads: 1, at: NOW, state: null, since: NOW }), "a since with no verdict").toMatchObject({
        accepted: false, code: CHECK_VIOLATION,
      });
      expect(await insertWith({ reads: 1, at: NOW, state: "starting", since: NOW }), "the pair").toEqual({ accepted: true });
    });
  });

  it("D21: the call budget's tokens cannot be negative, and one row per vendor key", async () => {
    const key = `schema-test|${randomUUID()}`;
    expect(await rolledBack((tx) => tx`
      insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, -1, now())`,
    )).toMatchObject({ accepted: false, code: CHECK_VIOLATION });
    expect(await rolledBack(async (tx) => {
      await tx`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, 0, now())`;
    }), "the pair: an empty bucket is a valid state").toEqual({ accepted: true });
    expect(await rolledBack(async (tx) => {
      await tx`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, 1, now())`;
      await tx`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, 2, now())`;
    })).toMatchObject({ accepted: false, code: "23505" });
  });

  it("V447: a seat's ask count is one row per (fixture, person, door); an ask count below 1 and a third door are refused; the pair is accepted", async () => {
    const insert = (route: string, asks: number, at = personId) => (tx: typeof sql) => tx`
      insert into fixture_seat_asks (fixture_id, person_id, route, window_started_at, asks)
      values (${fixtureId}, ${at}, ${route}, now(), ${asks})`;
    expect(await rolledBack(insert("seat", 1)), "the positive pair: a first ask on each door").toEqual({ accepted: true });
    expect(await rolledBack(insert("camera", 1))).toEqual({ accepted: true });
    expect(await rolledBack(insert("seat", 0)), "an ask count below 1 is no row").toMatchObject({ accepted: false, code: CHECK_VIOLATION });
    expect(await rolledBack(insert("arbiter", 1)), "the doors are a closed set: a third is a migration too").toMatchObject({
      accepted: false,
      code: CHECK_VIOLATION,
    });
    expect(
      await rolledBack(async (tx) => {
        await insert("seat", 1)(tx);
        await insert("seat", 2)(tx);
      }),
      "one row per seat per door",
    ).toMatchObject({ accepted: false, code: "23505" });
    expect(await rolledBack(insert("seat", 1, randomUUID())), "and the person is a person on file").toMatchObject({
      accepted: false,
      code: FK_VIOLATION,
    });
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
      insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
      values (${meetinglessFixtureId}, 'home', ${personId}, 'player', ${`p-${randomUUID().slice(0, 8)}`})`,
    )).toEqual({
      accepted: false, code: FK_VIOLATION,
      constraint: "fixture_video_participants_fixture_id_side_fkey",
    });
  });

  // camera_connection_problems (T14 fix round 5, ruling 1): the NEUTRAL flag
  // job 5 raises when our safeguard's stamps pile up in one match.
  // multiple_devices (T17B fix 2, D9; V444): job 5's flag for a player
  // connected from more than one place at the same time in the match.
  it.each(["camera_lost", "out_of_band_play", "camera_connection_problems", "multiple_devices"])("accepts an open %s flag", async (kind) => {
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

  // ─── V448 (D16): one meeting per PLAYER ──────────────────────────────────────────────────────────────────────────────
  describe("V448: a meeting per player (fixture, side)", () => {
    const meeting = (tx: typeof sql, side: string | null, o: { fixture?: string; meetingId?: string } = {}) => tx`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      values (${o.fixture ?? fixtureId}, ${side}, ${orgId}, ${o.meetingId ?? `mtg-${randomUUID().slice(0, 8)}`},
              (select home_entrant_id from fixtures where id = ${o.fixture ?? fixtureId}),
              (select away_entrant_id from fixtures where id = ${o.fixture ?? fixtureId}))`;
    const participant = (tx: typeof sql, side: string, o: { preset?: string; reported?: string | null; reportedAt?: Date | null } = {}) => tx`
      insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, camera_reported, camera_reported_at)
      values (${fixtureId}, ${side}, ${o.preset === "arbiter" ? null : personId}, ${o.preset ?? "player"}, ${`p-v448-${randomUUID().slice(0, 8)}`},
              ${o.reported ?? null}, ${o.reportedAt ?? null})`;

    it("a meeting names the side it is for: home and away are accepted, anything else is refused, and so is none (each counted)", async () => {
      let checked = 0;
      for (const side of ["home", "away"]) {
        // On the OTHER side's row of the seeded fixture: the seeded one already holds 'home'.
        const got = side === "away" ? await rolledBack((tx) => meeting(tx, "away")) : await rolledBack((tx) => meeting(tx, "home", { fixture: meetinglessFixtureId }));
        expect(got, side).toEqual({ accepted: true });
        checked += 1;
      }
      for (const side of ["white", "HOME", "", "both"]) {
        expect(await rolledBack((tx) => meeting(tx, side, { fixture: meetinglessFixtureId })), JSON.stringify(side)).toMatchObject({
          accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_meetings_side_check",
        });
        checked += 1;
      }
      expect(await rolledBack((tx) => meeting(tx, null, { fixture: meetinglessFixtureId })), "no side").toMatchObject({ accepted: false, code: "23502" });
      checked += 1;
      expect(checked).toBe(7);
    });

    it("both sides of one fixture can hold a meeting; each meeting id stays unique across them", async () => {
      expect(await rolledBack(async (tx) => {
        await meeting(tx, "away", { meetingId: "mtg-the-other-side" });
        const [{ count }] = await tx<{ count: string }[]>`select count(*)::text as count from fixture_video_meetings where fixture_id = ${fixtureId}`;
        expect(Number(count), "premise: two rows for one fixture").toBe(2);
      })).toEqual({ accepted: true });
      const [mine] = await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${fixtureId} and side = 'home'`;
      expect(await rolledBack((tx) => meeting(tx, "away", { meetingId: mine!.meeting_id })), "the same vendor room for both sides").toMatchObject({
        accepted: false, code: "23505", constraint: "fixture_video_meetings_meeting_id_key",
      });
    });

    it("a participant is on a meeting that exists: the other side's row is not enough", async () => {
      // 'home' has a meeting (beforeAll), 'away' has none.
      expect(await rolledBack((tx) => participant(tx, "home")), "the pair").toEqual({ accepted: true });
      expect(await rolledBack((tx) => participant(tx, "away"))).toMatchObject({
        accepted: false, code: FK_VIOLATION, constraint: "fixture_video_participants_fixture_id_side_fkey",
      });
      expect(await rolledBack(async (tx) => {
        await meeting(tx, "away");
        await participant(tx, "away");
      }), "and once away has its row").toEqual({ accepted: true });
    });

    it("deleting a side's meeting takes that side's participants and faults with it, and leaves the other side's", async () => {
      expect(await rolledBack(async (tx) => {
        await meeting(tx, "away");
        await participant(tx, "away");
        await participant(tx, "home");
        await tx`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at) values (${fixtureId}, 'away', ${personId}, now())`;
        await tx`delete from fixture_video_meetings where fixture_id = ${fixtureId} and side = 'away'`;
        const rows = await tx<{ side: string; n: number }[]>`
          select side, count(*)::int as n from (
            select side from fixture_video_participants where fixture_id = ${fixtureId}
            union all select side from fixture_video_guard_faults where fixture_id = ${fixtureId}) x group by side`;
        expect(rows.map((r) => r.side), "the away side is gone from both tables").not.toContain("away");
        expect(rows.find((r) => r.side === "home")!.n, "premise: the home side's rows are still there").toBeGreaterThan(0);
      })).toEqual({ accepted: true });
    });

    it("the open-fault rule is per meeting: one person can hold an open fault on each side, never two on the same", async () => {
      expect(await rolledBack(async (tx) => {
        await meeting(tx, "away");
        await tx`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at) values (${fixtureId}, 'home', ${personId}, now())`;
        await tx`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at) values (${fixtureId}, 'away', ${personId}, now())`;
      })).toEqual({ accepted: true });
    });

    describe("the opponent's pill: camera_reported and camera_reported_at on the player's participant row", () => {
      const T = new Date("2026-10-15T10:00:00Z");

      it("a participant starts with no report", async () => {
        const pid = `p-rep-${randomUUID().slice(0, 8)}`;
        await sql`
          insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
          values (${fixtureId}, 'home', ${personId}, 'player', ${pid})`;
        const [row] = await sql<{ camera_reported: string | null; camera_reported_at: Date | null }[]>`
          select camera_reported, camera_reported_at from fixture_video_participants where participant_id = ${pid}`;
        expect(row).toEqual({ camera_reported: null, camera_reported_at: null });
      });

      it("only live and off are reports; the state and its stamp move together; the pairs are accepted", async () => {
        expect(await rolledBack((tx) => participant(tx, "home", { reported: "live", reportedAt: T })), "live").toEqual({ accepted: true });
        expect(await rolledBack((tx) => participant(tx, "home", { reported: "off", reportedAt: T })), "off").toEqual({ accepted: true });
        let checked = 0;
        for (const state of ["unknown", "on", "LIVE", ""]) {
          expect(await rolledBack((tx) => participant(tx, "home", { reported: state, reportedAt: T })), JSON.stringify(state)).toMatchObject({
            accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_participants_camera_reported_check",
          });
          checked += 1;
        }
        expect(await rolledBack((tx) => participant(tx, "home", { reported: "live", reportedAt: null })), "a state with no stamp").toMatchObject({
          accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_participants_camera_report_pair_check",
        });
        expect(await rolledBack((tx) => participant(tx, "home", { reported: null, reportedAt: T })), "a stamp with no state").toMatchObject({
          accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_participants_camera_report_pair_check",
        });
        checked += 2;
        expect(checked).toBe(6);
      });

      it("an arbiter's row never carries a camera report (it has no camera to report)", async () => {
        expect(await rolledBack((tx) => participant(tx, "home", { preset: "arbiter", reported: "live", reportedAt: T }))).toMatchObject({
          accepted: false, code: CHECK_VIOLATION, constraint: "fixture_video_participants_camera_reported_player_check",
        });
      });
    });

    // ── The delta's own guard (§5.6.7, M6) ───────────────────────────────────────────────────────────────────────────
    // No harness here runs a Flyway migration from a test (v380-age-band-backfill.test.ts says so), so the real delta
    // file is read off disk and executed against a disposable SCRATCH SCHEMA holding the V439/V442/V446 shape of the
    // three tables. The replica is checked, not trusted: after the delta the scratch tables must have exactly the shape
    // the live (migrated) database has, so a replica that drifted from history, or a delta that does not land where
    // Flyway's run does, fails the comparison.
    describe("the delta's guard", () => {
      const DELTA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", "db", "migration", "deltas", "V448__video_meeting_per_player.sql");
      const delta = (): string => readFileSync(DELTA, "utf8");
      /** V439 + V442 + V446, the three tables as they were before V448. */
      const OLD_SHAPE = `
        create table fixture_video_meetings (
          fixture_id uuid primary key references fixtures(id) on delete cascade,
          org_id     uuid not null references organizations(id) on delete cascade,
          provider   text not null default 'realtimekit' check (provider in ('realtimekit')),
          meeting_id text not null unique,
          home_entrant_id uuid not null,
          away_entrant_id uuid not null,
          created_at timestamptz not null default now(),
          ended_at   timestamptz null,
          camera_evidence_at timestamptz null,
          constraint fixture_video_meetings_camera_evidence_check check (camera_evidence_at is null or ended_at is not null)
        );
        create index fixture_video_meetings_org_idx on fixture_video_meetings (org_id);
        create table fixture_video_participants (
          id uuid primary key default gen_random_uuid(),
          fixture_id uuid not null references fixture_video_meetings(fixture_id) on delete cascade,
          person_id uuid null references persons(id) on delete set null,
          preset text not null check (preset in ('player', 'arbiter')),
          participant_id text not null,
          last_publisher_seen_at timestamptz null,
          created_at timestamptz not null default now(),
          unique (fixture_id, participant_id),
          user_id uuid null references users(id) on delete set null,
          removed_at timestamptz null,
          seat_read_at timestamptz null,
          seat_reads integer not null default 0 check (seat_reads >= 0),
          seat_read_state text null,
          seat_read_since timestamptz null,
          constraint fixture_video_participants_user_check check (user_id is null or preset = 'arbiter'),
          constraint fixture_video_participants_removed_check check (removed_at is null or preset = 'arbiter'),
          constraint fixture_video_participants_seat_read_check check (
            seat_reads > 0 or (seat_read_at is null and seat_read_state is null and seat_read_since is null)),
          constraint fixture_video_participants_seat_read_state_check check (
            (seat_read_state is null and seat_read_since is null)
            or (seat_read_state is not null and seat_read_state in ('starting', 'unreadable') and seat_read_since is not null))
        );
        create index fixture_video_participants_person_idx on fixture_video_participants (fixture_id, person_id);
        create index fixture_video_participants_arbiter_open_idx
          on fixture_video_participants (fixture_id) where preset = 'arbiter' and removed_at is null;
        create table fixture_video_guard_faults (
          id uuid primary key default gen_random_uuid(),
          fixture_id uuid not null references fixture_video_meetings(fixture_id) on delete cascade,
          person_id uuid not null references persons(id) on delete cascade,
          started_at timestamptz not null,
          ended_at timestamptz null,
          constraint fixture_video_guard_faults_interval_check check (ended_at is null or ended_at >= started_at)
        );
        create unique index fixture_video_guard_faults_open_idx
          on fixture_video_guard_faults (fixture_id, person_id) where ended_at is null;`;
      const TABLES = ["fixture_video_meetings", "fixture_video_participants", "fixture_video_guard_faults"] as const;

      /** Every column, constraint and index of a table, as one sorted list of words: its shape. */
      async function shapeOf(tx: typeof sql, schema: string, table: string): Promise<string[]> {
        const cols = await tx<{ d: string }[]>`
          select a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || (case when a.attnotnull then ' not null' else '' end)
                 || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') as d
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where n.nspname = ${schema} and c.relname = ${table} and a.attnum > 0 and not a.attisdropped`;
        const cons = await tx<{ d: string }[]>`
          select 'constraint ' || k.conname || ' ' || pg_get_constraintdef(k.oid) as d
            from pg_constraint k
            join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = ${schema} and c.relname = ${table}`;
        const idx = await tx<{ d: string }[]>`
          select 'index ' || replace(indexdef, ${`${schema}.`}, '') as d from pg_indexes where schemaname = ${schema} and tablename = ${table}`;
        return [...cols, ...cons, ...idx].map((r) => r.d).sort();
      }

      const seedOld = async (tx: typeof sql, o: { ended: boolean }) => {
        const [f] = await tx<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
        await tx`
          insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at)
          values (${fixtureId}, ${orgId}, ${`old-${randomUUID().slice(0, 8)}`}, ${f!.home}, ${f!.away}, ${o.ended ? new Date() : null})`;
        await tx`
          insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
          values (${fixtureId}, ${personId}, 'player', ${`old-p-${randomUUID().slice(0, 8)}`})`;
        await tx`insert into fixture_video_guard_faults (fixture_id, person_id, started_at) values (${fixtureId}, ${personId}, now())`;
      };

      /** Runs `body` in a transaction whose search path puts a fresh schema (holding the OLD shape) ahead of the live one;
       *  always rolled back. */
      async function onOldShape<T>(body: (tx: typeof sql, live: string, scratch: string) => Promise<T>): Promise<T> {
        let out: { value: T } | undefined;
        try {
          await sql.begin(async (tx0) => {
            const tx = tx0 as unknown as typeof sql;
            const [{ live }] = await tx<{ live: string }[]>`select current_schema() as live`;
            const scratch = `v448_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
            await tx.unsafe(`create schema "${scratch}"`);
            await tx.unsafe(`set local search_path to "${scratch}", "${live}"`);
            await tx.unsafe(OLD_SHAPE);
            out = { value: await body(tx, live, scratch) };
            throw ROLLBACK;
          });
        } catch (err) {
          if (err !== ROLLBACK) throw err;
        }
        if (!out) throw new Error("onOldShape: body did not run");
        return out.value;
      }

      it("the file opens with the lock and then the guard, before anything is dropped, written or altered", () => {
        const body = delta().replace(/--[^\n]*/g, "").trim();
        expect(body.startsWith("lock table fixture_video_meetings in access exclusive mode;"), "the first statement").toBe(true);
        const afterLock = body.slice(body.indexOf(";") + 1).trimStart();
        expect(afterLock.startsWith("do "), "the second statement is the guard block").toBe(true);
        const guardEnd = body.indexOf("raise exception");
        expect(guardEnd, "the guard raises").toBeGreaterThan(0);
        for (const destructive of [/\bdelete from\b/i, /\balter table\b/i, /\bdrop\b/i, /\bcreate\b/i]) {
          const at = body.search(destructive);
          expect(at, String(destructive)).toBeGreaterThan(guardEnd);
        }
      });

      it("against a database with an UNENDED meeting it raises, naming the script to run first, and the old shape is untouched", async () => {
        const got = await onOldShape(async (tx) => {
          await seedOld(tx, { ended: false });
          // A savepoint: the failed delta must not poison the transaction the checks below read in.
          const refused = await tx.savepoint(async (sp) => (sp as unknown as typeof sql).unsafe(delta())).then(
            () => null,
            (err: { code?: string; message?: string }) => ({ code: err.code, message: err.message }),
          );
          const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from fixture_video_meetings`;
          const [{ side }] = await tx<{ side: number }[]>`
            select count(*)::int as side from information_schema.columns
             where table_schema = ((current_schemas(false))[1]) and table_name = 'fixture_video_meetings' and column_name = 'side'`;
          return { refused, rows: n, sideColumns: side };
        });
        expect(got.refused, "it raised").not.toBeNull();
        expect(got.refused!.message).toMatch(/chess-end-shared-meetings/);
        expect(got.rows, "nothing was dropped: the unended row is still there").toBe(1);
        expect(got.sideColumns, "and nothing was altered").toBe(0);
      });

      it("with ONLY ended meetings it applies: the shared rows go, and the three tables end up exactly as the migrated database has them", async () => {
        const got = await onOldShape(async (tx, live, scratch) => {
          await seedOld(tx, { ended: true });
          const before = await tx<{ n: number }[]>`select (select count(*) from fixture_video_meetings)::int + (select count(*) from fixture_video_participants)::int + (select count(*) from fixture_video_guard_faults)::int as n`;
          await tx.unsafe(delta());
          const after = await tx<{ n: number }[]>`select (select count(*) from fixture_video_meetings)::int + (select count(*) from fixture_video_participants)::int + (select count(*) from fixture_video_guard_faults)::int as n`;
          const applied: Record<string, string[]> = {};
          for (const t of TABLES) applied[t] = await shapeOf(tx, scratch, t);
          await tx.unsafe(`set local search_path to "${live}"`);
          const migrated: Record<string, string[]> = {};
          for (const t of TABLES) migrated[t] = await shapeOf(tx, live, t);
          return { before: before[0]!.n, after: after[0]!.n, applied, migrated };
        });
        expect(got.before, "premise: one meeting, one participant, one fault to drop").toBe(3);
        expect(got.after, "greenfield: the shared rows are gone").toBe(0);
        let compared = 0;
        for (const t of TABLES) {
          expect(got.applied[t]!.length, `${t}: something was compared`).toBeGreaterThan(5);
          expect(got.applied[t], t).toEqual(got.migrated[t]);
          compared += got.applied[t]!.length;
        }
        expect(compared).toBeGreaterThan(40);
      });

      it("a seat claim still in flight when the delta starts is SEEN: the delta waits for it on the table lock, then the guard raises (and had it rolled back, the delta applies)", async () => {
        // Committed scratch schema (a second connection has to SEE the table), dropped in the finally.
        const scratch = `v448_lock_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const [{ live }] = await sql<{ live: string }[]>`select current_schema() as live`;
        const [f] = await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
        const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
        const outcomeWhen = async (claim: "commits" | "rolls back"): Promise<string> => {
          let release!: () => void;
          const released = new Promise<void>((done) => (release = done));
          let inserted!: () => void;
          const insertedRow = new Promise<void>((done) => (inserted = done));
          // The claim: inserts an UNENDED meeting row and holds its transaction open.
          const claimTx = sql
            .begin(async (tx) => {
              await tx.unsafe(`set local search_path to "${scratch}", "${live}"`);
              await tx`
                insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id)
                values (${fixtureId}, ${orgId}, ${`claim-${randomUUID().slice(0, 8)}`}, ${f!.home}, ${f!.away})`;
              inserted();
              await released;
              if (claim === "rolls back") throw ROLLBACK;
            })
            .catch((err: unknown) => {
              if (err !== ROLLBACK) throw err;
            });
          await insertedRow;
          // The delta starts while the claim is in flight. Its guard cannot see an uncommitted row, so only the table
          // lock taken BEFORE the guard makes it wait for the claim and then see it.
          let settled = false;
          const deltaTx = sql
            .begin(async (tx) => {
              await tx.unsafe(`set local search_path to "${scratch}", "${live}"`);
              await tx.unsafe(delta());
            })
            .then(
              () => "applied",
              (err: { message?: string }) => err.message ?? "error",
            )
            .finally(() => void (settled = true));
          await sleep(400);
          expect(settled, "the delta is waiting on the claim, not racing past it").toBe(false);
          release();
          await claimTx;
          return deltaTx;
        };
        await sql.unsafe(`create schema "${scratch}"`);
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`set local search_path to "${scratch}", "${live}"`);
            await tx.unsafe(OLD_SHAPE);
          });
          expect(await outcomeWhen("commits"), "the committed claim is an unended row the guard now sees").toMatch(/chess-end-shared-meetings/);
          const [{ n }] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from "${scratch}".fixture_video_meetings`);
          expect(n, "and the claim's row is still there: nothing was dropped").toBe(1);
          await sql.unsafe(`delete from "${scratch}".fixture_video_meetings`);
          expect(await outcomeWhen("rolls back"), "the pair: a claim that rolled back leaves nothing to guard against").toBe("applied");
        } finally {
          await sql.unsafe(`drop schema if exists "${scratch}" cascade`);
        }
      });
    });
  });

  // CI's RLS guard (scripts/check-rls.ts, and rls-coverage.test.ts beside it) exempts a table by NAME, in
  // scripts/rls-exempt.ts. That name is a claim that no app_user connection can reach the table. These cases make the
  // claim the DATABASE's: a sealed table has no policy AND no grant, so an app_user query on it is refused (42501),
  // never silently empty.
  describe("sealed tables (V439, V442, V446, V447): forced RLS, no policy, no app_user privilege; the org_id ones exempt by name", () => {
    /** Typed from the migrations' own words (V439: "Sealed like V410's tables … no app_user policy"; stage_round_opens
     *  and V442's guard faults enable + force with no policy), never read from the catalogue. */
    const SEALED = [
      "fixture_play_flags", "fixture_seat_asks", "fixture_video_guard_faults", "fixture_video_meetings",
      "fixture_video_participants", "online_chess_audit", "realtimekit_call_budget", "stage_round_opens",
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
