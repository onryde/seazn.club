// Check-in capacity plan 2, Task 2 - the adapter's three additions for the pre-minted round:
//
//   1. UNADOPTED rooms. The pre-mint job makes a room for a placeholder board (one with no pairing yet) and stamps it with BOTH
//      entrant columns null ("made for this board's first pairing, whichever it is"; V529 makes the pair of stamps null
//      together or set together). The seat's `ensureMeeting` adopts it - one statement, no vendor call - instead of making a
//      second room; `retireStaleMeeting` never reads it as another pairing's. A paired board's room is stamped with its pairing,
//      as today.
//   2. `peerReportCamera`: the ONE vendor read the seat's proof makes (GET /sessions/peer-report/{peerId}), extracted from
//      `seatCameraEvidence`, plus the report's own `participant.left_at` (owner ruling R4: a departed peer is never judged on
//      its last camera events).
//   3. `platformSpend` / `cappedBudget`: what a budget composes from, so the pre-mint pass and the sweep cap their own calls.
//
// Drives the REAL adapter against the e2e RealtimeKit fixture server (counting the requests the FIXTURE saw, never the
// adapter's own idea of what it asked) for the room cases, and against a request-counting `fetch` double where an exact
// vendor body is the point (the report shapes). The seat itself is driven too (the last case of the first describe): an
// adoption nothing in production ever reaches is the inert-seam class.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); every other sport is refused by the
// guard before a seat or a room is reached (external-play-preflight.test.ts, "another sport").
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionOptions, sql } from "@/lib/db";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../../e2e/realtimekit-fixture-server";
import { seatPlayer, type PreflightDeps } from "@/server/usecases/external-play/preflight";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { takeRealtimeKitCall, type CallBudget } from "../budget";
import {
  CF_BASE,
  RETIRED_PAIR,
  RealtimeKitDeferred,
  RealtimeKitError,
  addParticipant,
  adoptRooms,
  cappedBudget,
  ensureMeeting,
  peerReportCamera,
  platformSpend,
  refreshParticipantToken,
  retireStaleMeeting,
  seatCameraEvidence,
} from "../realtimekit";

const DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (DB) await sql.end();
});
beforeEach(async () => {
  await fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── The rooms ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Seeded = Awaited<ReturnType<typeof seed>>;
/** A paired, started division's board whose round opened five minutes ago (the seat's state), camera Required. */
async function seed() {
  const opened = new Date(Date.now() - 5 * 60_000);
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 10 * 60_000),
    linked: true,
    roundOpenedAt: opened,
    cameraPolicy: "required",
  });
}
/** The board as the pre-mint job meets a placeholder (no entrant at all) or a half-paired one (one empty seat). */
async function unpair(s: Seeded, which: "both" | "home" | "away" = "both") {
  const home = which === "both" || which === "home";
  const away = which === "both" || which === "away";
  await sql`
    update fixtures set home_entrant_id = ${home ? null : s.home.entrantId}, away_entrant_id = ${away ? null : s.away.entrantId}
     where id = ${s.fixtureId}`;
}
const pair = (s: Seeded) =>
  sql`update fixtures set home_entrant_id = ${s.home.entrantId}, away_entrant_id = ${s.away.entrantId} where id = ${s.fixtureId}`;

type Side = "home" | "away";
type Stamp = { home: string | null; away: string | null };
/** A room row written straight to the table (no vendor room behind it: a test using one makes no vendor call). */
async function putRoom(s: Seeded, side: Side, stamp: Stamp, over: { endedAt?: Date } = {}): Promise<string> {
  const meetingId = `mtg-unadopted-${RUN}-${side}-${randomUUID().slice(0, 8)}`;
  await sql`
    insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at)
    values (${s.fixtureId}, ${side}, ${s.orgId}, ${meetingId}, ${stamp.home}, ${stamp.away}, ${over.endedAt ?? null})`;
  return meetingId;
}
const NULLS: Stamp = { home: null, away: null };
const pairingOf = (s: Seeded): Stamp => ({ home: s.home.entrantId, away: s.away.entrantId });

type RoomRow = { side: Side; meetingId: string; home: string | null; away: string | null; ended: Date | null };
const roomsOf = (fixtureId: string) =>
  sql<RoomRow[]>`
    select side, meeting_id as "meetingId", home_entrant_id as home, away_entrant_id as away, ended_at as ended
      from fixture_video_meetings where fixture_id = ${fixtureId} order by side`;

const vendorCalls = (route: string) => fx.calls.filter((c) => c.route === route).length;

/** Waits until a statement matching the (postgres) regex `pattern` is waiting on a lock, as seen from `tx`. `pg_stat_activity` is
 *  snapshotted ONCE per transaction, so every poll clears the snapshot first - without it a poll inside the holder's transaction
 *  keeps reading the first look (the statement not yet sent) and a slow-starting claim reads as "never queued". */
