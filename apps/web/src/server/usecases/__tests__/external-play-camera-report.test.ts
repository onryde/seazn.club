// apps/web/src/server/usecases/__tests__/external-play-camera-report.test.ts
//
// D16 (§5.6.3, §8) - the camera report: a player's browser tells our server what its own camera is doing, and the server
// stamps it on that player's own participant row, on the server's clock, for the OPPONENT's pill. The rules under test:
// a change always writes and pings; a heartbeat is judged against the stored row in four cases; a reordered pair is
// harmless; a heartbeat that only refreshes pings nobody; the ping is rate-limited per seat; and only the seat's own
// player, in an open meeting, can write it. Single-sport by construction: online play exists only for `boardgame`
// (guard.ts), so there is no other sport to sweep.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { CAMERA_FAULT_PING_LIMIT, CAMERA_REPORT_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { CAMERA_REPORT_STALE_MS } from "@/components/public-site/match-room/room-snapshot";
import { mintMatchRoomToken } from "../match-room-token";
import { readRoom, type RoomDeps } from "../external-play/room";
import { reportOwnCamera, type CameraReportOutcome } from "../external-play/camera-report";
import { makeUser } from "./_seed";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

const T = new Date(Date.now() + 5 * 60_000);
const NOW = new Date();

type Side = "home" | "away";
type State = "live" | "off";

const deps = (now: Date = NOW) => {
  const publish = vi.fn(async () => {});
  return { now, publish } as RoomDeps & { publish: ReturnType<typeof vi.fn> };
};

/** A board whose two players are each in a meeting of their own, as preflight leaves them, their rows holding the reports given. */
async function board(stored: Partial<Record<Side, { state: State; ageMs: number } | null>> = {}) {
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    roundOpenedAt: T,
    linked: true,
    cameraPolicy: "required",
  });
  const part = {} as Record<Side, string>;
  for (const side of ["home", "away"] as const) {
    await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side });
    const r = stored[side];
    part[side] = await putVideoParticipant(
      { fixtureId: s.fixtureId, side, personId: s[side].personId },
      { report: r ? { state: r.state, at: new Date(NOW.getTime() - r.ageMs) } : null },
    );
  }
  return { s, part };
}
const me = (s: SeedOnlineChessFixtureResult, side: Side) => ({ kind: "session" as const, userId: s[side].userId });
const rowOf = async (participantId: string) =>
  (
    await sql<{ state: string | null; at: Date | null }[]>`
      select camera_reported as state, camera_reported_at as at from fixture_video_participants where participant_id = ${participantId}`
  )[0]!;

afterEach(() => {
  __setRateLimitCounterForTests(null);
});
afterAll(async () => {
  await sql.end();
});