async function untilQueued(tx: postgres.TransactionSql, pattern: string, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    await tx`select pg_stat_clear_snapshot()`;
    const [queued] = await tx<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and query ~ ${pattern}`;
    if (queued!.n > 0) return;
    if (Date.now() > deadline) throw new Error(`${what} never queued behind a lock: the window was not reached`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Runs `run` and lets `during` change the database AFTER `run` has read a room and BEFORE its adoption statement executes - the
 *  window two concurrent claims race through. A SEPARATE connection (never the app pool: a transaction pinning one of the pool's
 *  few connections starves the claim under test) holds a SHARE ROW EXCLUSIVE lock on the meetings table (readers pass, writers
 *  queue), `run` starts, and the helper waits until `adoptRooms`' UPDATE is queued behind the lock - proof that `run`'s read has
 *  already happened, so a test that never reached the window fails instead of passing vacuously - then makes its change in the
 *  same transaction and commits; the queued UPDATE runs on the committed state. */
async function betweenReadAndAdoption<T>(run: () => Promise<T>, during: (tx: postgres.TransactionSql) => Promise<void>): Promise<T> {
  const opts = connectionOptions(process.env.DATABASE_URL!);
  const holder = postgres(process.env.DATABASE_URL!, { max: 1, ssl: opts.ssl, connection: { search_path: opts.schema } });
  let pending: Promise<T> | null = null;
  try {
    await holder.begin(async (tx) => {
      await tx`lock table fixture_video_meetings in share row exclusive mode`;
      pending = run();
      pending.catch(() => undefined);
      await untilQueued(tx, "update fixture_video_meetings m[[:space:]]+set home_entrant_id = f[.]home_entrant_id", "the adoption statement");
      await during(tx);
    });
  } finally {
    await holder.end();
  }
  return pending!;
}

describe.skipIf(!DB)("unadopted rooms", () => {
  it("ensureMeeting with unpaired 'allow' on a placeholder makes a room stamped (null, null); without it the placeholder is refused as today", async () => {
    const s = await seed();
    await unpair(s);
    // The refusal is today's, and it makes nothing: no vendor room, no row.
    await expect(ensureMeeting(s.fixtureId, "home")).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_UNPAIRED" });
    await expect(ensureMeeting(s.fixtureId, "away", {}, {})).rejects.toMatchObject({ code: "VIDEO_MEETING_UNPAIRED" });
    expect(fx.calls.length, "a refused placeholder reaches no vendor").toBe(0);
    expect(await roomsOf(s.fixtureId)).toHaveLength(0);

    const ref = await ensureMeeting(s.fixtureId, "home", {}, { unpaired: "allow" });
    expect(vendorCalls("POST /meetings"), "one room made at the vendor").toBe(1);
    const rows = await roomsOf(s.fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ side: "home", meetingId: ref.meetingId, home: null, away: null, ended: null });
    const [org] = await sql<{ org_id: string }[]>`select org_id from fixture_video_meetings where fixture_id = ${s.fixtureId}`;
    expect(org?.org_id, "the tenant policy needs it").toBe(s.orgId);

    // The SEQUENCE: a second call finds the room (no second POST /meetings) and the other side gets its own.
    expect(await ensureMeeting(s.fixtureId, "home", {}, { unpaired: "allow" })).toEqual(ref);
    expect(vendorCalls("POST /meetings"), "a second call makes no room").toBe(1);
    await ensureMeeting(s.fixtureId, "away", {}, { unpaired: "allow" });
    expect(vendorCalls("POST /meetings")).toBe(2);
    expect((await roomsOf(s.fixtureId)).map((r) => [r.side, r.home, r.away])).toEqual([
      ["away", null, null],
      ["home", null, null],
    ]);
  });

  it("'allow' on a board with ONE empty seat stamps (null, null), never (entrant, null): the stamps are a pair; on a PAIRED board it stamps the pairing", async () => {
    const half = await seed();
    await unpair(half, "away");
    await ensureMeeting(half.fixtureId, "home", {}, { unpaired: "allow" });
    expect(await roomsOf(half.fixtureId), "the half-paired board's room belongs to no pairing yet").toMatchObject([{ side: "home", home: null, away: null }]);

    const paired = await seed();
    await ensureMeeting(paired.fixtureId, "home", {}, { unpaired: "allow" });
    expect(await roomsOf(paired.fixtureId), "a paired board's room is stamped with its pairing, as a seat's would be").toMatchObject([
      { side: "home", ...pairingOf(paired) },
    ]);
  });

  it("a paired fixture whose rooms are unadopted: ensureMeeting WITHOUT opts (the seat's call) adopts BOTH rows, returns the room's id and makes no vendor call", async () => {
    const s = await seed();
    const homeId = await putRoom(s, "home", NULLS);
    const awayId = await putRoom(s, "away", NULLS);

    const ref = await ensureMeeting(s.fixtureId, "home");
    expect(ref, "the pre-made room, not a new one").toEqual({ meetingId: homeId });
    expect(fx.calls.length, "adoption is a database write, never a vendor call").toBe(0);
    expect(await roomsOf(s.fixtureId), "one adoption takes the board's every unadopted row").toMatchObject([
      { side: "away", meetingId: awayId, ...pairingOf(s) },
      { side: "home", meetingId: homeId, ...pairingOf(s) },
    ]);

    // The SEQUENCE: a second call, and the other side's call, find an adopted room and still make nothing.
    expect(await ensureMeeting(s.fixtureId, "home")).toEqual({ meetingId: homeId });
    expect(await ensureMeeting(s.fixtureId, "away")).toEqual({ meetingId: awayId });
    expect(fx.calls.length).toBe(0);
  });

  it("the seat adopts a pre-minted room THROUGH THE REAL SEAT: no second room, the participant lands on the pre-made one, and both rows end up stamped for the pairing", async () => {
    const s = await seed();
    await unpair(s);
    // The pre-mint job's own call, on the real adapter, against the vendor fixture.
    const homeRoom = await ensureMeeting(s.fixtureId, "home", {}, { unpaired: "allow" });
    const awayRoom = await ensureMeeting(s.fixtureId, "away", {}, { unpaired: "allow" });
    expect(vendorCalls("POST /meetings")).toBe(2);
    // The board is paired afterwards (a Swiss pairing landing, or an organiser's edit).
    await pair(s);

    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: new Date() });
    expect(got.seated, "premise: nobody has joined yet").toBe(false);
    expect(vendorCalls("POST /meetings"), "the seat made no room: the job's was adopted").toBe(2);
    expect(vendorCalls("POST /meetings/:id/participants"), "and added the player to it").toBe(1);
    const participantId = "participant" in got ? got.participant?.participantId : undefined;
    expect(participantId, "the refusal carries the token the claim minted").toBeTruthy();
    expect(fx.participant(participantId!)?.meetingId, "the participant is in the room the JOB made").toBe(homeRoom.meetingId);

    expect(await roomsOf(s.fixtureId)).toMatchObject([
      { side: "away", meetingId: awayRoom.meetingId, ...pairingOf(s) },
      { side: "home", meetingId: homeRoom.meetingId, ...pairingOf(s) },
    ]);
    const stored = await sql<{ participant_id: string }[]>`
      select participant_id from fixture_video_participants where fixture_id = ${s.fixtureId} and side = 'home' and preset = 'player'`;
    expect(stored.map((r) => r.participant_id), "the participant is stored on the adopted row (the lock check reads it as the current pairing's)").toEqual([participantId]);
  });

  // (null, null) pin, plan 2 Task 2 (V529): preflight's participant store runs under a `for update` lock on the room's row and
  // refuses it unless `samePair` (the board's pairing stamped on it). An unadopted row never reaches it through the real seat -
  // `ensureMeeting` adopts first, above - but the check is what stops a participant being stored on a room nobody adopted if
  // it ever did. Reached here by a seat whose `ensureMeeting` skips the adoption.
  it("PIN: the seat's participant store refuses a room that is still unadopted (preflight reads samePair): VIDEO_MEETING_REPLACED, nothing stored, the row left unadopted", async () => {
    const s = await seed();
    await unpair(s);
    const room = await ensureMeeting(s.fixtureId, "home", {}, { unpaired: "allow" });
    await pair(s);
    const skipsAdoption: NonNullable<PreflightDeps["video"]> = {
      ensureMeeting: async () => room,
      addParticipant: (a) => addParticipant(a),
      seatCameraEvidence: (a) => seatCameraEvidence(a),
      refreshParticipantToken: (a) => refreshParticipantToken(a),
    };
    await expect(seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: new Date(), video: skipsAdoption })).rejects.toMatchObject({
      status: 409,
      code: "VIDEO_MEETING_REPLACED",
    });
    const stored = await sql`select 1 from fixture_video_participants where fixture_id = ${s.fixtureId}`;
    expect(stored, "nothing was stored on the unadopted room").toHaveLength(0);
    expect(await roomsOf(s.fixtureId)).toMatchObject([{ side: "home", meetingId: room.meetingId, home: null, away: null }]);
  });

  it("adoptRooms: both sides in ONE statement (a two-step write would trip the pair check), 2 then 0 (idempotent), 0 on an unpaired fixture, 0 when there is nothing", async () => {
    const s = await seed();
    expect(await adoptRooms(sql, s.fixtureId), "the empty case: no room on file").toBe(0);
    await putRoom(s, "home", NULLS);
    await putRoom(s, "away", NULLS);

    // Unpaired: nothing to adopt INTO. The rooms are untouched.
    await unpair(s);
    expect(await adoptRooms(sql, s.fixtureId)).toBe(0);
    expect((await roomsOf(s.fixtureId)).map((r) => [r.home, r.away])).toEqual([[null, null], [null, null]]);
    await unpair(s, "home");
    expect(await adoptRooms(sql, s.fixtureId), "one empty seat is still unpaired").toBe(0);

    await pair(s);
    expect(await adoptRooms(sql, s.fixtureId)).toBe(2);
    expect((await roomsOf(s.fixtureId)).map((r) => [r.home, r.away])).toEqual([
      [s.home.entrantId, s.away.entrantId],
      [s.home.entrantId, s.away.entrantId],
    ]);
    expect(await adoptRooms(sql, s.fixtureId), "idempotent").toBe(0);
  });

  it("adoptRooms is scoped to ITS fixture: with two paired boards each holding unadopted rooms, adopting one returns exactly its count and leaves the other's rooms (null, null)", async () => {
    const a = await seed();
    const b = await seed();
    for (const s of [a, b]) {
      await putRoom(s, "home", NULLS);
      await putRoom(s, "away", NULLS);
    }
    expect(await adoptRooms(sql, a.fixtureId), "exactly the first board's two rooms").toBe(2);
    expect((await roomsOf(a.fixtureId)).map((r) => [r.home, r.away]), "board A adopted").toEqual([
      [a.home.entrantId, a.away.entrantId],
      [a.home.entrantId, a.away.entrantId],
    ]);
    expect((await roomsOf(b.fixtureId)).map((r) => [r.home, r.away]), "board B untouched, though it is paired and unadopted too").toEqual([
      [null, null],
      [null, null],
    ]);
    expect(await adoptRooms(sql, b.fixtureId), "and B is still there to adopt").toBe(2);
  });

  describe("adoption that writes nothing is re-read, never assumed (a concurrent claim, or an unpair, between the read and the write)", () => {
    it("ANOTHER claim adopted the room in the window: the re-read finds the board's own pairing on it and returns it, no vendor call", async () => {
      const s = await seed();
      const roomId = await putRoom(s, "home", NULLS);
      const ref = await betweenReadAndAdoption(
        () => ensureMeeting(s.fixtureId, "home"),
        async (tx) => {
          await tx`update fixture_video_meetings set home_entrant_id = ${s.home.entrantId}, away_entrant_id = ${s.away.entrantId} where fixture_id = ${s.fixtureId}`;
        },
      );
      expect(ref).toEqual({ meetingId: roomId });
      expect(fx.calls.length).toBe(0);
      expect(await roomsOf(s.fixtureId)).toMatchObject([{ side: "home", meetingId: roomId, ...pairingOf(s) }]);
    });

    it("the board was UNPAIRED in the window: a seat is refused VIDEO_MEETING_UNPAIRED and the room stays unadopted; the job's 'allow' call gets the room back", async () => {
      const s = await seed();
      const roomId = await putRoom(s, "home", NULLS);
      const unpairInWindow = async (tx: postgres.TransactionSql) => {
        await tx`update fixtures set home_entrant_id = null, away_entrant_id = null where id = ${s.fixtureId}`;
      };
      await expect(betweenReadAndAdoption(() => ensureMeeting(s.fixtureId, "home"), unpairInWindow)).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_UNPAIRED" });
      expect(await roomsOf(s.fixtureId), "nothing was adopted").toMatchObject([{ meetingId: roomId, home: null, away: null }]);

      await pair(s);
      const ref = await betweenReadAndAdoption(() => ensureMeeting(s.fixtureId, "home", {}, { unpaired: "allow" }), unpairInWindow);
      expect(ref, "the job's call is handed the room: an unpaired board's room is the job's").toEqual({ meetingId: roomId });
      expect(await roomsOf(s.fixtureId)).toMatchObject([{ meetingId: roomId, home: null, away: null }]);
      expect(fx.calls.length).toBe(0);
    });

    it("another claim adopted it for ANOTHER pair in the window: the room is another pairing's now, refused (503; a game behind it: 409 by name), never handed to this pairing", async () => {
      let checked = 0;
      for (const game of [false, true]) {
        const s = await seed();
        await putRoom(s, "home", NULLS);
        const refusal = await betweenReadAndAdoption(
          () => ensureMeeting(s.fixtureId, "home"),
          async (tx) => {
            await tx`update fixture_video_meetings set home_entrant_id = ${randomUUID()}, away_entrant_id = ${randomUUID()} where fixture_id = ${s.fixtureId}`;
            if (game) {
              await tx`
                insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
                values (${s.fixtureId}, ${s.orgId}, now(), 'ready', ${`gm-${RUN}-${randomUUID().slice(0, 6)}`})`;
            }
          },
        ).then(
          () => null,
          (err: unknown) => err,
        );
        const want = game ? { status: 409, code: "VIDEO_MEETING_PAIRING_CHANGED" } : { status: 503, code: "unavailable", message: expect.stringMatching(/changed while it was being adopted/) };
        expect(refusal, `game ${game}`).toMatchObject(want);
        expect(fx.calls.length, `game ${game}: no vendor call, and no second room`).toBe(0);
        expect(await roomsOf(s.fixtureId), `game ${game}: the room is left as it is`).toHaveLength(1);
        checked++;
      }
      expect(checked, "anti-vacuity: with and without a game").toBe(2);
    });

    it("the room was RETIRED (its row deleted) in the window: the re-read finds nothing and the claim is refused 503 - it neither answers from the stale read nor makes a room on top of a retire it did not see", async () => {
      const s = await seed();
      await putRoom(s, "home", NULLS);
      await expect(
        betweenReadAndAdoption(
          () => ensureMeeting(s.fixtureId, "home"),
          async (tx) => {
            await tx`delete from fixture_video_meetings where fixture_id = ${s.fixtureId} and side = 'home'`;
          },
        ),
      ).rejects.toMatchObject({ code: "unavailable", status: 503, message: expect.stringMatching(/vanished/) });
      expect(await roomsOf(s.fixtureId), "nothing re-created").toEqual([]);
      expect(fx.calls.length, "no vendor call").toBe(0);
    });

    it("the board was UNPAIRED for the adoption and PAIRED AGAIN before the re-read: an unadopted room on a paired board that nothing adopted is refused 503, never handed out", async () => {
      const s = await seed();
      await putRoom(s, "home", NULLS);
      const opts = connectionOptions(process.env.DATABASE_URL!);
      const second = postgres(process.env.DATABASE_URL!, { max: 1, ssl: opts.ssl, connection: { search_path: opts.schema } });
      let repaired: Promise<unknown> | null = null;
      try {
        await expect(
          betweenReadAndAdoption(
            () => ensureMeeting(s.fixtureId, "home"),
            async (tx) => {
              await tx`update fixtures set home_entrant_id = null, away_entrant_id = null where id = ${s.fixtureId}`;
              // A second session asks for the meetings table EXCLUSIVELY: queued behind the adoption statement, so it is granted the
              // instant that (now empty) statement ends and holds the re-read off until it has paired the board again.
              repaired = second.begin(async (tx2) => {
                await tx2`lock table fixture_video_meetings in access exclusive mode`;
                await tx2`update fixtures set home_entrant_id = ${s.home.entrantId}, away_entrant_id = ${s.away.entrantId} where id = ${s.fixtureId}`;
              });
              repaired.catch(() => undefined);
              await untilQueued(tx, "lock table fixture_video_meetings in access exclusive mode", "the second session");
            },
          ),
        ).rejects.toMatchObject({ code: "unavailable", status: 503, message: expect.stringMatching(/could not be adopted/) });
        await repaired;
      } finally {
        await second.end();
      }
      expect(await roomsOf(s.fixtureId), "the room is still unadopted: nothing adopted it").toMatchObject([{ home: null, away: null }]);
      expect(fx.calls.length).toBe(0);
    });
  });

  it("adoptRooms takes a row for the fixture's CURRENT pairing as of its own statement, and never rewrites a room stamped for a pairing (adopted, or another's)", async () => {
    const s = await seed();
    const other: Stamp = { home: randomUUID(), away: randomUUID() };
    await putRoom(s, "home", other);
    await putRoom(s, "away", NULLS);
    expect(await adoptRooms(sql, s.fixtureId), "only the unadopted row").toBe(1);
    expect((await roomsOf(s.fixtureId)).map((r) => [r.side, r.home, r.away])).toEqual([
      ["away", s.home.entrantId, s.away.entrantId],
      ["home", other.home, other.away],
    ]);
  });

  it("a SEAT call on an unpaired board with an unadopted room on file is still refused (VIDEO_MEETING_UNPAIRED) and touches nothing; the job's 'allow' call finds the room and makes no second", async () => {
    const s = await seed();
    await unpair(s);
    const roomId = await putRoom(s, "home", NULLS);
    await expect(ensureMeeting(s.fixtureId, "home")).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_UNPAIRED" });
    expect(await roomsOf(s.fixtureId), "the refusal wrote nothing").toMatchObject([{ meetingId: roomId, home: null, away: null }]);
    expect(await ensureMeeting(s.fixtureId, "home", {}, { unpaired: "allow" })).toEqual({ meetingId: roomId });
    expect(fx.calls.length, "no vendor call either way").toBe(0);
    expect(await roomsOf(s.fixtureId), "an unpaired board has nothing to adopt into").toMatchObject([{ meetingId: roomId, home: null, away: null }]);
  });

  it("an ENDED unadopted room on a paired board reads as an ended room (VIDEO_MEETING_ENDED), never as one to join, and no second room is made beside it", async () => {
    const s = await seed();
    await putRoom(s, "home", NULLS, { endedAt: new Date() });
    await expect(ensureMeeting(s.fixtureId, "home")).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_ENDED" });
    expect(fx.calls.length).toBe(0);
    expect(await roomsOf(s.fixtureId)).toHaveLength(1);
  });

  it("losing the creation race to an UNADOPTED room (the job's, landing during the seat's own create) adopts the winner instead of failing the seat, and stands its own room down", async () => {
    const s = await seed();
    let winnerId: string | null = null;
    const racing: typeof fetch = async (url, init) => {
      if (winnerId === null && init?.method === "POST" && String(url).endsWith("/meetings")) {
        winnerId = await putRoom(s, "home", NULLS);
      }
      return fetch(url, init);
    };
    const ref = await ensureMeeting(s.fixtureId, "home", { fetch: racing });
    expect(winnerId, "premise: the competing row landed during our create").not.toBeNull();
    expect(ref, "the winner's room, adopted").toEqual({ meetingId: winnerId });
    expect(await roomsOf(s.fixtureId)).toMatchObject([{ side: "home", meetingId: winnerId, ...pairingOf(s) }]);
    expect(vendorCalls("PATCH /meetings/:id"), "our own orphan is deactivated").toBe(1);
  });

  describe("retireStaleMeeting", () => {
    it("never selects an unadopted row, still retires a row stamped for another pairing (and the nil stamp), and keeps the current pairing's", async () => {
      const cases: { name: string; stamp: (s: Seeded) => Stamp; retired: boolean }[] = [
        { name: "unadopted", stamp: () => NULLS, retired: false },
        { name: "the fixture's current pairing", stamp: pairingOf, retired: false },
        { name: "another pairing", stamp: () => ({ home: randomUUID(), away: randomUUID() }), retired: true },
        { name: "the nil stamp (RETIRED_PAIR)", stamp: () => ({ home: RETIRED_PAIR, away: RETIRED_PAIR }), retired: true },
      ];
      let checked = 0;
      let retired = 0;
      let kept = 0;
      for (const c of cases) {
        const s = await seed();
        const homeId = await putRoom(s, "home", c.stamp(s));
        const ended: string[] = [];
        await retireStaleMeeting(s.fixtureId, new Date(), async (id) => {
          ended.push(id);
        });
        const left = await roomsOf(s.fixtureId);
        expect(ended, c.name).toEqual(c.retired ? [homeId] : []);
        expect(left.map((r) => r.meetingId), `${c.name}: the row`).toEqual(c.retired ? [] : [homeId]);
        checked += 1;
        if (c.retired) retired += 1;
        else kept += 1;
      }
      expect(checked, "anti-vacuity: every stamp state").toBe(4);
      expect([retired, kept], "a rule that retires (or keeps) everything proves nothing").toEqual([2, 2]);
    });

    it("on ONE board: the other pairing's room is ended and deleted while its unadopted sibling is neither ended nor deleted, and a second call finds nothing to do", async () => {
      const s = await seed();
      const staleId = await putRoom(s, "home", { home: randomUUID(), away: randomUUID() });
      const unadoptedId = await putRoom(s, "away", NULLS);
      const ended: string[] = [];
      const end = async (id: string) => {
        ended.push(id);
      };
      await retireStaleMeeting(s.fixtureId, new Date(), end);
      expect(ended).toEqual([staleId]);
      expect(await roomsOf(s.fixtureId)).toMatchObject([{ side: "away", meetingId: unadoptedId, home: null, away: null }]);
      await retireStaleMeeting(s.fixtureId, new Date(), end);
      expect(ended, "a second call: nothing left that is stale").toEqual([staleId]);
    });

    it("a claim about to CREATE its own room first retires the board's stale rows, and the other side's unadopted room is not one of them: nothing is ended", async () => {
      const s = await seed();
      const awayId = await putRoom(s, "away", NULLS);
      // Home has nothing on file: this claim creates, and first retires the board's stale rows - the unadopted one is not.
      const ref = await ensureMeeting(s.fixtureId, "home");
      expect(vendorCalls("POST /meetings"), "the home claim created its own room").toBe(1);
      expect(vendorCalls("PATCH /meetings/:id"), "nothing was ended").toBe(0);
      const rows = await roomsOf(s.fixtureId);
      expect(rows.map((r) => r.meetingId).sort()).toEqual([awayId, ref.meetingId].sort());
    });
  });

  it("the stamp pair check refuses one null stamp, in either column, on update and on insert (V529: both null or both set)", async () => {
    const s = await seed();
    await putRoom(s, "home", pairingOf(s));
    await expect(sql`update fixture_video_meetings set home_entrant_id = null where fixture_id = ${s.fixtureId} and side = 'home'`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update fixture_video_meetings set away_entrant_id = null where fixture_id = ${s.fixtureId} and side = 'home'`).rejects.toMatchObject({ code: "23514" });
    await expect(putRoom(s, "away", { home: s.home.entrantId, away: null })).rejects.toMatchObject({ code: "23514" });
    await expect(putRoom(s, "away", { home: null, away: s.away.entrantId })).rejects.toMatchObject({ code: "23514" });
    expect(await roomsOf(s.fixtureId), "nothing of the refused writes stuck").toMatchObject([{ side: "home", ...pairingOf(s) }]);
  });
});

// ─── The one-read proof's read ───────────────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "REALTIMEKIT_API_TOKEN", "REALTIMEKIT_APP_ID", "REALTIMEKIT_PLAYER_PRESET", "REALTIMEKIT_ARBITER_PRESET"] as const;
function configure() {
  const full: Record<(typeof ENV_KEYS)[number], string> = {
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    REALTIMEKIT_API_TOKEN: "cf-token-do-not-leak-0123456789",
    REALTIMEKIT_APP_ID: "app-1",
    REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
    REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
  };
  for (const k of ENV_KEYS) vi.stubEnv(k, full[k]);
  vi.stubEnv("REALTIMEKIT_BASE_URL", "");
}

type StubCall = { url: string; method: string };
/** Answers one JSON body per call, in order, and records every request. Nothing here touches the network. */
function stubFetch(responses: { status: number; body?: unknown }[]) {
  const calls: StubCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const next = responses[calls.length];
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (!next) throw new Error(`unexpected RealtimeKit call #${calls.length}: ${String(url)}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** A peer report as RealtimeKit serves it (measured shape: realtimekit.test.ts' cameraOn, and the fixture's rowJson). */
const report = (p: { events?: unknown; left_at?: unknown } = {}) => ({
  status: 200,
  body: {
    success: true,
    data: {
      participant: {
        id: "conn-1",
        user_id: "p-1",
        joined_at: "2026-10-01T12:00:00Z",
        ...("left_at" in p ? { left_at: p.left_at } : {}),
        peer_report: { metadata: { events: p.events } },
      },
    },
  },
});
const ev = (name: string, at: string, metadata?: unknown) => ({ name, timestamp: at, ...(metadata === undefined ? {} : { metadata }) });
const VIDEO = (permission: string) => ({ device_type: "VIDEO", permission });
const ON = [ev("media_permission", "2026-10-01T12:00:01Z", VIDEO("ACCEPTED")), ev("video_on", "2026-10-01T12:00:01Z")];
const OFF = [...ON, ev("video_off", "2026-10-01T12:03:00Z")];
const DENIED = [ev("media_permission", "2026-10-01T12:00:01Z", VIDEO("DENIED")), ev("video_on", "2026-10-01T12:00:01Z"), ev("video_off", "2026-10-01T12:00:01Z")];
const notFound = { status: 404, body: { success: false, error: { code: 404, message: "No peer event exists for id peer-x" } } };

describe("peerReportCamera", () => {
  it("maps the measured report shapes to on / off / blocked / starting, a not-found to none, an outage to unreadable, and costs exactly one call", async () => {
    configure();
    const cases: { name: string; response: { status: number; body?: unknown }; want: string }[] = [
      { name: "camera on", response: report({ events: ON }), want: "on" },
      { name: "camera on, left_at null (still in the room)", response: report({ events: ON, left_at: null }), want: "on" },
      { name: "camera turned off after being on", response: report({ events: OFF }), want: "off" },
      { name: "the browser refused the camera", response: report({ events: DENIED }), want: "blocked" },
      { name: "no events uploaded yet (null)", response: report({ events: null }), want: "starting" },
      { name: "no events member at all", response: report({}), want: "starting" },
      { name: "permission asked, nothing granted yet", response: report({ events: [ev("precall_begin", "2026-10-01T12:00:00Z")] }), want: "starting" },
      { name: "the vendor's own not-found: no report yet", response: notFound, want: "none" },
      { name: "an outage on the read", response: { status: 503, body: { success: false } }, want: "unreadable" },
      { name: "a 404 that is NOT the vendor's not-found (a proxy page) is an outage, not 'none'", response: { status: 404, body: { success: false, errors: [{ code: 7003 }] } }, want: "unreadable" },
      { name: "a report with no participant", response: { status: 200, body: { success: true, data: {} } }, want: "unreadable" },
      { name: "events that are not a list", response: report({ events: "yes" }), want: "unreadable" },
    ];
    const seen = new Set<string>();
    let checked = 0;
    for (const c of cases) {
      const stub = stubFetch([c.response]);
      const got = await peerReportCamera("peer-x", { fetch: stub.fetch });
      expect(got.camera, c.name).toBe(c.want);
      if (got.camera === "unreadable") expect(got.error, `${c.name}: carries the reason`).toBeInstanceOf(RealtimeKitError);
      expect(stub.calls, `${c.name}: exactly one call, to this peer's report`).toHaveLength(1);
      expect(stub.calls[0]).toEqual({ method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/sessions/peer-report/peer-x" });
      seen.add(got.camera);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every case ran").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(12);
    expect([...seen].sort(), "every non-left answer the type declares appeared").toEqual(["blocked", "none", "off", "on", "starting", "unreadable"]);
  });

  it("a report whose participant.left_at is set reads `left` with that instant, whatever its last video event says (video_on last: still `left`); a malformed left_at is unreadable, never on", async () => {
    configure();
    const LEFT = "2026-10-01T12:05:00.000Z";
    const cases: { name: string; response: { status: number; body?: unknown }; want: "left" | "unreadable" }[] = [
      { name: "left, camera last on", response: report({ events: ON, left_at: LEFT }), want: "left" },
      { name: "left, camera last off", response: report({ events: OFF, left_at: LEFT }), want: "left" },
      { name: "left, browser refused the camera", response: report({ events: DENIED, left_at: LEFT }), want: "left" },
      { name: "left before any event uploaded", response: report({ events: null, left_at: LEFT }), want: "left" },
      { name: "left_at is not a date", response: report({ events: ON, left_at: "yesterday-ish" }), want: "unreadable" },
      { name: "left_at is an empty string", response: report({ events: ON, left_at: "" }), want: "unreadable" },
      { name: "left_at is a number", response: report({ events: ON, left_at: 1790000000 }), want: "unreadable" },
      { name: "left_at is an object", response: report({ events: ON, left_at: {} }), want: "unreadable" },
    ];
    let left = 0;
    let unreadable = 0;
    for (const c of cases) {
      const got = await peerReportCamera("peer-x", { fetch: stubFetch([c.response]).fetch });
      expect(got.camera, c.name).toBe(c.want);
      if (got.camera === "left") {
        expect(got.leftAt, c.name).toEqual(new Date(LEFT));
        left += 1;
      } else {
        unreadable += 1;
      }
    }
    expect([left, unreadable], "anti-vacuity: both outcomes were reached").toEqual([4, 4]);
  });

  it("a read the platform's call budget refused is RETHROWN as a deferral, never `unreadable` (the seat waits an unreadable out and then reports an outage)", async () => {
    configure();
    const stub = stubFetch([]);
    await expect(peerReportCamera("peer-x", { fetch: stub.fetch, budget: async () => false })).rejects.toBeInstanceOf(RealtimeKitDeferred);
    expect(stub.calls, "the refused read never reached the vendor").toHaveLength(0);
  });

  it("an empty (or blank) peer id is refused BEFORE any request: `/sessions/peer-report/` with nothing after it is another route, and its answer would be read as this peer's report", async () => {
    configure();
    const stub = stubFetch([]);
    for (const bad of ["", " ", "\t\n"]) {
      await expect(peerReportCamera(bad, { fetch: stub.fetch }), JSON.stringify(bad)).rejects.toThrow(/peer id/);
    }
    expect(stub.calls, "nothing was asked").toHaveLength(0);
    // The positive pair: a real id still makes its one call.
    const ok = stubFetch([report({ events: ON })]);
    expect(await peerReportCamera("peer-x", { fetch: ok.fetch })).toEqual({ camera: "on" });
    expect(ok.calls).toHaveLength(1);
  });

  it("the REAL vendor fixture's own report: a peer that is present reads its camera, and the same peer after it LEAVES reads `left` with the row's left_at, though its last video event is still video_on", async () => {
    const meeting = await makeVendorRoom();
    const p = await addPlayerTo(meeting);
    fx.setLivePublisher(p.participantId, true, { camera: "on" });
    const peerId = fx.currentPeer(p.participantId);
    expect(peerId, "premise: the fixture holds a current peer").toBeTruthy();
    expect(await peerReportCamera(peerId!)).toEqual({ camera: "on" });

    fx.setLivePublisher(p.participantId, false);
    const gone = await peerReportCamera(peerId!);
    expect(gone.camera, "the fixture serves left_at, and the adapter reads it").toBe("left");
    if (gone.camera === "left") expect(Number.isNaN(gone.leftAt.getTime()), "a real instant").toBe(false);
    expect(fx.calls.filter((c) => c.route === "GET /sessions/peer-report/:peer"), "one call per read, two reads").toHaveLength(2);
  });
});