describe.skipIf(!process.env.DATABASE_URL)("camera report - the four heartbeat cases, and a change (§5.6.3)", () => {
  type Row = {
    label: string;
    /** What is stored before the report; `null` is nothing stored. */
    stored: { state: State; ageMs: number } | null;
    body: { state: State; heartbeat: boolean };
    outcome: CameraReportOutcome;
    /** The row after: the state, and whether the stamp moved to the report's own instant. */
    after: { state: State | null; stampMoved: boolean };
    ping: boolean;
  };
  const FRESH = 1_000;
  const JUST_FRESH = CAMERA_REPORT_STALE_MS - 1;
  const JUST_STALE = CAMERA_REPORT_STALE_MS; // fresh is strictly younger than the window: the pill's own "unknown" instant
  // The spec's own table (§5.6.3), written out - the expected values are the rule's, not read from the code.
  const TABLE: Row[] = [
    // A CHANGE always writes its state and pings, whatever is stored.
    { label: "change, nothing stored", stored: null, body: { state: "live", heartbeat: false }, outcome: "written", after: { state: "live", stampMoved: true }, ping: true },
    { label: "change, the same state stored", stored: { state: "live", ageMs: FRESH }, body: { state: "live", heartbeat: false }, outcome: "written", after: { state: "live", stampMoved: true }, ping: true },
    { label: "change, a different state stored and fresh", stored: { state: "live", ageMs: FRESH }, body: { state: "off", heartbeat: false }, outcome: "written", after: { state: "off", stampMoved: true }, ping: true },
    { label: "change, a different state stored and stale", stored: { state: "live", ageMs: JUST_STALE + 5_000 }, body: { state: "off", heartbeat: false }, outcome: "written", after: { state: "off", stampMoved: true }, ping: true },
    // A HEARTBEAT, four cases.
    { label: "heartbeat, nothing stored: writes the state and the stamp, pings nobody", stored: null, body: { state: "live", heartbeat: true }, outcome: "written", after: { state: "live", stampMoved: true }, ping: false },
    { label: "heartbeat agrees with a fresh row: refreshes, pings nobody", stored: { state: "live", ageMs: FRESH }, body: { state: "live", heartbeat: true }, outcome: "refreshed", after: { state: "live", stampMoved: true }, ping: false },
    { label: "heartbeat agrees with a stale row: refreshes, pings nobody", stored: { state: "off", ageMs: JUST_STALE + 5_000 }, body: { state: "off", heartbeat: true }, outcome: "refreshed", after: { state: "off", stampMoved: true }, ping: false },
    { label: "heartbeat differs from a fresh row: ignored, the stamp untouched", stored: { state: "off", ageMs: FRESH }, body: { state: "live", heartbeat: true }, outcome: "ignored", after: { state: "off", stampMoved: false }, ping: false },
    { label: "heartbeat differs from a row ONE ms inside the window: still fresh, ignored", stored: { state: "off", ageMs: JUST_FRESH }, body: { state: "live", heartbeat: true }, outcome: "ignored", after: { state: "off", stampMoved: false }, ping: false },
    { label: "heartbeat differs from a row exactly at the window: no longer fresh, applied as a change and pinged", stored: { state: "off", ageMs: JUST_STALE }, body: { state: "live", heartbeat: true }, outcome: "written", after: { state: "live", stampMoved: true }, ping: true },
    { label: "heartbeat differs from a long-stale row: applied as a change and pinged", stored: { state: "off", ageMs: 10 * CAMERA_REPORT_STALE_MS }, body: { state: "live", heartbeat: true }, outcome: "written", after: { state: "live", stampMoved: true }, ping: true },
  ];

  it("each row of the table - change and heartbeat, every stored state, both sides of the freshness boundary - counted", async () => {
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      for (const row of TABLE) {
        const { s, part } = await board({ [side]: row.stored });
        const before = await rowOf(part[side]);
        const d = deps();
        const out = await reportOwnCamera(me(s, side), s.fixtureId, row.body, d);
        const after = await rowOf(part[side]);
        const label = `${side}: ${row.label}`;
        expect(out, label).toEqual({ outcome: row.outcome });
        expect(after.state, `${label}: state`).toBe(row.after.state);
        if (row.after.stampMoved) expect(after.at?.getTime(), `${label}: the stamp is the SERVER's now`).toBe(NOW.getTime());
        else expect(after.at?.getTime(), `${label}: the stamp is untouched`).toBe(before.at?.getTime());
        expect(d.publish.mock.calls.length, `${label}: pings the opponent's room`).toBe(row.ping ? 1 : 0);
        if (row.ping) expect(d.publish).toHaveBeenCalledWith(s.fixtureId);
        // It never touches the OTHER player's row.
        const other = side === "home" ? "away" : "home";
        expect((await rowOf(part[other])).state, `${label}: the other player's row`).toBeNull();
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every table row on both sides").toBe(TABLE.length * 2);
    expect(new Set(TABLE.map((r) => r.outcome)), "and all three outcomes are in the table").toEqual(new Set(["written", "refreshed", "ignored"]));
  });

  it("a reordered pair is harmless: a live heartbeat that lands after the off change finds a fresh row and is dropped - off stays", async () => {
    const { s, part } = await board();
    const t0 = NOW;
    expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "live", heartbeat: false }, deps(t0))).toEqual({ outcome: "written" });
    expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: false }, deps(new Date(t0.getTime() + 1_000)))).toEqual({ outcome: "written" });
    // The heartbeat that was in flight when the camera went off arrives last.
    const late = deps(new Date(t0.getTime() + 2_000));
    expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "live", heartbeat: true }, late)).toEqual({ outcome: "ignored" });
    expect((await rowOf(part.home)).state).toBe("off");
    expect(late.publish).not.toHaveBeenCalled();
  });

  it("'off' held by heartbeats for three times the staleness window still reads off, to the opponent, at the end of it", async () => {
    const { s, part } = await board();
    const t0 = NOW;
    await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: false }, deps(t0));
    let beats = 0;
    for (let at = 30_000; at <= 3 * CAMERA_REPORT_STALE_MS; at += 30_000) {
      const out = await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: true }, deps(new Date(t0.getTime() + at)));
      expect(out, `beat at +${at} ms`).toEqual({ outcome: "refreshed" });
      beats += 1;
    }
    expect(beats, "anti-vacuity: the beats that held it").toBeGreaterThanOrEqual(6);
    const end = new Date(t0.getTime() + 3 * CAMERA_REPORT_STALE_MS);
    expect((await rowOf(part.home)).state).toBe("off");
    // A live game on file, so the pill may show at all (the six null conditions are the room suite's).
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id, moves_uci, move_count, last_move_at)
      values (${s.fixtureId}, ${s.orgId}, 'live', ${T}, ${`gm-${s.fixtureId.slice(0, 8)}`}, 'home', ${s.home.lichessId}, ${s.away.lichessId},
              ${sql.json(["e2e4", "e7e5"] as never)}, 2, ${t0})`;
    // The opponent's pill, read through the real room composer at that instant.
    expect((await readRoom(me(s, "away"), s.fixtureId, { ...deps(end), offered: async () => true, mintRealtime: async () => "t" } as RoomDeps)).opponentCamera).toBe("off");
  });

  it("two tabs: the tab that made the deciding off is gone and a live tab remains - its heartbeats are ignored while off is fresh, and applied once it is not", async () => {
    const { s, part } = await board();
    const t0 = NOW;
    await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: false }, deps(t0)); // tab A turns the camera off, then closes
    const during = deps(new Date(t0.getTime() + CAMERA_REPORT_STALE_MS - 1));
    expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "live", heartbeat: true }, during), "tab B, inside the window").toEqual({ outcome: "ignored" });
    expect((await rowOf(part.home)).state).toBe("off");
    const stale = deps(new Date(t0.getTime() + CAMERA_REPORT_STALE_MS));
    expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "live", heartbeat: true }, stale), "tab B, once the off is stale").toEqual({ outcome: "written" });
    expect((await rowOf(part.home)).state).toBe("live");
    expect(stale.publish, "applied as a change: the opponent is told").toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("camera report - who may write it", () => {
  it("someone else's seat is the room's one 404 and writes nothing: a stranger, a player of another board, the organiser", async () => {
    const { s, part } = await board();
    const other = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, roundOpenedAt: T, linked: true });
    const stranger = await makeUser("camera-report-stranger");
    const callers = [
      { label: "a stranger", identity: { kind: "session" as const, userId: stranger.id } },
      { label: "a player of another board", identity: me(other, "home") },
      { label: "the organiser", identity: { kind: "session" as const, userId: s.ownerUserId } },
    ];
    let checked = 0;
    for (const c of callers) {
      await expect(reportOwnCamera(c.identity, s.fixtureId, { state: "off", heartbeat: false }, deps()), c.label).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      checked += 1;
    }
    expect(checked).toBe(3);
    expect((await rowOf(part.home)).state, "nothing written").toBeNull();
    expect((await rowOf(part.away)).state).toBeNull();
    // The positive pair: the seat's own player writes.
    expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: false }, deps())).toEqual({ outcome: "written" });
  });

  it("a player's link token writes the token's OWN seat and no other", async () => {
    const { s, part } = await board();
    const [open] = await sql<{ id: string; opened_at: Date }[]>`select id, opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
    const token = await mintMatchRoomToken({ fixtureId: s.fixtureId, personId: s.away.personId, roundOpenId: open!.id, roundOpenedAt: open!.opened_at.toISOString() });
    expect(await reportOwnCamera({ kind: "token", token }, s.fixtureId, { state: "live", heartbeat: false }, deps())).toEqual({ outcome: "written" });
    expect((await rowOf(part.away)).state).toBe("live");
    expect((await rowOf(part.home)).state, "the other seat is untouched").toBeNull();
  });

  it("a player never seated in a meeting, and a player whose meeting has ended, are the 404 - and an ended meeting's row is not rewritten", async () => {
    // Never seated: the meeting exists for the side, the participant does not.
    const unseated = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, roundOpenedAt: T, linked: true });
    await putVideoMeeting({ fixtureId: unseated.fixtureId, orgId: unseated.orgId, side: "home" });
    await expect(reportOwnCamera(me(unseated, "home"), unseated.fixtureId, { state: "live", heartbeat: false }, deps())).rejects.toMatchObject({ status: 404 });

    const { s, part } = await board({ home: { state: "live", ageMs: 1_000 } });
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${s.fixtureId} and side = 'home'`;
    const before = await rowOf(part.home);
    await expect(reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: false }, deps())).rejects.toMatchObject({ status: 404 });
    expect(await rowOf(part.home), "an ended meeting's row is not rewritten").toEqual(before);
    // The other player's meeting is still open: that player writes.
    expect(await reportOwnCamera(me(s, "away"), s.fixtureId, { state: "live", heartbeat: false }, deps())).toEqual({ outcome: "written" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("camera report - the limits", () => {
  /** A counter shared across keys, so a test can read what each limit saw. */
  function counter() {
    const counts = new Map<string, number>();
    __setRateLimitCounterForTests(async (key, windowSeconds) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { count: n, ttlMs: windowSeconds * 1000 };
    });
    return counts;
  }

  it("the ping is limited per seat: past CAMERA_FAULT_PING_LIMIT changes the row is still written and the opponent is not told; the next report is judged normally", async () => {
    counter();
    expect(CAMERA_FAULT_PING_LIMIT.max, "premise: the ping budget is below the route's, so a seat reaches it first").toBeLessThan(CAMERA_REPORT_LIMIT.max);
    const { s, part } = await board();
    const d = deps();
    const states: State[] = [];
    for (let i = 0; i < CAMERA_FAULT_PING_LIMIT.max + 1; i += 1) {
      const state: State = i % 2 === 0 ? "off" : "live";
      states.push(state);
      expect(await reportOwnCamera(me(s, "home"), s.fixtureId, { state, heartbeat: false }, d), `change ${i}`).toEqual({ outcome: "written" });
    }
    expect(d.publish.mock.calls.length, "pings stop at the budget").toBe(CAMERA_FAULT_PING_LIMIT.max);
    expect((await rowOf(part.home)).state, "and the last change was still written").toBe(states.at(-1));
  });

  it("past CAMERA_REPORT_LIMIT reports the next is a 429 and writes nothing; another seat has its own count", async () => {
    counter();
    const { s, part } = await board();
    // Heartbeats that refresh: no pings, so only the route's own limit is reached.
    await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "live", heartbeat: false }, deps());
    for (let i = 1; i < CAMERA_REPORT_LIMIT.max; i += 1) await reportOwnCamera(me(s, "home"), s.fixtureId, { state: "live", heartbeat: true }, deps());
    const before = await rowOf(part.home);
    await expect(reportOwnCamera(me(s, "home"), s.fixtureId, { state: "off", heartbeat: false }, deps())).rejects.toMatchObject({ status: 429 });
    expect(await rowOf(part.home), "nothing written past the limit").toEqual(before);
    expect(await reportOwnCamera(me(s, "away"), s.fixtureId, { state: "live", heartbeat: false }, deps()), "the other seat's count").toEqual({ outcome: "written" });
  });

  it("a stranger spends none of a seat's budget (identity first)", async () => {
    const counts = counter();
    const { s } = await board();
    const stranger = await makeUser("camera-report-budget");
    await expect(reportOwnCamera({ kind: "session", userId: stranger.id }, s.fixtureId, { state: "off", heartbeat: false }, deps())).rejects.toMatchObject({ status: 404 });
    expect([...counts.keys()].filter((k) => k.startsWith("room-camera-report")), "no key was touched").toEqual([]);
  });
});