/** A room made at the fixture vendor (no database row: peerReportCamera reads the vendor only). */
async function makeVendorRoom(): Promise<string> {
  const res = await fetch(`${fx.url}${fx.kitPath}/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: `peer-report-${RUN}` }),
  });
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}
const addPlayerTo = (meetingId: string) => addParticipant({ meetingId, subject: `person-${RUN}`, preset: "player" });

describe("seatCameraEvidence carries the peer it read", () => {
  const SESSION = "sess-1";
  const ME = "p-1";
  const live = { status: 200, body: { success: true, data: { id: SESSION, status: "LIVE" } } };
  const participants = (rows: unknown[]) => ({ status: 200, body: { success: true, data: { participants: rows } } });
  const row = (peer: string) => ({
    id: "conn-1",
    user_id: ME,
    joined_at: "2026-10-01T12:00:00Z",
    left_at: null,
    peer_events: [{ event_name: "PEER_JOINING", peer_id: peer, created_at: "2026-10-01T12:00:00Z" }],
  });

  it("every PRESENT state names the peer and the session it read; `none` is still `starting`; a report whose participant has left is `absent`", async () => {
    configure();
    const PEER = "peer-p-1-0";
    const cases: { name: string; report: { status: number; body?: unknown }; want: string; present: boolean }[] = [
      { name: "on", report: report({ events: ON }), want: "on", present: true },
      { name: "off", report: report({ events: OFF }), want: "off", present: true },
      { name: "blocked", report: report({ events: DENIED }), want: "blocked", present: true },
      { name: "starting (no events yet)", report: report({ events: null }), want: "starting", present: true },
      { name: "no report yet (not-found) reads as today's `starting`", report: notFound, want: "starting", present: true },
      { name: "an outage on the report", report: { status: 503, body: { success: false } }, want: "unreadable", present: true },
      { name: "the report says the participant LEFT (the list still showed it): not judged on its last events", report: report({ events: ON, left_at: "2026-10-01T12:04:00Z" }), want: "absent", present: false },
    ];
    let checked = 0;
    for (const c of cases) {
      const stub = stubFetch([live, participants([row(PEER)]), c.report]);
      const got = await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch });
      expect(got.state, c.name).toBe(c.want);
      expect(stub.calls, `${c.name}: the same three reads as before`).toHaveLength(3);
      if (c.present) {
        expect(got, c.name).toMatchObject({ peerId: PEER, sessionId: SESSION });
        expect(got).toHaveProperty("since", new Date("2026-10-01T12:00:00Z"));
      } else {
        expect(got, `${c.name}: an absent answer names no peer`).toEqual({ state: "absent" });
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });
});

// ─── What a budget is made from ──────────────────────────────────────────────────────────────────────────────────────

describe("platformSpend and cappedBudget", () => {
  it("cappedBudget refuses the (cap+1)th attempt and never reaches inner for it; spent() counts attempts that did", async () => {
    const asked: string[] = [];
    const inner: CallBudget = async (key) => {
      asked.push(key);
      return true;
    };
    const { budget, spent } = cappedBudget(2, inner);
    expect(spent(), "the empty case: nothing asked").toBe(0);
    expect([await budget("k1"), await budget("k2")], "inside the cap: inner's answer").toEqual([true, true]);
    expect(spent()).toBe(2);
    expect([await budget("k3"), await budget("k4")], "past the cap: refused").toEqual([false, false]);
    expect(asked, "inner was asked about the first two only, with the key it was given").toEqual(["k1", "k2"]);
    expect(spent(), "refused attempts are not spent").toBe(2);
  });

  it("cappedBudget composes with inner's own refusal (the platform's bucket running dry inside the cap), and with no inner at all (null: grants, until the cap)", async () => {
    const answers = [true, false, true];
    let reached = 0;
    const { budget, spent } = cappedBudget(3, async () => answers[reached++]!);
    expect([await budget("k"), await budget("k"), await budget("k"), await budget("k")]).toEqual([true, false, true, false]);
    expect(reached, "the fourth never reached inner").toBe(3);
    expect(spent(), "an attempt inner refused still reached it").toBe(3);

    const bare = cappedBudget(1, null);
    expect([await bare.budget("k"), await bare.budget("k")]).toEqual([true, false]);
    expect(bare.spent()).toBe(1);
    const none = cappedBudget(0, null);
    expect(await none.budget("k"), "a cap of 0 refuses everything").toBe(false);
    expect(none.spent()).toBe(0);
  });

  it("cappedBudget refuses a cap that is not a non-negative integer (a NaN cap would grant every attempt: `attempts > NaN` is false), and takes 0 and a positive integer", () => {
    const refused = [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const cap of refused) expect(() => cappedBudget(cap, null), `cap ${cap}`).toThrow(RangeError);
    expect(() => cappedBudget(0, null)).not.toThrow();
    expect(() => cappedBudget(900, null)).not.toThrow();
    expect(refused.length, "anti-vacuity: every bad cap was tried").toBe(5);
  });

  it("platformSpend is null for a fixture base without REALTIMEKIT_METER_ANY_BASE and a spender with it; null for a caller-supplied fetch whatever the base; the real spender for Cloudflare's own base", () => {
    vi.stubEnv("REALTIMEKIT_BASE_URL", "");
    vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "");
    const fixtureBase = { baseUrl: "http://127.0.0.1:4322" };
    expect(platformSpend(fixtureBase), "a fixture base is not metered").toBeNull();
    expect(platformSpend({}), "no override: Cloudflare's own base is metered").toBe(takeRealtimeKitCall);
    expect(platformSpend({ baseUrl: CF_BASE }), "Cloudflare's own base, spelt out").toBe(takeRealtimeKitCall);
    expect(platformSpend({ fetch: (async () => new Response("{}")) as typeof fetch }), "a test double never leaves the process").toBeNull();

    vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "1");
    expect(platformSpend(fixtureBase), "REALTIMEKIT_METER_ANY_BASE=1 meters a fixture base").toBe(takeRealtimeKitCall);
    expect(platformSpend({ ...fixtureBase, fetch: (async () => new Response("{}")) as typeof fetch }), "but never a caller's fetch").toBeNull();
    vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "true");
    expect(platformSpend(fixtureBase), "exactly '1', as cfEnvelope reads it").toBeNull();
  });
});
