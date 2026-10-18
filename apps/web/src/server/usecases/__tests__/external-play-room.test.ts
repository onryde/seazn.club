// apps/web/src/server/usecases/__tests__/external-play-room.test.ts
//
// T14 — the match room usecase (design §6; spec §5, §8.2, §12.1): identity
// (session, or a link token bound to the round's OPEN — M4), a write-free
// GET, the seat claim through preflight's seatPlayer with the check-in it
// stamps, T9's createGameIfReady as the one challenge producer, the T20 start
// gate, the frozen seat (T11 M7), the held board's watch link, and the act /
// clock-zero reconcile triggers.
//
// Every case below runs camera policy `off` (the seed's default), so the REAL
// seatPlayer seats without RealtimeKit; T9's create is a seam (its own suite
// owns it) and the T20 flag is asked through `deps.offered`, because vitest
// runs with ONLINE_CHESS_ALWAYS=1. Single-sport by construction: online play
// exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { foldMatch } from "@seazn/engine/core";
import EN from "@/dictionaries/en/ui.json";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import {
  boardAnchor,
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  DEADLINE_AFTER_MS,
  roomPhase,
  WINDOW_OPEN_LEAD_MS,
  windowFor,
} from "@/server/external-play/window";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { mintMatchRoomToken } from "../match-room-token";
import { stampFixtureCheckIn } from "../me";
import { act, type PlayResult } from "../external-play/play";
import { fenAfter } from "@/server/external-play/fen";
import { holdRefusedNoShow, writeResultFrom } from "../external-play/result";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { resolveExternalPlay } from "../external-play/resolve";
import { closeBridgeIfUnplayable } from "../external-play/bridge-close";
import { ensureBridgeRow, loadOnlinePlayFixture } from "../external-play/guard";
import { scoreEvent } from "../scoring";
import type { GameSnapshot } from "@/server/external-play/types";
import { CLOCK_ZERO_SPACING_MS } from "@/components/public-site/match-room/use-room";
import {
  CLOCK_ZERO_COOLDOWN_MS,
  CLOCK_ZERO_TOLERANCE_MS,
  actInRoom,
  claimRoomSeat,
  readRoom,
  reportCameraFault,
  reportClockZero,
  roomGrantDowngraded,
  type RoomDeps,
  type RoomIdentity,
} from "../external-play/room";
import { seatPlayer } from "../external-play/preflight";
import { startLichessFixtureServer } from "../../../../e2e/lichess-fixture-server";
import { seatCameraEvidence } from "@/server/external-play/video/realtimekit";
import { GUARD_FAULT_MAX_STAMPS } from "@/server/external-play/video/guard-faults";
import { GUARD_FAULT_FLAG_STAMPS } from "@/server/external-play/video/match-camera-off";
import { CAMERA_FAULT_PING_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { makeUser } from "./_seed";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";
import { CAMERA_REPORT_HEARTBEAT_MS, CAMERA_REPORT_STALE_MS } from "@/components/public-site/match-room/room-snapshot";

// M-9: a settle on a game on file ends the game at Lichess, after the response. That is proven against the Lichess
// fixture in external-play-settle-ends-game.test.ts; here it would reach lichess.org itself with a seed token, so the
// ending is stubbed (the read of the game to end stays real).
vi.mock("../external-play/end-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-play/end-game")>()),
  endLichessGame: vi.fn(async () => true),
}));

// Final re-review 4, m2: a pause between the seat call's two reads of the board, where a case stages an Unpair —
// null (a straight pass-through) unless a case stages one.
const gate = vi.hoisted(() => ({ reset: null as null | (() => Promise<void>) }));
vi.mock("../external-play/guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../external-play/guard")>();
  return {
    ...real,
    resetStaleBridge: async (...a: Parameters<typeof real.resetStaleBridge>) => {
      await gate.reset?.();
      return real.resetStaleBridge(...a);
    },
  };
});

// `stampFixtureCheckIn` stamps the DB's own now() (real wall clock) and
// `checkInCounts` judges THAT stamp against the open's window, so the open is
// anchored to the real clock: T five minutes ahead, the window T-10..the deadline.
const T = new Date(Date.now() + 5 * 60_000);
const now = new Date();

function deps(overrides: Partial<RoomDeps> = {}): RoomDeps & {
  publish: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  offered: ReturnType<typeof vi.fn>;
} {
  return {
    now,
    publish: vi.fn(async () => {}),
    create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
    offered: vi.fn(async () => true),
    mintRealtime: vi.fn(async () => "rt-token"),
    ...overrides,
  } as never;
}

async function seed(over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) {
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    roundOpenedAt: T,
    linked: true,
    homeFullName: "Ada Okonkwo",
    awayFullName: "Bo Lind",
    ...over,
  });
}

async function openOf(s: SeedOnlineChessFixtureResult): Promise<{ id: string; openedAt: Date }> {
  const [row] = await sql<{ id: string; opened_at: Date }[]>`
    select id, opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
  if (!row) throw new Error("premise: the seed opened round 1");
  return { id: row.id, openedAt: row.opened_at };
}

async function tokenFor(
  s: SeedOnlineChessFixtureResult,
  personId: string,
  over: Partial<{ fixtureId: string; roundOpenId: string; roundOpenedAt: Date }> = {},
) {
  const open = await openOf(s);
  return mintMatchRoomToken({
    fixtureId: over.fixtureId ?? s.fixtureId,
    personId,
    roundOpenId: over.roundOpenId ?? open.id,
    roundOpenedAt: (over.roundOpenedAt ?? open.openedAt).toISOString(),
  });
}

/** A game on file as T9's writer leaves it (status ready, colours and both
 *  accounts recorded) — by SQL, standing for createGameIfReady (its own
 *  suite drives the real one; external-play-room-game.test.ts drives it here). */
async function gameOnFile(
  s: SeedOnlineChessFixtureResult,
  over: Partial<{ status: string; whiteSide: "home" | "away"; moves: string[]; needsReason: string; revokedSeat: string; whiteMs: number; blackMs: number; lastMoveAt: Date; clockIncrementS: number }> = {},
) {
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  const whiteSide = over.whiteSide ?? "home";
  const white = whiteSide === "home" ? s.home : s.away;
  const black = whiteSide === "home" ? s.away : s.home;
  const moves = over.moves ?? [];
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
       moves_uci, move_count, last_move_at, white_ms, black_ms, needs_reason, revoked_seat, clock_increment_s)
    values (${s.fixtureId}, ${s.orgId}, ${over.status ?? "ready"}, ${T}, ${gameId}, ${whiteSide}, ${white.lichessId},
            ${black.lichessId}, ${sql.json(moves as never)}, ${moves.length}, ${over.lastMoveAt ?? (moves.length ? now : null)},
            ${over.whiteMs ?? null}, ${over.blackMs ?? null}, ${over.needsReason ?? null}, ${over.revokedSeat ?? null},
            ${over.clockIncrementS ?? null})
    on conflict (fixture_id) do update set status = excluded.status, challenge_id = excluded.challenge_id,
      white_side = excluded.white_side, white_lichess_id = excluded.white_lichess_id, black_lichess_id = excluded.black_lichess_id,
      moves_uci = excluded.moves_uci, move_count = excluded.move_count, last_move_at = excluded.last_move_at,
      white_ms = excluded.white_ms, black_ms = excluded.black_ms, needs_reason = excluded.needs_reason,
      revoked_seat = excluded.revoked_seat, clock_increment_s = excluded.clock_increment_s`;
  return gameId;
}

async function rows(fixtureId: string) {
  const bridge = await sql`select * from fixture_external_play where fixture_id = ${fixtureId}`;
  const availability = await sql`select * from fixture_availability where fixture_id = ${fixtureId} order by person_id`;
  return { bridge, availability };
}

afterAll(async () => {
  await sql.end();
});

describe.skipIf(!process.env.DATABASE_URL)("match room — identity (every failure is the same 404)", () => {
  it("session: each player reads their own seat, by the PERSON's name, never the snapshot", async () => {
    const s = await seed();
    const home = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    const away = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect([home.you.name, home.opponent.name]).toEqual(["Ada Okonkwo", "Bo Lind"]);
    expect([away.you.name, away.opponent.name]).toEqual(["Bo Lind", "Ada Okonkwo"]);
    // Pairing default: home is White (whiteSideOf), no game recorded yet.
    expect([home.you.colour, away.you.colour]).toEqual(["white", "black"]);
    // FIXED links (never history.back()): the fixture page, and the division
    // page above it that carries the standings.
    expect(home.links.fixture).toMatch(new RegExp(`^/shared/${home.orgSlug}/[^/]+/[^/]+/fixtures/${s.fixtureId}$`));
    expect(home.links.fixture).toBe(`${home.links.standings}/fixtures/${s.fixtureId}`);
    expect(routes.sharedFixturePlay("o", "c", "d", s.fixtureId, "tok")).toBe(`/shared/o/c/d/fixtures/${s.fixtureId}/play?t=tok`);
  });

  it("a non-player session ⇒ 404 NOT_FOUND", async () => {
    const s = await seed();
    const stranger = await makeUser("stranger");
    await expect(readRoom({ kind: "session", userId: stranger.id }, s.fixtureId, deps())).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("a valid link token reads the room with no session (the positive the refusals below pair with)", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.away.personId);
    const v = await readRoom({ kind: "token", token }, s.fixtureId, deps());
    expect(v.you.name).toBe("Bo Lind");
  });

  it("each token claim is checked ALONE: another fixture, another round's open, another person, expired ⇒ 404", async () => {
    const s = await seed();
    const other = await seed();
    const otherOpen = await openOf(other);
    const cases: [string, string][] = [
      // Only the fixture claim is wrong (s's own open and person).
      ["fixture", await tokenFor(s, s.home.personId, { fixtureId: other.fixtureId })],
      // Only the open is wrong (s's own fixture and person).
      ["open", await tokenFor(s, s.home.personId, { roundOpenId: otherOpen.id })],
      // A real person, on another fixture.
      ["person", await tokenFor(s, other.home.personId)],
      // Expired: the open's +24h is long past (the verify's own 401 is swallowed).
      ["expired", await tokenFor(s, s.home.personId, { roundOpenedAt: new Date("2000-01-01T00:00:00Z") })],
    ];
    let checked = 0;
    for (const [label, token] of cases) {
      await expect(readRoom({ kind: "token", token }, s.fixtureId, deps()), label).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity: token claims refused one at a time").toBe(4);
  });

  it("a token for an UNOPENED round resolves nothing (there is no open to bind to) — while the session reads not_opened", async () => {
    const s = await seed({ roundOpenedAt: undefined });
    const token = await mintMatchRoomToken({
      fixtureId: s.fixtureId,
      personId: s.home.personId,
      roundOpenId: randomUUID(),
      roundOpenedAt: new Date().toISOString(),
    });
    await expect(readRoom({ kind: "token", token }, s.fixtureId, deps())).rejects.toMatchObject({ status: 404 });
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).phase).toBe("not_opened");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — the GET never writes", () => {
  it("reading a room with a STALE bridge twice leaves the bridge row and fixture_availability untouched", async () => {
    const s = await seed();
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${oldBasis})`;
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    const before = await rows(s.fixtureId);
    const d = deps();
    await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, d);
    expect(await rows(s.fixtureId)).toEqual(before);
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — D12 phase and window", () => {
  it("the empty case: an unopened round reads not_opened, with no window and nothing to create, whatever the timetable says", async () => {
    const s = await seed({ roundOpenedAt: undefined });
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ now: new Date(T.getTime() + 60_000) }));
    expect(v).toMatchObject({ phase: "not_opened", opensAt: null, deadline: null, roundOpenedAt: null, creation: null, game: null });
    expect(v.scheduledAt, "the schedule is shown as information").toBe(T.toISOString());
  });

  it("an opened round reads the open's window (derived from windowFor), and closes at the deadline", async () => {
    const s = await seed();
    const w = windowFor(boardAnchor(T, 0, false));
    const open = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(open).toMatchObject({ phase: "open", opensAt: w.opensAt.toISOString(), deadline: w.deadline.toISOString() });
    const closed = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ now: w.deadline }));
    expect(closed.phase).toBe("closed");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — taking the seat", () => {
  it("before the window: refused checkin_not_open (the round is open, the board's window is not), nothing stamped, nothing published", async () => {
    const s = await seed();
    const early = new Date(T.getTime() - WINDOW_OPEN_LEAD_MS - 60_000);
    const d = deps({ now: early });
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(c.seat).toEqual({ seated: false, reason: "checkin_not_open", participant: null });
    expect((await rows(s.fixtureId)).availability).toEqual([]);
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("after the deadline with no game: refused window_closed, nothing stamped", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.home.personId);
    const late = new Date(T.getTime() + DEADLINE_AFTER_MS);
    const c = await claimRoomSeat({ kind: "token", token }, s.fixtureId, deps({ now: late }));
    expect(c.seat).toMatchObject({ seated: false, reason: "window_closed" });
    expect((await rows(s.fixtureId)).availability).toEqual([]);
  });

  it("the first seat stamps the check-in and pings the lobby, and asks for no game", async () => {
    const s = await seed();
    const d = deps();
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(c.seat).toEqual({ seated: true, participant: null });
    expect(c.snapshot.you.checkedIn).toBe(true);
    expect(c.snapshot.opponent.checkedIn).toBe(false);
    expect(c.snapshot.creation).toBeNull();
    expect(d.publish).toHaveBeenCalledWith(s.fixtureId);
    expect(d.create).not.toHaveBeenCalled();
    expect(c.create).toBeNull();
  });

  it("the SECOND seat asks T9 for the game exactly once; the room then says it is being created", async () => {
    const s = await seed();
    const d = deps();
    await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    const second = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, d);
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.create).toHaveBeenCalledWith(s.fixtureId);
    expect(second.create).toEqual({ created: false, reason: "not_ready" });
    expect(second.snapshot.creation).toEqual({ state: "creating" });
    // The first player's view says the same, by the GET.
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).creation).toEqual({ state: "creating" });
  });

  it("m3: T9 refusing the create because the club is not offered online chess sets onlineChessOff on THAT answer, even when the room's own flag read raced it", async () => {
    const s = await seed();
    // The room's flag reads say "offered" (a flag flipping between them and
    // T9's own check); T9 is the last word.
    const d = deps({ create: vi.fn(async () => ({ created: false as const, reason: "online_chess_disabled" as const })) });
    await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    const second = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, d);
    expect(second.create).toEqual({ created: false, reason: "online_chess_disabled" });
    expect(second.snapshot.onlineChessOff).toBe(true);
    // The pair: any other refusal leaves the flag as the room read it.
    const t = await seed();
    const d2 = deps({ create: vi.fn(async () => ({ created: false as const, reason: "provider_error" as const })) });
    await claimRoomSeat({ kind: "session", userId: t.home.userId }, t.fixtureId, d2);
    const other = await claimRoomSeat({ kind: "session", userId: t.away.userId }, t.fixtureId, d2);
    expect(other.create).toEqual({ created: false, reason: "provider_error" });
    expect(other.snapshot.onlineChessOff).toBe(false);
  });

  it("a create held back by Lichess's rate limit reads busy, with T9's own retry instant", async () => {
    const s = await seed();
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await stampFixtureCheckIn(s.away.personId, s.fixtureId, s.orgId);
    const retryAt = new Date(Date.now() + 48_000).toISOString();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, last_error)
      values (${s.fixtureId}, ${s.orgId}, 'pending', ${T}, ${`create:rate_limited (challenger_budget) retry_at=${retryAt}`})`;
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(v.creation).toEqual({ state: "busy", retryAt });
  });

  it("T20: with the club NOT offered online chess and no game on file, nothing is seated, stamped or created — the room says so", async () => {
    const s = await seed();
    const seat = vi.fn();
    const d = deps({ offered: vi.fn(async () => false), seat: seat as never });
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(c.seat).toBeNull();
    expect(c.snapshot.onlineChessOff).toBe(true);
    expect(seat).not.toHaveBeenCalled();
    expect((await rows(s.fixtureId)).availability).toEqual([]);
    expect(d.create).not.toHaveBeenCalled();
    // The GET agrees (the client stops polling on it).
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d)).onlineChessOff).toBe(true);
  });

  it("T20: a board with a game on file is NEVER gated — the flag is not even asked, and the seat is", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: ["e2e4"] });
    const offered = vi.fn(async () => false);
    const seat = vi.fn(async () => ({ seated: true as const, participant: null }));
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ offered, seat: seat as never }));
    expect(offered).not.toHaveBeenCalled();
    expect(seat).toHaveBeenCalledTimes(1);
    expect(c.snapshot.onlineChessOff).toBe(false);
  });

  it("a re-entering player (reload mid-game) is re-seated but their check-in is NEVER re-stamped", async () => {
    const s = await seed();
    await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
    await gameOnFile(s, { status: "live", moves: ["e2e4"] });
    const before = (await rows(s.fixtureId)).availability;
    const d = deps({ seat: vi.fn(async () => ({ seated: true as const, participant: null })) as never });
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(c.seat).toEqual({ seated: true, participant: null });
    expect((await rows(s.fixtureId)).availability).toEqual(before);
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });

  it("a camera refusal hands the caller THEIR OWN participant token back (to join and retry), never another's", async () => {
    const s = await seed();
    const participant = { participantId: "pt-home", authToken: "jwt-home" };
    const seat = vi.fn(async () => ({ seated: false as const, reason: "camera_required" as const, participant }));
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ seat: seat as never }));
    expect(c.seat).toEqual({ seated: false, reason: "camera_required", participant });
    expect(seat).toHaveBeenCalledWith({ fixtureId: s.fixtureId, personId: s.home.personId, heldParticipantId: null }, { now });
    expect((await rows(s.fixtureId)).availability, "a refused seat is not a check-in").toEqual([]);
  });

  it("D21-fix-3 (F1): the participant id the browser HOLDS rides to the seat; a browser that holds none sends none - and a second claim is told apart", async () => {
    const s = await seed();
    const seat = vi.fn(async () => ({ seated: false as const, reason: "camera_starting" as const, participant: null }));
    let checked = 0;
    for (const held of ["pt-held", null] as const) {
      seat.mockClear();
      await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ seat: seat as never }), { heldParticipantId: held });
      expect(seat, `held ${held}`).toHaveBeenCalledWith({ fixtureId: s.fixtureId, personId: s.home.personId, heldParticipantId: held }, { now });
      checked += 1;
    }
    // …and a claim made with no ask at all (the route's body was absent) holds nothing.
    seat.mockClear();
    await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ seat: seat as never }));
    expect(seat).toHaveBeenCalledWith({ fixtureId: s.fixtureId, personId: s.home.personId, heldParticipantId: null }, { now });
    checked += 1;
    expect(checked, "anti-vacuity: held, none, no ask").toBe(3);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — R3-1: the viewer's OWN participant on file (the room re-claims when it is not the one its camera joined)", () => {
  /** The board's meetings as preflight leaves them, made for the pairing the board has: a meeting PER PLAYER (D16), each with
   *  its player in it, and an arbiter in the home player's. */
  async function meetingWithBoth(s: SeedOnlineChessFixtureResult) {
    const meetings = {
      home: await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "home" }),
      away: await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "away" }),
    };
    const part = { home: `pt-h-${randomUUID().slice(0, 8)}`, away: `pt-a-${randomUUID().slice(0, 8)}`, arbiter: `arb-${randomUUID().slice(0, 8)}` };
    await putVideoParticipant({ fixtureId: s.fixtureId, side: "home", personId: s.home.personId, participantId: part.home });
    await putVideoParticipant({ fixtureId: s.fixtureId, side: "away", personId: s.away.personId, participantId: part.away });
    await putVideoParticipant({ fixtureId: s.fixtureId, side: "home", personId: null, preset: "arbiter", participantId: part.arbiter });
    return { meetingId: meetings.home, meetings, part };
  }
  const own = async (s: SeedOnlineChessFixtureResult, side: "home" | "away") =>
    (await readRoom({ kind: "session", userId: s[side].userId }, s.fixtureId, deps())).ownParticipantId;

  it("the empty case: no meeting on file ⇒ null for both seats; cameras off ⇒ null", async () => {
    const none = await seed({ cameraPolicy: "required" });
    expect(await own(none, "home")).toBeNull();
    expect(await own(none, "away")).toBeNull();
    const off = await seed({ cameraPolicy: "off" });
    expect(await own(off, "home")).toBeNull();
  });

  it("each seat reads ITS OWN player participant — never the opponent's, never the arbiter's — before the game and on a live one, counted", async () => {
    let checked = 0;
    for (const bridge of [null, { status: "live", moves: ["e2e4", "e7e5"] }] as const) {
      const s = await seed({ cameraPolicy: "required" });
      if (bridge) await gameOnFile(s, bridge as never);
      const { part } = await meetingWithBoth(s);
      for (const side of ["home", "away"] as const) {
        expect(await own(s, side), `${bridge ? "live" : "no game"} / ${side}`).toBe(part[side]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: board × seat").toBe(4);
  });

  it("the states a seated room lives through, in sequence: the sweep ENDS the meeting (its row stays) ⇒ unchanged; an arbiter's removal ⇒ unchanged; the R2-2 retire (the row deleted, its participants with it) ⇒ null for both; the new pairing's meeting mints ⇒ the NEW id", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const { part } = await meetingWithBoth(s);
    expect(await own(s, "home"), "seated").toBe(part.home);

    // An arbiter is removed at its TTL (sweep arbiterRevoke): the player's own participant is untouched.
    await sql`update fixture_video_participants set removed_at = now() where fixture_id = ${s.fixtureId} and preset = 'arbiter'`;
    expect(await own(s, "home"), "an arbiter's removal is not the player's").toBe(part.home);

    // The sweep ends the meeting at the window's close (endMeeting): the row and its participants stay.
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${s.fixtureId}`;
    expect(await own(s, "home"), "an ENDED meeting keeps the participant — nothing to re-claim").toBe(part.home);
    expect(await own(s, "away")).toBe(part.away);

    // The R2-2 retire: one statement deletes the stale row; the participants cascade.
    await sql`delete from fixture_video_meetings where fixture_id = ${s.fixtureId}`;
    expect(await own(s, "home"), "retired ⇒ none on file").toBeNull();
    expect(await own(s, "away")).toBeNull();

    // The new pairing's meeting; this player's seat mints them into it.
    await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "home" });
    const fresh = `pt-new-${randomUUID().slice(0, 8)}`;
    await putVideoParticipant({ fixtureId: s.fixtureId, side: "home", personId: s.home.personId, participantId: fresh });
    expect(await own(s, "home"), "the new meeting's participant").toBe(fresh);
    expect(await own(s, "away"), "the opponent has not re-claimed yet").toBeNull();
  });

  it("a claim's own answer names the participant its seat holds — composed AFTER the seat, so a fresh seat never reads as moved", async () => {
    const s = await seed({ cameraPolicy: "required" });
    const participant = { participantId: `pt-${randomUUID().slice(0, 8)}`, authToken: "jwt-home" };
    // Stands for seatPlayer: the meeting made, the participant stored, the camera refused (nobody live yet).
    const seat = vi.fn(async () => {
      await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "home" });
      await putVideoParticipant({ fixtureId: s.fixtureId, side: "home", personId: s.home.personId, participantId: participant.participantId });
      return { seated: false as const, reason: "camera_required" as const, participant };
    });
    expect(await own(s, "home"), "premise — nothing on file before the claim").toBeNull();
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ seat: seat as never }));
    expect(c.seat).toEqual({ seated: false, reason: "camera_required", participant });
    expect(c.snapshot.ownParticipantId).toBe(participant.participantId);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — the game as the room shows it", () => {
  it("board, last move, turn and clocks come from T10's ledger; the colour from the RECORDED white_side, never the pairing", async () => {
    const s = await seed();
    const moves = ["e2e4", "e7e5", "g1f3"];
    // Recorded: AWAY is White, although the pairing (no event) says home.
    await gameOnFile(s, { status: "live", whiteSide: "away", moves, whiteMs: 590_000, blackMs: 595_000 });
    const home = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(home.you.colour).toBe("black");
    expect(home.opponent.colour).toBe("white");
    expect(home.game).toMatchObject({
      moves,
      fen: fenAfter(moves).fen,
      lastMove: ["g1", "f3"],
      turn: "black",
      whiteMs: 590_000,
      blackMs: 595_000,
      clockRunning: true,
      over: false,
    });
    expect(home.watchUrl).toBe(`https://lichess.org/${home.game!.gameId}`);
  });

  it("before any move both clocks show the division's own limit (15+10 seed ⇒ 900 s), not a hard-coded one", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "ready" });
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(v.meta).toMatchObject({ limitSeconds: 900, incrementSeconds: 10, roundNo: 1, boardNo: 1 });
    expect([v.game!.whiteMs, v.game!.blackMs]).toEqual([900_000, 900_000]);
    expect(v.game!.clockRunning).toBe(false);
  });

  // T17B fix 2, D24 (re-review M2): the client's guess at a drop adds `meta.incrementSeconds`; the server's write adds
  // `coalesce(clock_increment_s, f.clock.increment)` (play.ts). The ledger's number is the game's own clock — stamped on
  // the first move and re-read from Lichess's — and the division's can be edited after the game began, so the snapshot
  // carries the LEDGER's when it holds one: the guess and the write then read the same number by construction.
  it("D24 M2: meta.incrementSeconds is the LEDGER's clock_increment_s once the game has one (0 included), the division's before — for every ship-1 control (counted)", async () => {
    const seed15_10 = await seed(); // the division is 15+10 (the case above)
    await gameOnFile(seed15_10, { status: "ready" });
    const before = await readRoom({ kind: "session", userId: seed15_10.home.userId }, seed15_10.fixtureId, deps());
    expect(before.meta.incrementSeconds, "no ledger number yet: the division's own").toBe(10);
    let checked = 0;
    let differing = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const s = await seed();
      await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"], whiteMs: 300_000, blackMs: 300_000, clockIncrementS: tc.incrementSeconds });
      const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
      expect(v.meta.incrementSeconds, `${tc.key}: the ledger's number (the division says 10)`).toBe(tc.incrementSeconds);
      if (tc.incrementSeconds !== 10) differing += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity: every ship-1 control").toBe(SHIP1_TIME_CONTROLS.length);
    expect(differing, "anti-vacuity: most differ from the division's 10, so a fall-through to it would be seen").toBeGreaterThanOrEqual(SHIP1_TIME_CONTROLS.length - 1);
    expect(SHIP1_TIME_CONTROLS.some((tc) => tc.incrementSeconds === 0), "premise: a zero-increment control is in the list (0 must not fall through)").toBe(true);
  });

  it("T11 M7 (+ final re-review P11 (1)): a seat hold — token_revoked or account_changed — freezes ONE seat: its player reads `you`, the opponent `opponent` and keeps a live board and the watch link — counted", async () => {
    let checked = 0;
    for (const needsReason of ["token_revoked", "account_changed"] as const) {
      const s = await seed();
      await gameOnFile(s, { status: "needs_organiser", needsReason, revokedSeat: "white", moves: ["e2e4", "e7e5"] });
      const white = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
      const black = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
      expect(white.frozen, needsReason).toBe("you");
      expect(black.frozen, needsReason).toBe("opponent");
      expect(black.held, `${needsReason}: the opponent's board is not held`).toBe(false);
      expect(black.game?.over, needsReason).toBe(false);
      expect(black.watchUrl, `${needsReason}: a held board still moving keeps its link`).not.toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a token_revoked hold with NO recorded seat freezes both", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "needs_organiser", needsReason: "token_revoked", moves: ["e2e4"] });
    const v = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect(v.frozen).toBe("both");
  });

  it("I1: a token_revoked hold that T12 then settles — the frozen player reads the RESULT, and is frozen no longer", async () => {
    const s = await seed();
    const gameId = await gameOnFile(s, { status: "needs_organiser", needsReason: "token_revoked", revokedSeat: "white", moves: ["e2e4", "e7e5"] });
    const before = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect([before.frozen, before.result], "premise: White frozen, nothing written").toEqual(["you", null]);
    // T12's real result writer, as reconcile calls it while the row is held
    // (RECONCILED_WHILE_HELD): Black wins on time.
    const wrote = await writeResultFrom(
      { gameId, status: "outoftime", winner: "black", movesSan: ["e4", "e5"], whiteMs: 0, blackMs: 1_000, increment: 0 } as GameSnapshot,
      s.fixtureId,
    );
    expect(wrote, "premise: the result was written").toEqual({ wrote: "decided" });
    const [bridge] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(bridge!.status, "premise: the hold is still on the row (finish() closes only ready/live)").toBe("needs_organiser");
    const white = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    const black = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect(white.result).toMatchObject({ outcome: "lost", score: "0–1", method: "time" });
    expect(white.frozen, "a written result outranks the frozen seat").toBeNull();
    expect(white.canAct).toBe(false);
    expect(black.result).toMatchObject({ outcome: "won", score: "0–1" });
  });

  it("I7 + I-3: the organiser's No result on a game being played reads as NO RESULT for both players — VOID (an abandon), no method, no score; never a draw", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    // The real producer: the organiser's settle. No hold on the board: the reason is the organiser's own decision.
    expect(await resolveExternalPlay(await mintOrgOwnerAuth(s.orgId), s.fixtureId, "no_result")).toEqual({ status: "finished" });
    const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${s.fixtureId} order by seq`;
    expect(ledger, "premise: the abandon is the ledger's one event").toEqual([
      { type: "core.abandon", payload: { reason: (EN as Record<string, string>)["externalPlay.resolve.abandonReason.none"] } },
    ]);
    const [fx] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${s.fixtureId}`;
    expect(fx, "premise: the engine decided nobody").toEqual({ status: "abandoned", outcome: null });
    let checked = 0;
    for (const who of [s.home, s.away]) {
      const snap = await readRoom({ kind: "session", userId: who.userId }, s.fixtureId, deps());
      expect(snap.result).toEqual({ outcome: "no_result", method: null, score: "" });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("I7 + I-3: both players absent — the organiser's double walkover (W2b's, asked for by name: M-7) is read as NO RESULT for both, as the engine folds it, never a draw", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: [] });
    await holdRefusedNoShow({ fixtureId: s.fixtureId, absent: "both", detail: "sweep: refused 3 passes running (TEST)" });
    expect(await resolveExternalPlay(await mintOrgOwnerAuth(s.orgId), s.fixtureId, "double_walkover")).toEqual({ status: "finished" });
    const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${s.fixtureId} order by seq`;
    expect(ledger, "premise: the double walkover is the ledger's one event").toEqual([{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }]);
    // The expected card, from the engine's own fold of that event (home is White here).
    const state = foldMatch(
      boardgame,
      boardgame.configSchema.parse({}),
      { home: { entrantId: s.home.entrantId, slots: [] }, away: { entrantId: s.away.entrantId, slots: [] } },
      [{ id: "e0", fixtureId: s.fixtureId, seq: 0, type: "core.forfeit", payload: { by: "both", reason: "walkover" }, recordedAt: now.toISOString(), recordedBy: null }],
    );
    const summary = boardgame.summary(state);
    const line = (entrant: string) => summary.perSide.find((p) => p.entrantId === entrant)!.line;
    const [fx] = await sql<{ status: string; outcome: { kind: string } | null }[]>`select status, outcome from fixtures where id = ${s.fixtureId}`;
    expect(fx!.outcome, "premise: the engine folded it to a double walkover").toEqual(boardgame.outcome(state));
    expect(fx!.outcome).toEqual({ kind: "double_walkover" });
    let checked = 0;
    for (const who of [s.home, s.away]) {
      const snap = await readRoom({ kind: "session", userId: who.userId }, s.fixtureId, deps());
      expect(snap.result).toEqual({
        outcome: "no_result",
        method: (summary.detail as { method?: string }).method,
        score: `${line(s.home.entrantId)}–${line(s.away.entrantId)}`,
      });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("I2 + re-review 5 I-2: canAct IS play.ts's acceptance — BOTH directions, over every hold, seat and account state", async () => {
    type Bridge = {
      label: string;
      bridge: Parameters<typeof gameOnFile>[1];
      /** A board change no bridge column carries (a withdrawal). */
      after?: (s: SeedOnlineChessFixtureResult) => Promise<unknown>;
      // Ruling M7 (T11): a token_revoked hold freezes only the revoked seat;
      // every other hold, a finished and a withdrawn board accept nothing (T10).
      white: boolean;
      black: boolean;
      held: boolean;
      clockRunning: boolean;
    };
    const moves = ["e2e4", "e7e5"];
    const bridges: Bridge[] = [
      { label: "live", bridge: { status: "live", moves }, white: true, black: true, held: false, clockRunning: true },
      { label: "token_revoked, White's seat", bridge: { status: "needs_organiser", needsReason: "token_revoked", revokedSeat: "white", moves }, white: false, black: true, held: false, clockRunning: true },
      { label: "token_revoked, no seat recorded", bridge: { status: "needs_organiser", needsReason: "token_revoked", moves }, white: false, black: false, held: false, clockRunning: true },
      // Final re-review P11 (1): account_changed freezes its seat the same way (ruling M7's reasoning).
      { label: "account_changed, White's seat", bridge: { status: "needs_organiser", needsReason: "account_changed", revokedSeat: "white", moves }, white: false, black: true, held: false, clockRunning: true },
      { label: "account_changed, no seat recorded", bridge: { status: "needs_organiser", needsReason: "account_changed", moves }, white: false, black: false, held: false, clockRunning: true },
      // A mid-game diagnosis is not an organiser hold of a game still being
      // played (`held` false) — but play.ts refuses every act on it.
      // Clocks are Lichess's: a hold of OURS does not stop them there.
      { label: "provider_error mid-game", bridge: { status: "needs_organiser", needsReason: "provider_error", moves }, white: false, black: false, held: false, clockRunning: true },
      // T13's deadline hold of a created game: held for the organiser.
      { label: "not_started with a game on file", bridge: { status: "needs_organiser", needsReason: "not_started", moves: [] }, white: false, black: false, held: true, clockRunning: false },
      { label: "finished", bridge: { status: "finished", moves }, white: false, black: false, held: false, clockRunning: false },
      // Controller ruling Q2: a withdrawal leaves the board `abandoned`; the
      // guard still loads it, and nobody may act on it.
      {
        label: "withdrawn (abandoned)",
        bridge: { status: "live", moves },
        after: (s) => sql`update fixtures set status = 'abandoned' where id = ${s.fixtureId}`,
        white: false,
        black: false,
        held: false,
        clockRunning: true,
      },
    ];
    // What happened to WHITE's Lichess account after the game was created
    // (T9 recorded both accounts with it). Black's stays as recorded — the pair.
    type Account = "as recorded" | "re-linked to another account" | "unlinked" | "grant downgraded";
    const accounts: Account[] = ["as recorded", "re-linked to another account", "unlinked", "grant downgraded"];
    const changeAccount = async (userId: string, a: Account) => {
      if (a === "re-linked to another account")
        await sql`update user_external_accounts set external_user_id = ${`x-${randomUUID().slice(0, 8)}`} where user_id = ${userId} and provider = 'lichess'`;
      if (a === "unlinked") await sql`delete from user_external_accounts where user_id = ${userId} and provider = 'lichess'`;
      if (a === "grant downgraded")
        await sql`update user_external_accounts set scopes = array_remove(scopes, 'board:play') where user_id = ${userId} and provider = 'lichess'`;
    };
    // The REAL act (T10) behind the room, Lichess stubbed: an act it accepts
    // reaches the board call and comes back ok.
    const boardCalls: string[] = [];
    const realPlay: RoomDeps["play"] = (a) =>
      act(a, {
        now,
        accessToken: async () => "tok",
        offerOrAcceptDraw: async (x) => (boardCalls.push(x.gameId), { ok: true }),
        publish: async () => {},
      });
    type Outcome = "accepted" | "404" | `grant:${string}`;
    const outcomeOf = async (userId: string, fixtureId: string): Promise<Outcome> => {
      try {
        const r = await actInRoom({ kind: "session", userId }, fixtureId, { kind: "draw", accept: false }, deps({ play: realPlay, reconcile: vi.fn() }));
        if (r.ok) return "accepted";
        if (!r.reconcile) return `grant:${r.reason}`;
        throw new Error(`a Lichess refusal from a stub that never refuses: ${r.reason}`);
      } catch (err) {
        if ((err as { status?: number }).status === 404) return "404";
        throw err;
      }
    };
    let rows = 0;
    let acceptedWithCanAct = 0;
    let refusedWithoutCanAct = 0;
    let otherAccountSeen = 0;
    let grantNamed = 0;
    for (const c of bridges) {
      for (const account of accounts) {
        const s = await seed();
        await gameOnFile(s, c.bridge);
        await c.after?.(s);
        await changeAccount(s.home.userId, account); // home is White (gameOnFile's default)
        const linkedAsRecorded = account === "as recorded" || account === "grant downgraded";
        for (const [seat, who] of [["white", s.home], ["black", s.away]] as const) {
          const label = `${c.label} × White ${account} × ${seat}`;
          // The ruling's answer, stated here: the board lets this seat act,
          // and (White only) the account linked is the one the game is on.
          const boardAllows = seat === "white" ? c.white : c.black;
          const accountOk = seat === "black" || linkedAsRecorded;
          const v = await readRoom({ kind: "session", userId: who.userId }, s.fixtureId, deps());
          expect(v.canAct, `${label}: canAct`).toBe(boardAllows && accountOk);
          // The account line names the account T9 RECORDED for White's seat
          // (re-review 6, N-2) — never the one linked now.
          expect(v.otherAccount, `${label}: the account line`).toBe(boardAllows && !accountOk ? s.home.lichessId : null);
          if (seat === "white") {
            expect(v.held, `${label}: held`).toBe(c.held);
            expect(v.game?.clockRunning, `${label}: clocks`).toBe(c.clockRunning);
          }
          const outcome = await outcomeOf(who.userId, s.fixtureId);
          // Direction 1 — the room offers a live board ⇒ T10 takes the act
          // to the board. The one named exception is T2's grant gate, asked
          // per act and answered by name (the room's re-link screen).
          if (v.canAct) {
            expect(outcome, `${label}: canAct ⇒ play accepts`).toBe(account === "grant downgraded" && seat === "white" ? "grant:lichess_reconsent_required" : "accepted");
            if (outcome === "accepted") acceptedWithCanAct += 1;
            else grantNamed += 1;
          }
          // Direction 2 — T10 refuses ⇒ the room said nobody may act; and a
          // room that says no is never accepted.
          if (outcome === "404") {
            expect(v.canAct, `${label}: play refuses ⇒ !canAct`).toBe(false);
            refusedWithoutCanAct += 1;
          }
          if (!v.canAct) expect(outcome, `${label}: !canAct ⇒ never accepted`).not.toBe("accepted");
          if (v.otherAccount !== null) otherAccountSeen += 1;
          rows += 1;
        }
      }
    }
    expect(rows, "anti-vacuity: bridges × accounts × seats").toBe(bridges.length * accounts.length * 2);
    expect(acceptedWithCanAct, "anti-vacuity: accepted acts paired with canAct").toBeGreaterThan(0);
    expect(boardCalls.length, "every accepted act reached the board call").toBe(acceptedWithCanAct);
    expect(refusedWithoutCanAct, "anti-vacuity: play's refusals paired with !canAct").toBeGreaterThan(0);
    expect(grantNamed, "the grant's named answer reached").toBeGreaterThan(0);
    // Only the live board lets White act at all: White re-linked or unlinked there.
    expect(otherAccountSeen, "anti-vacuity: the reviewer's re-linked case and the unlink").toBe(2);
  });

  it("re-review 5 I-2, the reviewer's probe: White re-links ANOTHER Lichess account mid-game ⇒ the room says White may not act (and why), the opponent plays on", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    const before = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect([before.canAct, before.otherAccount], "the pair: as recorded").toEqual([true, null]);
    const relinkedTo = `x-${randomUUID().slice(0, 8)}`;
    await sql`
      update user_external_accounts set external_user_id = ${relinkedTo}, username = ${relinkedTo}
       where user_id = ${s.home.userId} and provider = 'lichess'`;
    const white = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    // Re-review 6, N-2: the line names the account the game IS on — T9's
    // recorded one — never the account linked now.
    expect(s.home.lichessId, "premise: the two accounts differ").not.toBe(relinkedTo);
    expect(white).toMatchObject({ canAct: false, otherAccount: s.home.lichessId, frozen: null, held: false });
    await expect(
      actInRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, { kind: "draw", accept: false }, deps({ reconcile: vi.fn() })),
    ).rejects.toMatchObject({ status: 404 });
    const black = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect(black).toMatchObject({ canAct: true, otherAccount: null });
  });

  it("a hold the game is not playing through (a no-show) is `held`, and no seat is frozen", async () => {
    const s = await seed();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, needs_reason)
      values (${s.fixtureId}, ${s.orgId}, 'needs_organiser', ${T}, 'no_show_both')`;
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(v).toMatchObject({ held: true, frozen: null, game: null, watchUrl: null });
  });

  it("the empty case: no game ⇒ no board, no link, no result", async () => {
    const s = await seed();
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(v).toMatchObject({ game: null, watchUrl: null, result: null, held: false, frozen: null });
  });

  it("the realtime token is minted per read for the CALLER, living past the deadline (T10 carry)", async () => {
    const s = await seed();
    const mint = vi.fn(async () => "rt");
    const late = new Date(T.getTime() + DEADLINE_AFTER_MS + 5 * 60_000);
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    const v = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ now: late, mintRealtime: mint as never }));
    expect(mint).toHaveBeenCalledWith(s.fixtureId, s.home.personId, expect.any(Date));
    const exp = (mint.mock.calls[0] as unknown as [string, string, Date])[2];
    expect(exp.getTime()).toBeGreaterThan(late.getTime());
    expect(v.realtime).toMatchObject({ topic: `external-play:${s.fixtureId}`, token: "rt" });
    expect(roomPhase(late, boardAnchor(T, 0, false))).toBe("closed");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — act and clock-zero trigger reconcile", () => {
  const okMove: PlayResult = { ok: true, applied: true };
  const cases: { label: string; action: Parameters<typeof actInRoom>[2]; answer: PlayResult; reconciles: boolean }[] = [
    { label: "resign ok", action: { kind: "resign" }, answer: okMove, reconciles: true },
    { label: "abort ok", action: { kind: "abort" }, answer: okMove, reconciles: true },
    { label: "draw yes ok", action: { kind: "draw", accept: true }, answer: okMove, reconciles: true },
    { label: "draw no ok", action: { kind: "draw", accept: false }, answer: okMove, reconciles: false },
    { label: "move ok", action: { kind: "move", uci: "e2e4" }, answer: okMove, reconciles: false },
    { label: "move ended", action: { kind: "move", uci: "d8h4" }, answer: { ok: true, applied: true, ended: true }, reconciles: true },
    { label: "resign refused", action: { kind: "resign" }, answer: { ok: false, reconcile: true, reason: "unavailable" }, reconciles: false },
    { label: "move re-link", action: { kind: "move", uci: "e2e4" }, answer: { ok: false, reconcile: false, reason: "lichess_link_required" }, reconciles: false },
  ];

  it("every action × answer: reconcile(game_end) runs exactly when the answer ended the game, and the answer is returned verbatim", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    let checked = 0;
    for (const c of cases) {
      const play = vi.fn(async () => c.answer);
      const rec = vi.fn(async () => null);
      const out = await actInRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, c.action, deps({ play, reconcile: rec }));
      expect(out, c.label).toEqual(c.answer);
      expect(play, c.label).toHaveBeenCalledWith({ fixtureId: s.fixtureId, personId: s.home.personId, action: c.action });
      if (c.reconciles) expect(rec, c.label).toHaveBeenCalledWith(s.fixtureId, "game_end");
      else expect(rec, c.label).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked, "anti-vacuity: action × answer cells").toBe(cases.length);
    expect(cases.filter((c) => c.reconciles).length, "both halves are exercised").toBeGreaterThan(0);
    expect(cases.filter((c) => !c.reconciles).length).toBeGreaterThan(0);
  });

  it("a failing reconcile never fails the player's answer (the resignation stands at Lichess)", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    const out = await actInRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, { kind: "resign" }, deps({
      play: vi.fn(async () => okMove),
      reconcile: vi.fn(async () => {
        throw new Error("lichess down");
      }),
    }));
    expect(out).toEqual(okMove);
  });

  it("a stranger cannot act (404), and the usecase is never reached", async () => {
    const s = await seed();
    const stranger = await makeUser("stranger");
    const play = vi.fn();
    await expect(actInRoom({ kind: "session", userId: stranger.id }, s.fixtureId, { kind: "resign" }, deps({ play: play as never }))).rejects.toMatchObject({ status: 404 });
    expect(play).not.toHaveBeenCalled();
  });

  it("clock-zero: reconcile(clock_zero) runs only when the SERVER's arithmetic puts the side to move within tolerance", async () => {
    const s = await seed();
    const lastMoveAt = new Date(now.getTime() - 30_000);
    // Two plies played: White to move, with 31 s on the clock as of 30 s ago.
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"], whiteMs: 31_000, blackMs: 600_000, lastMoveAt });
    const early = vi.fn(async () => null);
    // 1 s left > tolerance? Only if the tolerance is under a second; pin the boundary from the constant instead.
    const atRemaining = (ms: number) => new Date(lastMoveAt.getTime() + 31_000 - ms);
    expect(
      await reportClockZero({ kind: "session", userId: s.away.userId }, s.fixtureId, deps({ now: atRemaining(CLOCK_ZERO_TOLERANCE_MS + 1), reconcile: early })),
    ).toEqual({ reconciled: false });
    expect(early).not.toHaveBeenCalled();
    const due = vi.fn(async () => null);
    expect(
      await reportClockZero({ kind: "session", userId: s.away.userId }, s.fixtureId, deps({ now: atRemaining(CLOCK_ZERO_TOLERANCE_MS), reconcile: due })),
    ).toEqual({ reconciled: true });
    expect(due).toHaveBeenCalledWith(s.fixtureId, "clock_zero");
  });

  it("m5: one Lichess read per (game, ply) per cooldown — both players reporting at once read once; a client's spaced retry and the next ply read again", async () => {
    // The client spaces its own reports at least CLOCK_ZERO_SPACING_MS apart,
    // so the server's cooldown must be shorter than that, or it would swallow
    // a retry — the next read is how a flag Lichess settles late is seen.
    expect(CLOCK_ZERO_COOLDOWN_MS).toBeGreaterThan(0);
    expect(CLOCK_ZERO_COOLDOWN_MS).toBeLessThan(CLOCK_ZERO_SPACING_MS);
    const s = await seed();
    const lastMoveAt = new Date(now.getTime() - 60_000);
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"], whiteMs: 10_000, blackMs: 600_000, lastMoveAt });
    const rec = vi.fn(async () => null);
    const at = (ms: number) => deps({ now: new Date(now.getTime() + ms), reconcile: rec });
    const report = (who: { userId: string }, ms: number) => reportClockZero({ kind: "session", userId: who.userId }, s.fixtureId, at(ms));
    expect(await report(s.home, 0)).toEqual({ reconciled: true });
    expect(await report(s.away, 0), "the opponent's report a moment later").toEqual({ reconciled: false });
    expect(await report(s.home, CLOCK_ZERO_COOLDOWN_MS - 1), "inside the cooldown").toEqual({ reconciled: false });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(await report(s.home, CLOCK_ZERO_COOLDOWN_MS), "at the cooldown's end").toEqual({ reconciled: true });
    expect(rec).toHaveBeenCalledTimes(2);
    // A new ply of the SAME game is a new clock: no cooldown carried over,
    // even a millisecond after the last read.
    await sql`
      update fixture_external_play
         set moves_uci = ${sql.json(["e2e4", "e7e5", "g1f3"] as never)}, move_count = 3, white_ms = 600000, black_ms = 10000
       where fixture_id = ${s.fixtureId}`;
    expect(await report(s.away, CLOCK_ZERO_COOLDOWN_MS + 1)).toEqual({ reconciled: true });
    expect(rec).toHaveBeenCalledTimes(3);
  });

  it("D11: a report while the (game, ply)'s read is still out never starts a second read — the settling read holds ~9 s; once it answers, or fails, the next report reads", async () => {
    const s = await seed();
    const lastMoveAt = new Date(now.getTime() - 60_000);
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"], whiteMs: 10_000, blackMs: 600_000, lastMoveAt });
    let release!: () => void;
    let calls = 0;
    const rec = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((r) => (release = r));
      if (calls === 2) throw new Error("lichess down");
      return null;
    });
    const report = (who: { userId: string }, ms: number) =>
      reportClockZero({ kind: "session", userId: who.userId }, s.fixtureId, deps({ now: new Date(now.getTime() + ms), reconcile: rec }));
    const first = report(s.home, 0);
    await vi.waitFor(() => expect(rec).toHaveBeenCalledTimes(1));
    // Past the cooldown, from either player — the first read is still out.
    expect(await report(s.home, CLOCK_ZERO_COOLDOWN_MS + 500), "the reporter's own spaced retry").toEqual({ reconciled: false });
    expect(await report(s.away, CLOCK_ZERO_COOLDOWN_MS * 2 + 1), "the opponent's").toEqual({ reconciled: false });
    expect(rec).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ reconciled: true });
    // Answered: the next report past the cooldown reads again — and a read that FAILS frees the (game, ply) too.
    await expect(report(s.home, CLOCK_ZERO_COOLDOWN_MS * 4)).rejects.toThrow("lichess down");
    expect(await report(s.home, CLOCK_ZERO_COOLDOWN_MS * 6)).toEqual({ reconciled: true });
    expect(rec).toHaveBeenCalledTimes(3);
  });

  it("clock-zero before the clocks run (ply < 2) or with no game asks nothing of Lichess", async () => {
    const s = await seed();
    const rec = vi.fn(async () => null);
    expect(await reportClockZero({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ reconcile: rec }))).toEqual({ reconciled: false });
    await gameOnFile(s, { status: "live", moves: ["e2e4"], whiteMs: 0, blackMs: 0, lastMoveAt: new Date(now.getTime() - 3_600_000) });
    expect(await reportClockZero({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ reconcile: rec }))).toEqual({ reconciled: false });
    expect(rec).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room - the opponent's camera pill (D16, §5.6.3: the opponent's OWN report, relayed; each player is in a meeting of their own)", () => {
  type Report = { state: "live" | "off"; at: Date } | null;
  /** The instant a report made `agoMs` before the room's `now`. */
  const reportAt = (state: "live" | "off", agoMs: number): Report => ({ state, at: new Date(now.getTime() - agoMs) });
  /** A camera board, both players in a meeting of their own as preflight leaves them, each with the report given (default:
   *  home reports live a second ago, away reports off a second ago - so a viewer who read the WRONG seat's row reads the wrong word). */
  async function cameraBoard(
    bridge: Parameters<typeof gameOnFile>[1] | null = { status: "live", moves: ["e2e4", "e7e5"] },
    policy: "required" | "optional" = "required",
    reports: { home?: Report; away?: Report } = {},
  ) {
    const s = await seed({ cameraPolicy: policy });
    if (bridge) await gameOnFile(s, bridge);
    const meetings = {
      home: await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "home" }),
      away: await putVideoMeeting({ fixtureId: s.fixtureId, orgId: s.orgId, side: "away" }),
    };
    const part = {
      home: await putVideoParticipant({ fixtureId: s.fixtureId, side: "home", personId: s.home.personId }, { report: reports.home === undefined ? reportAt("live", 1_000) : reports.home }),
      away: await putVideoParticipant({ fixtureId: s.fixtureId, side: "away", personId: s.away.personId }, { report: reports.away === undefined ? reportAt("off", 1_000) : reports.away }),
    };
    return { s, meetings, meetingId: meetings.home, part };
  }
  const pillFor = async (s: SeedOnlineChessFixtureResult, side: "home" | "away") =>
    (await readRoom({ kind: "session", userId: s[side].userId }, s.fixtureId, deps())).opponentCamera;
  const moves = ["e2e4", "e7e5"];
  const boards: { label: string; bridge: Parameters<typeof gameOnFile>[1] | null; home: boolean; away: boolean }[] = [
    { label: "live", bridge: { status: "live", moves }, home: true, away: true },
    { label: "no game yet", bridge: null, home: false, away: false },
    { label: "provider_error hold", bridge: { status: "needs_organiser", needsReason: "provider_error", moves }, home: false, away: false },
    { label: "finished", bridge: { status: "finished", moves }, home: false, away: false },
    { label: "White (home) frozen", bridge: { status: "needs_organiser", needsReason: "token_revoked", revokedSeat: "white", moves }, home: false, away: true },
  ];

  it("the staleness window is a real window: a lost heartbeat does not blank the pill, and the heartbeat is slower than the window by the spec's margin", () => {
    // §5.6.3: a tab sends about two a minute; one lost beat must not flip the pill, so the window is longer than two beats.
    expect(CAMERA_REPORT_STALE_MS, "more than two heartbeats").toBeGreaterThan(2 * CAMERA_REPORT_HEARTBEAT_MS);
    expect(CAMERA_REPORT_STALE_MS, "and short enough that a closed tab is noticed").toBeLessThanOrEqual(2 * 60_000);
  });

  it("no vendor call on a room read - every board state × both seats, with RealtimeKit fully configured and fetch watched", async () => {
    // Configured, so a vendor call WOULD leave this process if one were made.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-test");
    vi.stubEnv("REALTIMEKIT_API_TOKEN", "rtk-test-token");
    vi.stubEnv("REALTIMEKIT_APP_ID", "app-test");
    vi.stubEnv("REALTIMEKIT_PLAYER_PRESET", "seazn_chess_player");
    vi.stubEnv("REALTIMEKIT_ARBITER_PRESET", "seazn_chess_arbiter");
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // Positive control: this watch DOES see a vendor call when one is made.
      await seatCameraEvidence({ meetingId: "mtg-control", participantId: "pt-control" }).catch(() => null);
      expect(fetchSpy.mock.calls.length, "control: the watch sees RealtimeKit").toBeGreaterThan(0);
      expect(String((fetchSpy.mock.calls[0] as unknown as [string])[0])).toContain("realtime");
      fetchSpy.mockClear();
      let reads = 0;
      for (const b of boards) {
        const { s } = await cameraBoard(b.bridge);
        for (const side of ["home", "away"] as const) {
          await readRoom({ kind: "session", userId: s[side].userId }, s.fixtureId, deps());
          reads += 1;
        }
      }
      expect(reads, "anti-vacuity: reads").toBe(boards.length * 2);
      expect(fetchSpy.mock.calls.length, "no vendor call on any room read").toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("each player reads the OTHER seat's own report - never their own, never the arbiter's - where the pill may show, and nothing where it may not", async () => {
    let checked = 0;
    for (const b of boards) {
      const { s } = await cameraBoard(b.bridge); // home reports live, away reports off
      const sees = { home: await pillFor(s, "home"), away: await pillFor(s, "away") };
      // Home reads AWAY's word (off); away reads HOME's (live): a viewer that read its own row would swap them.
      expect(sees.home, `${b.label} / home`).toBe(b.home ? "off" : null);
      expect(sees.away, `${b.label} / away`).toBe(b.away ? "live" : null);
      checked += 2;
    }
    expect(checked, "anti-vacuity: board × seat").toBe(boards.length * 2);
  });

  it("the six inherited null conditions each hide the pill alone - policy off, a video override, the game over, !canAct, no person on file, an open guard fault - six checked, each against a control that shows it", async () => {
    type Arm = { label: string; build: () => Promise<SeedOnlineChessFixtureResult> };
    const live = { status: "live", moves } as const;
    const ARMS: Arm[] = [
      {
        label: "policy off",
        build: async () => {
          const s = await seed({ cameraPolicy: "off" });
          await gameOnFile(s, live);
          return s;
        },
      },
      {
        label: "a video override",
        build: async () => {
          const { s } = await cameraBoard(live);
          await sql`update fixture_external_play set video_override_at = now() where fixture_id = ${s.fixtureId}`;
          return s;
        },
      },
      { label: "the game over", build: async () => (await cameraBoard({ status: "finished", moves })).s },
      { label: "!canAct (a held board)", build: async () => (await cameraBoard({ status: "needs_organiser", needsReason: "provider_error", moves })).s },
      {
        label: "no person on file for the opponent",
        build: async () => {
          const { s } = await cameraBoard(live);
          await sql`delete from entrant_members where entrant_id = ${s.away.entrantId}`;
          return s;
        },
      },
      {
        label: "an open guard fault on the opponent",
        build: async () => {
          const { s } = await cameraBoard(live);
          await sql`insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at) values (${s.fixtureId}, 'away', ${s.away.personId}, ${now})`;
          return s;
        },
      },
    ];
    let checked = 0;
    for (const arm of ARMS) {
      const control = await cameraBoard(live, "required", { away: reportAt("live", 1_000) });
      expect(await pillFor(control.s, "home"), `${arm.label}: control - the same board without the condition shows the pill`).toBe("live");
      const s = await arm.build();
      expect(await pillFor(s, "home"), arm.label).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: six conditions").toBe(6);
    expect(ARMS.length, "and the list is the six").toBe(6);
  });

  it("each state from the opponent's reports: live, off, and 'unknown' for none, for stale, for no participant on file, and for an ended meeting - never 'off' for a quiet one", async () => {
    type Case = { label: string; reports: { away?: Report }; want: "live" | "off" | "unknown"; setup?: (b: Awaited<ReturnType<typeof cameraBoard>>) => Promise<unknown> };
    const CASES: Case[] = [
      { label: "fresh live", reports: { away: reportAt("live", 1_000) }, want: "live" },
      { label: "fresh off", reports: { away: reportAt("off", 1_000) }, want: "off" },
      { label: "no report yet", reports: { away: null }, want: "unknown" },
      { label: "one ms inside the window", reports: { away: reportAt("live", CAMERA_REPORT_STALE_MS - 1) }, want: "live" },
      { label: "exactly at the window - stale", reports: { away: reportAt("live", CAMERA_REPORT_STALE_MS) }, want: "unknown" },
      { label: "a stale OFF is unknown too, not off", reports: { away: reportAt("off", CAMERA_REPORT_STALE_MS + 1) }, want: "unknown" },
      {
        label: "no participant on file for the opponent",
        reports: {},
        want: "unknown",
        setup: (b) => sql`delete from fixture_video_participants where fixture_id = ${b.s.fixtureId} and side = 'away'`,
      },
      {
        label: "the opponent's meeting has ended",
        reports: { away: reportAt("live", 1_000) },
        want: "unknown",
        setup: (b) => sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${b.s.fixtureId} and side = 'away'`,
      },
    ];
    let checked = 0;
    const wants = new Set<string>();
    for (const c of CASES) {
      const b = await cameraBoard({ status: "live", moves }, "required", c.reports);
      await c.setup?.(b);
      expect(await pillFor(b.s, "home"), c.label).toBe(c.want);
      wants.add(c.want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: cases").toBe(CASES.length);
    expect([...wants].sort(), "all three pill states were produced").toEqual(["live", "off", "unknown"]);
  });

  it("an arbiter's participant and the viewer's OWN row never feed the pill: with the opponent silent and the viewer and an arbiter live, the pill says unknown", async () => {
    const { s } = await cameraBoard({ status: "live", moves }, "required", { home: reportAt("live", 1_000), away: null });
    await putVideoParticipant({ fixtureId: s.fixtureId, side: "away", personId: null, preset: "arbiter" });
    expect(await pillFor(s, "home")).toBe("unknown");
  });

  it("a person with two participant rows on their own side is read through the one rule every other reader uses (the first) - the pill never picks a row of its own", async () => {
    // Same person, a second (older, unreported) participant row on their own side: the rule is storedPlayerParticipant's
    // - the first by created_at - so the answer comes from the SAME row the report was written to.
    const { s, part } = await cameraBoard({ status: "live", moves }, "required", { away: reportAt("live", 1_000) });
    await sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, created_at)
              values (${s.fixtureId}, 'away', ${s.away.personId}, 'player', ${`pt-dup-${randomUUID().slice(0, 6)}`}, now() + interval '1 minute')`;
    expect(part.away).toBeTruthy();
    expect(await pillFor(s, "home"), "the first row decides, as for every other reader").toBe("live");
  });

  it("m6: serverNow is stamped when the snapshot is composed, not when the request began — a slow step does not age it", async () => {
    const { s } = await cameraBoard();
    const SLOW_MS = 400;
    const mintRealtime = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return "rt-token";
    });
    // The real clock (no injected now): what production stamps.
    const d = { ...deps({ mintRealtime: mintRealtime as never }), now: undefined };
    const started = Date.now();
    const snap = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(mintRealtime, "premise: the slow step ran").toHaveBeenCalledTimes(1);
    expect(Date.parse(snap.serverNow) - started).toBeGreaterThanOrEqual(SLOW_MS);
  });

  // T14 re-review 3, I-1 (controller ruling 2026-10-12): when the player's
  // browser cannot refuse a remote stream it leaves the meeting and re-joins,
  // stamping the gap as OUR fault — so job 5 never flags it, and the opponent
  // sees no pill rather than "camera off" while it lasts.
  describe("a guard fault (I-1): our gap, stamped on the server's clock", () => {
    const faultsOf = (fixtureId: string) =>
      sql<{ person_id: string; started_at: Date; ended_at: Date | null }[]>`
        select person_id, started_at, ended_at from fixture_video_guard_faults
         where fixture_id = ${fixtureId} order by started_at, id`;
    const t1 = new Date(now.getTime() + 1_000);
    const t2 = new Date(now.getTime() + 9_000);

    it("start → a second start (a no-op) → end: ONE interval, on the server's clock, each change pinged to the opponent", async () => {
      const { s, part } = await cameraBoard();
      const me = { kind: "session" as const, userId: s.home.userId };
      const d1 = deps({ now: t1 });
      expect(await reportCameraFault(me, s.fixtureId, { state: "start", participantId: part.home }, d1)).toEqual({ open: true });
      expect(d1.publish, "the opponent re-reads").toHaveBeenCalledWith(s.fixtureId);
      const again = deps({ now: t2 });
      expect(await reportCameraFault(me, s.fixtureId, { state: "start", participantId: part.home }, again)).toEqual({ open: true });
      expect(again.publish, "nothing changed: no ping").not.toHaveBeenCalled();
      expect((await faultsOf(s.fixtureId)).map((f) => [f.person_id, f.started_at, f.ended_at])).toEqual([[s.home.personId, t1, null]]);
      const d2 = deps({ now: t2 });
      expect(await reportCameraFault(me, s.fixtureId, { state: "end", participantId: part.home }, d2)).toEqual({ open: false });
      expect(d2.publish).toHaveBeenCalledWith(s.fixtureId);
      expect((await faultsOf(s.fixtureId)).map((f) => [f.started_at, f.ended_at])).toEqual([[t1, t2]]);
      // The empty case: an end with nothing open writes nothing.
      const d3 = deps({ now: t2 });
      expect(await reportCameraFault(me, s.fixtureId, { state: "end", participantId: part.home }, d3)).toEqual({ open: false });
      expect(d3.publish).not.toHaveBeenCalled();
      expect(await faultsOf(s.fixtureId)).toHaveLength(1);
    });

    it("the personal link token stamps its own seat the same way", async () => {
      const { s, part } = await cameraBoard();
      const tok = await tokenFor(s, s.away.personId);
      expect(await reportCameraFault({ kind: "token", token: tok }, s.fixtureId, { state: "start", participantId: part.away }, deps({ now: t1 }))).toEqual({ open: true });
      expect((await faultsOf(s.fixtureId)).map((f) => f.person_id)).toEqual([s.away.personId]);
    });

    it("the opponent's pill: NONE while a fault is open (never 'camera off'), back once it closes — and the faulted player's own pill is untouched", async () => {
      const { s, part } = await cameraBoard();
      const read = (side: "home" | "away") => readRoom({ kind: "session", userId: s[side].userId }, s.fixtureId, deps());
      expect((await read("away")).opponentCamera, "premise: before, the pill - home's own report").toBe("live");
      await reportCameraFault({ kind: "session", userId: s.home.userId }, s.fixtureId, { state: "start", participantId: part.home }, deps({ now: t1 }));
      expect((await read("away")).opponentCamera, "our fault: no pill").toBeNull();
      expect((await read("home")).opponentCamera, "home still sees away's own report").toBe("off");
      await reportCameraFault({ kind: "session", userId: s.home.userId }, s.fixtureId, { state: "end", participantId: part.home }, deps({ now: t2 }));
      expect((await read("away")).opponentCamera, "closed: the pill again").toBe("live");
    });

    it("refused with the room's one 404, nothing written: someone else's seat; a player with no seat in the meeting; a fixture the caller does not play; an ended meeting", async () => {
      let refused = 0;
      const expectRefused = async (p: Promise<unknown>, fixtureId: string, why: string) => {
        await expect(p, why).rejects.toMatchObject({ status: 404 });
        expect(await faultsOf(fixtureId), why).toEqual([]);
        refused += 1;
      };
      const { s, part } = await cameraBoard();
      const home = { kind: "session" as const, userId: s.home.userId };
      await expectRefused(reportCameraFault(home, s.fixtureId, { state: "start", participantId: part.away }, deps()), s.fixtureId, "the opponent's seat");
      await expectRefused(reportCameraFault(home, s.fixtureId, { state: "start", participantId: `pt-${randomUUID()}` }, deps()), s.fixtureId, "a seat that does not exist");

      // The away player never reached the meeting (no participant row).
      const lone = await seed({ cameraPolicy: "required" });
      await gameOnFile(lone, { status: "live", moves });
      await putVideoMeeting({ fixtureId: lone.fixtureId, orgId: lone.orgId, side: "home" });
      const ph = await putVideoParticipant({ fixtureId: lone.fixtureId, side: "home", personId: lone.home.personId, participantId: `ph-${randomUUID()}` });
      await expectRefused(
        reportCameraFault({ kind: "session", userId: lone.away.userId }, lone.fixtureId, { state: "start", participantId: ph }, deps()),
        lone.fixtureId,
        "unseated player naming the seated one",
      );

      // home of ANOTHER board posts to this one.
      const other = await cameraBoard();
      await expectRefused(
        reportCameraFault({ kind: "session", userId: other.s.home.userId }, s.fixtureId, { state: "start", participantId: other.part.home }, deps()),
        s.fixtureId,
        "not a player of this fixture",
      );

      const ended = await cameraBoard();
      await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${ended.s.fixtureId}`;
      await expectRefused(
        reportCameraFault({ kind: "session", userId: ended.s.home.userId }, ended.s.fixtureId, { state: "start", participantId: ended.part.home }, deps()),
        ended.s.fixtureId,
        "the meeting has ended",
      );
      expect(refused, "anti-vacuity: refusals").toBe(5);

      // The positive pair: home's OWN seat on the first board is accepted.
      expect(await reportCameraFault(home, s.fixtureId, { state: "start", participantId: part.home }, deps())).toEqual({ open: true });
    });

    it("a seat taken again (a reload's way back) closes an open fault; a REFUSED seat leaves it open", async () => {
      const { s, part } = await cameraBoard();
      const me = { kind: "session" as const, userId: s.home.userId };
      await reportCameraFault(me, s.fixtureId, { state: "start", participantId: part.home }, deps({ now: t1 }));
      const refusedSeat = vi.fn(async () => ({ seated: false as const, reason: "camera_lost" as const, participant: { participantId: part.home, authToken: "x" } }));
      await claimRoomSeat(me, s.fixtureId, deps({ now: t2, seat: refusedSeat as never }));
      expect(refusedSeat, "premise: the seat was asked").toHaveBeenCalled();
      expect((await faultsOf(s.fixtureId)).map((f) => f.ended_at), "refused: still ours, still open").toEqual([null]);
      const seated = vi.fn(async () => ({ seated: true as const, participant: { participantId: part.home, authToken: "x" } }));
      await claimRoomSeat(me, s.fixtureId, deps({ now: t2, seat: seated as never }));
      expect((await faultsOf(s.fixtureId)).map((f) => f.ended_at), "seated: closed at the seat").toEqual([t2]);
    });

    // T14 fix round 6, M-2: a cost bound on a client that stamps without
    // end. Every number below comes from the constants.
    describe("the stamp cap and the ping limit (fix round 6, M-2)", () => {
      const capWarns = (spy: { mock: { calls: unknown[][] } }, fixtureId: string) =>
        spy.mock.calls.filter((c) => (c[0] as { fixtureId?: string } | undefined)?.fixtureId === fixtureId && /cap/.test(String(c[1]))).length;
      /** `n` closed stamps on file for the seat, each a second long, before `now`. */
      async function priorStamps(fixtureId: string, personId: string, n: number, side: "home" | "away" = "home") {
        for (let i = 0; i < n; i += 1) {
          const from = new Date(now.getTime() - (n - i) * 10_000);
          await sql`
            insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at, ended_at)
            values (${fixtureId}, ${side}, ${personId}, ${from}, ${new Date(from.getTime() + 1_000)})`;
        }
      }

      it("the cap leaves room for the organiser to be told first: it is above the told-flag's stamp threshold", () => {
        expect(GUARD_FAULT_MAX_STAMPS).toBeGreaterThan(GUARD_FAULT_FLAG_STAMPS);
      });

      it("CAP-1 on file ⇒ a start opens the CAP-th and logs ONCE; a repeat start is a no-op; the end closes it; the next start is REFUSED (429, named), writes nothing, pings nobody, logs nothing more; the other seat is its own count", async () => {
        const warns = vi.spyOn(log, "warn");
        try {
          const { s, part } = await cameraBoard();
          const me = { kind: "session" as const, userId: s.home.userId };
          await priorStamps(s.fixtureId, s.home.personId, GUARD_FAULT_MAX_STAMPS - 1);
          expect(await faultsOf(s.fixtureId), "premise").toHaveLength(GUARD_FAULT_MAX_STAMPS - 1);

          const d1 = deps({ now: t1 });
          expect(await reportCameraFault(me, s.fixtureId, { state: "start", participantId: part.home }, d1)).toEqual({ open: true });
          expect(d1.publish).toHaveBeenCalledWith(s.fixtureId);
          expect(await faultsOf(s.fixtureId)).toHaveLength(GUARD_FAULT_MAX_STAMPS);
          expect(capWarns(warns, s.fixtureId), "the CAP-th stamp: logged once").toBe(1);
          expect(warns.mock.calls.find((c) => (c[0] as { fixtureId?: string }).fixtureId === s.fixtureId)?.[0]).toMatchObject({
            fixtureId: s.fixtureId,
            personId: s.home.personId,
            stamps: GUARD_FAULT_MAX_STAMPS,
          });

          const again = deps({ now: t1 });
          expect(await reportCameraFault(me, s.fixtureId, { state: "start", participantId: part.home }, again), "open already: a no-op, not a refusal").toEqual({ open: true });
          expect(again.publish).not.toHaveBeenCalled();

          const d2 = deps({ now: t2 });
          expect(await reportCameraFault(me, s.fixtureId, { state: "end", participantId: part.home }, d2), "an end is always allowed").toEqual({ open: false });
          expect(d2.publish).toHaveBeenCalledWith(s.fixtureId);

          const d3 = deps({ now: t2 });
          await expect(reportCameraFault(me, s.fixtureId, { state: "start", participantId: part.home }, d3)).rejects.toMatchObject({
            status: 429,
            code: "CAMERA_FAULT_CAP_REACHED",
          });
          expect(await faultsOf(s.fixtureId), "refused: nothing written").toHaveLength(GUARD_FAULT_MAX_STAMPS);
          expect((await faultsOf(s.fixtureId)).filter((f) => f.ended_at === null), "and nothing left open").toEqual([]);
          expect(d3.publish, "refused: nobody pinged").not.toHaveBeenCalled();
          expect(capWarns(warns, s.fixtureId), "logged once, not per refusal").toBe(1);
          // An end past the cap, with nothing open: fine, and silent.
          const d4 = deps({ now: t2 });
          expect(await reportCameraFault(me, s.fixtureId, { state: "end", participantId: part.home }, d4)).toEqual({ open: false });
          expect(d4.publish).not.toHaveBeenCalled();

          // The pair: the opponent's seat, same fixture, is not capped by home's stamps.
          const d5 = deps({ now: t2 });
          expect(await reportCameraFault({ kind: "session", userId: s.away.userId }, s.fixtureId, { state: "start", participantId: part.away }, d5)).toEqual({ open: true });
          expect(d5.publish).toHaveBeenCalledWith(s.fixtureId);
          expect(capWarns(warns, s.fixtureId), "away's first stamp is no cap").toBe(1);
        } finally {
          warns.mockRestore();
        }
      });

      it("the empty case and one under: zero on file ⇒ opened, no cap log; CAP-2 on file ⇒ opened (the CAP-1-th), no cap log", async () => {
        const warns = vi.spyOn(log, "warn");
        try {
          let checked = 0;
          for (const prior of [0, GUARD_FAULT_MAX_STAMPS - 2]) {
            const { s, part } = await cameraBoard();
            await priorStamps(s.fixtureId, s.home.personId, prior);
            const d = deps({ now: t1 });
            expect(await reportCameraFault({ kind: "session", userId: s.home.userId }, s.fixtureId, { state: "start", participantId: part.home }, d)).toEqual({ open: true });
            expect(await faultsOf(s.fixtureId)).toHaveLength(prior + 1);
            expect(capWarns(warns, s.fixtureId), `${prior} on file: no cap log`).toBe(0);
            checked += 1;
          }
          expect(checked).toBe(2);
        } finally {
          warns.mockRestore();
        }
      });

      it("the ping is rate-limited per seat: past the limit in its window the stamp is still written and the ping skipped; the other seat pings on its own budget", async () => {
        const counts = new Map<string, number>();
        __setRateLimitCounterForTests(async (key) => {
          const n = (counts.get(key) ?? 0) + 1;
          counts.set(key, n);
          return { count: n, ttlMs: CAMERA_FAULT_PING_LIMIT.windowSeconds * 1000 };
        });
        try {
          const { s, part } = await cameraBoard();
          const me = { kind: "session" as const, userId: s.home.userId };
          const changes = CAMERA_FAULT_PING_LIMIT.max + 2;
          expect(Math.ceil(changes / 2), "premise: the starts stay under the cap").toBeLessThan(GUARD_FAULT_MAX_STAMPS);
          let pinged = 0;
          for (let i = 0; i < changes; i += 1) {
            const d = deps({ now: new Date(t1.getTime() + i * 1_000) });
            const state = i % 2 === 0 ? "start" : "end";
            expect(await reportCameraFault(me, s.fixtureId, { state, participantId: part.home }, d)).toEqual({ open: state === "start" });
            pinged += d.publish.mock.calls.length;
          }
          expect(pinged, "pinged up to the limit, then skipped").toBe(CAMERA_FAULT_PING_LIMIT.max);
          expect(await faultsOf(s.fixtureId), "every start was still stamped").toHaveLength(Math.ceil(changes / 2));
          expect([...counts.keys()].filter((k) => k.includes(s.fixtureId) && k.includes(s.home.personId)), "one bucket, keyed per fixture and seat").toHaveLength(1);
          // A no-op (nothing changed) spends no budget.
          const before = [...counts.values()].reduce((a, b) => a + b, 0);
          await reportCameraFault(me, s.fixtureId, { state: changes % 2 === 0 ? "end" : "start", participantId: part.home }, deps({ now: t2 }));
          // (an end with none open, or a start with one open)
          expect([...counts.values()].reduce((a, b) => a + b, 0), "no change: no ping, no count").toBe(before);
          const da = deps({ now: t2 });
          await reportCameraFault({ kind: "session", userId: s.away.userId }, s.fixtureId, { state: "start", participantId: part.away }, da);
          expect(da.publish, "away's own budget").toHaveBeenCalledWith(s.fixtureId);
        } finally {
          __setRateLimitCounterForTests(null);
        }
      });
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — a broken game row (review N2: one error per board, not one per poll)", () => {
  /** A live board whose game carries no recorded colours — SQL damage, as in
   *  play's guard test: T9 writes them in the same update as the game id. */
  async function brokenBoard() {
    const s = await seed();
    const gameId = await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    await sql`update fixture_external_play set white_side = null where fixture_id = ${s.fixtureId}`;
    return { s, gameId };
  }
  const brokenLogs = (spy: { mock: { calls: unknown[][] } }, fixtureId: string) =>
    spy.mock.calls.filter((c) => (c[0] as { fixtureId?: string } | undefined)?.fixtureId === fixtureId && /no recorded colours/.test(String(c[1]))).length;

  it("many polls by both players log the board ONCE; a second broken board logs its own once; every read stays in the true state — nobody may act", async () => {
    const errors = vi.spyOn(log, "error");
    try {
      const a = await brokenBoard();
      const b = await brokenBoard();
      let reads = 0;
      for (let i = 0; i < 4; i += 1) {
        for (const side of ["home", "away"] as const) {
          const snap = await readRoom({ kind: "session", userId: a.s[side].userId }, a.s.fixtureId, deps());
          expect(snap.canAct, `read ${i} / ${side}: nobody may act on a broken row`).toBe(false);
          expect(snap.opponentCamera).toBeNull();
          reads += 1;
        }
      }
      expect(reads, "anti-vacuity: polls").toBe(8);
      expect(brokenLogs(errors, a.s.fixtureId), "one error for the board, not one per poll").toBe(1);
      expect(brokenLogs(errors, b.s.fixtureId), "premise: the second board not read yet").toBe(0);
      const snapB = await readRoom({ kind: "session", userId: b.s.home.userId }, b.s.fixtureId, deps());
      await readRoom({ kind: "session", userId: b.s.away.userId }, b.s.fixtureId, deps());
      expect(snapB.canAct).toBe(false);
      expect(brokenLogs(errors, b.s.fixtureId), "the dedupe is per board, not per process").toBe(1);
      expect(errors.mock.calls.find((c) => (c[0] as { fixtureId?: string }).fixtureId === b.s.fixtureId)?.[0]).toMatchObject({
        fixtureId: b.s.fixtureId,
        gameId: b.gameId,
      });
    } finally {
      errors.mockRestore();
    }
  });
});

// Final review P10: the room asks Lichess, once per page load, whether the VIEWER's grant still plays — so a grant
// narrowed or revoked at lichess.org shows the re-link screen at once, not after a spent act. The page asks; this is
// the usecase it asks.
describe.skipIf(!process.env.DATABASE_URL)("room — Lichess's word on the viewer's grant (P10)", () => {
  it("asks for the VIEWER's own user, by session and by room link alike, and answers what Lichess said", async () => {
    let checked = 0;
    for (const answer of [true, false]) {
      const s = await seed();
      await gameOnFile(s, { status: "live", moves: ["e2e4"] });
      const viewers = [
        { identity: { kind: "session" as const, userId: s.home.userId }, userId: s.home.userId },
        { identity: { kind: "token" as const, token: await tokenFor(s, s.away.personId) }, userId: s.away.userId },
      ];
      for (const v of viewers) {
        const asked: (string | null)[] = [];
        const grantDowngraded = async (userId: string | null) => (asked.push(userId), answer);
        expect(await roomGrantDowngraded(v.identity, s.fixtureId, deps({ grantDowngraded })), v.identity.kind).toBe(answer);
        expect(asked, v.identity.kind).toEqual([v.userId]);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });

  it("before the game too (the check-in): the grant is asked — the create would spend it", async () => {
    const s = await seed();
    const asked: (string | null)[] = [];
    expect(await roomGrantDowngraded({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ grantDowngraded: async (u) => (asked.push(u), true) }))).toBe(true);
    expect(asked).toEqual([s.home.userId]);
  });

  it("nothing left to play — the bridge closed, or the board decided — answers false and asks nobody", async () => {
    let checked = 0;
    for (const close of [
      async (s: SeedOnlineChessFixtureResult) => void (await gameOnFile(s, { status: "finished", moves: ["e2e4", "e7e5"] })),
      // Labelled SQL: the board's result is the subject's input, not under test (the room suites drive the writers).
      async (s: SeedOnlineChessFixtureResult) => void (await sql`update fixtures set status = 'decided' where id = ${s.fixtureId}`),
    ]) {
      const s = await seed();
      await close(s);
      const asked: (string | null)[] = [];
      expect(await roomGrantDowngraded({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ grantDowngraded: async (u) => (asked.push(u), true) }))).toBe(false);
      expect(asked).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("someone not on the board is the room's own 404, and nothing is asked", async () => {
    const s = await seed();
    const stranger = await makeUser("p10-stranger");
    const asked: (string | null)[] = [];
    const err = await roomGrantDowngraded({ kind: "session", userId: stranger.id }, s.fixtureId, deps({ grantDowngraded: async (u) => (asked.push(u), true) })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 404 });
    expect(asked).toEqual([]);
  });

  it("by default it is Lichess itself that is asked (through the fixture): the viewer whose grant was narrowed there reads true, the other false", async () => {
    const fx = await startLichessFixtureServer(0);
    try {
      vi.stubEnv("LICHESS_BASE_URL", fx.url);
      const s = await seed();
      await gameOnFile(s, { status: "live", moves: ["e2e4"] });
      // The seed's linked players hold `lio_seed_<lichess id>` (seedPlayer).
      for (const side of [s.home, s.away]) fx.registerToken(`lio_seed_${side.lichessId}`, side.lichessId);
      fx.setTokenScopes(`lio_seed_${s.home.lichessId}`, ["challenge:read"]);
      const read = (userId: string) => roomGrantDowngraded({ kind: "session", userId }, s.fixtureId, deps());
      expect([await read(s.home.userId), await read(s.away.userId)]).toEqual([true, false]);
      expect(fx.calls.filter((c) => c.path === "/api/token/test")).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      await fx.close();
    }
  });
});

// Fix round 4b: the organiser unpairs a round and re-pairs it — minutes, in real use — and a player's room polls on
// through the gap. Every read inside it finds a board that names nobody; it must be told so (409 ROOM_BEING_REPAIRED,
// and the room reads on), never the room's one 404 (which stops it for good). The answer is given only where it can
// name nobody — a board whose WHOLE round is unpaired — and only to a caller tied to the board without a seat on it.
describe.skipIf(!process.env.DATABASE_URL)("match room — a board being re-paired (fix round 4b)", () => {
  /** What Unpair leaves (stages.ts clearSwissFixtureSeats, the whole round at once); the e2e drives the real one. */
  async function unpair(s: SeedOnlineChessFixtureResult) {
    await sql`delete from fixture_external_play where fixture_id = ${s.fixtureId}`;
    await sql`
      update fixtures set home_entrant_id = null, away_entrant_id = null, status = 'scheduled', outcome = null,
             home_slot_label = null, away_slot_label = null
       where id = ${s.fixtureId}`;
  }
  async function repair(s: SeedOnlineChessFixtureResult) {
    await sql`update fixtures set home_entrant_id = ${s.home.entrantId}, away_entrant_id = ${s.away.entrantId} where id = ${s.fixtureId}`;
  }
  const REPAIRING = { status: 409, code: "ROOM_BEING_REPAIRED" };
  const GONE = { status: 404, code: "NOT_FOUND" };

  it("the round names nobody: its players — by link and by session, a second time too — are told the board is being re-paired, on the read and on the seat, and nothing is written; re-paired, the read is the room again", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.home.personId);
    expect((await readRoom({ kind: "token", token }, s.fixtureId, deps())).you.name, "premise — the link reads the room").toBe("Ada Okonkwo");
    await unpair(s);
    const before = await rows(s.fixtureId);
    await expect(readRoom({ kind: "token", token }, s.fixtureId, deps())).rejects.toMatchObject(REPAIRING);
    await expect(readRoom({ kind: "token", token }, s.fixtureId, deps()), "a second read, the same").rejects.toMatchObject(REPAIRING);
    await expect(readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps())).rejects.toMatchObject(REPAIRING);
    const d = deps();
    await expect(claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, d), "the seat too").rejects.toMatchObject(REPAIRING);
    await expect(claimRoomSeat({ kind: "token", token }, s.fixtureId, d)).rejects.toMatchObject(REPAIRING);
    expect(await rows(s.fixtureId), "nothing written in the gap").toEqual(before);
    expect([d.create.mock.calls.length, d.publish.mock.calls.length], "nothing asked").toEqual([0, 0]);

    await repair(s);
    expect((await readRoom({ kind: "token", token }, s.fixtureId, deps())).you.name, "re-paired: the room").toBe("Ada Okonkwo");
    expect((await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps())).you.name).toBe("Bo Lind");
  });

  it("m2: an Unpair that lands INSIDE the seat call — between its first two reads of the board, or after the seat, before its last — is the 409 too: the room reads on, never the 404 that stops it", async () => {
    const stagings: [string, (s: SeedOnlineChessFixtureResult, staged: () => void) => Partial<RoomDeps>][] = [
      [
        "between the first two reads (around the stale-bridge reset)",
        (s, staged) => {
          gate.reset = async () => {
            gate.reset = null;
            staged();
            await unpair(s);
          };
          return {};
        },
      ],
      [
        "after the seat, before the answer's own read",
        (s, staged) => ({
          seat: async (...a: Parameters<typeof seatPlayer>) => {
            const seat = await seatPlayer(...a);
            staged();
            await unpair(s);
            return seat;
          },
        }),
      ],
    ];
    let checked = 0;
    for (const [why, stage] of stagings) {
      const s = await seed();
      const token = await tokenFor(s, s.home.personId);
      let staged = 0;
      const d = deps(stage(s, () => (staged += 1)));
      try {
        await expect(claimRoomSeat({ kind: "token", token }, s.fixtureId, d), why).rejects.toMatchObject(REPAIRING);
      } finally {
        gate.reset = null;
      }
      expect(staged, `${why}: anti-vacuity — the Unpair landed`).toBe(1);
      expect(d.create.mock.calls.length, `${why}: no game asked for`).toBe(0);
      checked += 1;
    }
    expect(checked, "anti-vacuity: stagings").toBe(2);
  });

  it("never told to anyone the board is not tied to — a stranger, a player of another division, a link for another board, another round's open, or expired: the room's one 404, as before", async () => {
    const s = await seed();
    const other = await seed();
    const otherOpen = await openOf(other);
    const tokens = {
      fixture: await tokenFor(s, s.home.personId, { fixtureId: other.fixtureId }),
      open: await tokenFor(s, s.home.personId, { roundOpenId: otherOpen.id }),
      expired: await tokenFor(s, s.home.personId, { roundOpenedAt: new Date("2000-01-01T00:00:00Z") }),
    };
    const stranger = await makeUser("r4b-stranger");
    await unpair(s);
    // The positive the refusals pair with: the board's own player, by each identity, is told.
    await expect(readRoom({ kind: "token", token: await tokenFor(s, s.home.personId) }, s.fixtureId, deps())).rejects.toMatchObject(REPAIRING);
    await expect(readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).rejects.toMatchObject(REPAIRING);
    const cases: [string, RoomIdentity][] = [
      ["a stranger's session", { kind: "session", userId: stranger.id }],
      ["a player of ANOTHER division", { kind: "session", userId: other.home.userId }],
      ["a link for another board", { kind: "token", token: tokens.fixture }],
      ["a link for another round's open", { kind: "token", token: tokens.open }],
      ["an expired link", { kind: "token", token: tokens.expired }],
    ];
    let checked = 0;
    for (const [why, identity] of cases) {
      await expect(readRoom(identity, s.fixtureId, deps()), why).rejects.toMatchObject(GONE);
      checked += 1;
    }
    expect(checked, "anti-vacuity: callers refused").toBe(5);
  });

  it("only while the WHOLE round names nobody: re-paired with this board left empty (its players seated elsewhere), the board's own link is the 404 — the room stops, as it should", async () => {
    const s = await seed();
    const token = await tokenFor(s, s.home.personId);
    await unpair(s);
    await expect(readRoom({ kind: "token", token }, s.fixtureId, deps()), "premise — mid re-pair").rejects.toMatchObject(REPAIRING);
    // Generate seats the round again — both players on board 2, board 1 left empty.
    const [{ divisionId, orgId, scheduledAt }] = await sql<{ divisionId: string; orgId: string; scheduledAt: Date }[]>`
      select division_id as "divisionId", org_id as "orgId", scheduled_at as "scheduledAt" from fixtures where id = ${s.fixtureId}`;
    const [board2] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${s.stageId}, ${divisionId}, ${orgId}, 1, 2, ${`r4b-${randomUUID().slice(0, 6)}`}, 'scheduled', ${s.home.entrantId}, ${s.away.entrantId}, ${scheduledAt})
      returning id`;
    await expect(readRoom({ kind: "token", token }, s.fixtureId, deps())).rejects.toMatchObject(GONE);
    await expect(readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).rejects.toMatchObject(GONE);
    expect((await readRoom({ kind: "session", userId: s.home.userId }, board2!.id, deps())).you.name, "their board now").toBe("Ada Okonkwo");
  });

  it("a board gone or no longer online play is the 404 even mid re-pair: deleted, cancelled, finalized, online play off, not a board game, its division back in setup, a clock Lichess cannot play, or a round never opened — loadOnlinePlayFixture's whole rule, from its one home (m1)", async () => {
    const changes: [string, (s: SeedOnlineChessFixtureResult) => Promise<unknown>][] = [
      ["deleted", (s) => sql`delete from fixtures where id = ${s.fixtureId}`],
      ["cancelled", (s) => sql`update fixtures set status = 'cancelled' where id = ${s.fixtureId}`],
      ["finalized", (s) => sql`update fixtures set status = 'finalized' where id = ${s.fixtureId}`],
      // Pre-gate legacy data (external-play-guard.test.ts): the settings save refuses a delay clock since T6.
      ["a delay clock", (s) => sql`update divisions set config = jsonb_set(config, '{clock}', '{"base":900,"increment":0,"delay":5}'::jsonb) where id = ${s.divisionId}`],
      ["online play off", (s) => sql`update divisions set config = config || '{"onlinePlay":"off"}'::jsonb where id = ${s.divisionId}`],
      ["not a board game", (s) => sql`update divisions set sport_key = 'badminton' where id = ${s.divisionId}`],
      ["division back in setup", (s) => sql`update divisions set status = 'setup' where id = ${s.divisionId}`],
      ["no open", (s) => sql`delete from stage_round_opens where stage_id = ${s.stageId}`],
    ];
    let checked = 0;
    for (const [why, change] of changes) {
      const s = await seed();
      await unpair(s);
      const who: RoomIdentity = { kind: "session", userId: s.home.userId };
      await expect(readRoom(who, s.fixtureId, deps()), `${why}: premise — mid re-pair`).rejects.toMatchObject(REPAIRING);
      await change(s);
      await expect(readRoom(who, s.fixtureId, deps()), why).rejects.toMatchObject(GONE);
      checked += 1;
    }
    expect(checked, "anti-vacuity: endings").toBe(8);
  });
});

// T17B fix 2, D10 (owner-reported live on stg, fixture 0a45d044): the organiser's "No result" on a board with no game
// yet (resolve: core.abandon, the bridge closed `finished`), then its VOID on the board's match page. The fixture is
// playable again, but create-game only ever claims a `pending` bridge, so no game will ever come — and both rooms said
// "Setting up your game on Lichess" for good. A bridge our side closed, with no game on file and no result, is a board
// the organiser closed: the room says so (`boardClosed`), never "setting up". A Swiss re-pair deletes that row (M-10),
// and the re-paired board is invited afresh: the room must pick that up.
describe.skipIf(!process.env.DATABASE_URL)("match room — a board the organiser closed before any game (T17B fix 2, D10)", () => {
  async function bothIn(s: SeedOnlineChessFixtureResult) {
    const d = deps();
    await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    const second = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, d);
    expect(second.snapshot.creation, "premise: both in, the room says the game is being set up").toEqual({ state: "creating" });
    expect(second.snapshot.boardClosed, "the empty case: an open board is not closed").toBe(false);
    // The board's bridge row, as the round's invite or T9's create mints it before its claim (the real writer).
    await ensureBridgeRow((await loadOnlinePlayFixture(s.fixtureId))!);
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).boardClosed, "a pending row is not closed").toBe(false);
    const [b] = await sql<{ status: string; challenge_id: string | null }[]>`
      select status, challenge_id from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(b, "premise: a bridge with no game").toEqual({ status: "pending", challenge_id: null });
  }
  const lastEvent = async (fixtureId: string) =>
    (await sql<{ id: string; seq: number; type: string }[]>`
      select id, seq, type from score_events where fixture_id = ${fixtureId} order by seq desc limit 1`)[0]!;
  async function voidLast(s: SeedOnlineChessFixtureResult) {
    const last = await lastEvent(s.fixtureId);
    // The organiser's undo on the board's match page (fixture console / pad): the real scoring usecase.
    await scoreEvent(await mintOrgOwnerAuth(s.orgId), s.fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
  }
  const closedSources: [string, (s: SeedOnlineChessFixtureResult) => Promise<void>][] = [
    [
      "the arbiter's No result (the measured case)",
      async (s) => {
        expect(await resolveExternalPlay(await mintOrgOwnerAuth(s.orgId), s.fixtureId, "no_result")).toEqual({ status: "finished" });
      },
    ],
    [
      "a result entered on the pad, the bridge closed by the sweep's first job",
      async (s) => {
        const auth = await mintOrgOwnerAuth(s.orgId);
        await scoreEvent(auth, s.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
        await scoreEvent(auth, s.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: s.home.entrantId, method: "resign" } });
        expect(await closeBridgeIfUnplayable(s.fixtureId, new Date()), "premise: job 1 closed the bridge").toBe(true);
      },
    ],
  ];

  it("closed before any game, then voided: both rooms say the board is closed — never 'setting up' — whatever closed it (counted)", async () => {
    let checked = 0;
    for (const [why, close] of closedSources) {
      const s = await seed();
      await bothIn(s);
      await close(s);
      const [b] = await sql<{ status: string; challenge_id: string | null }[]>`
        select status, challenge_id from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(b, `${why}: premise — closed, no game`).toEqual({ status: "finished", challenge_id: null });
      await voidLast(s);
      const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
      expect(["scheduled", "in_play"], `${why}: premise — the void made the board playable again`).toContain(fx!.status);
      for (const who of [s.home, s.away]) {
        const snap = await readRoom({ kind: "session", userId: who.userId }, s.fixtureId, deps());
        expect({ boardClosed: snap.boardClosed, creation: snap.creation, game: snap.game, result: snap.result }, `${why}: ${who.userId}`).toEqual({
          boardClosed: true,
          creation: null,
          game: null,
          result: null,
        });
        checked++;
      }
    }
    expect(checked, "anti-vacuity: both players, every source").toBe(closedSources.length * 2);
  });

  it("before the void the board reads as its result (No result), not closed — the abandon outranks it", async () => {
    const s = await seed();
    await bothIn(s);
    await closedSources[0]![1](s);
    const snap = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect([snap.result?.outcome, snap.boardClosed, snap.creation]).toEqual(["no_result", false, null]);
  });

  it("the pair: a bridge closed WITH a game on file is never a closed board — the game is what the room shows (over, or its board)", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "finished", moves: ["e2e4", "e7e5"] });
    const snap = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect([snap.boardClosed, snap.creation, snap.game?.gameId !== undefined]).toEqual([false, null, true]);
  });

  it("the re-open path: a Swiss re-pair deletes the closed row (M-10) — the re-paired board reads open again, and the next seat asks for its game", async () => {
    const s = await seed();
    await bothIn(s);
    await closedSources[0]![1](s);
    await voidLast(s);
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).boardClosed, "premise: closed").toBe(true);
    // What Unpair then Pair leave (stages.ts clearSwissFixtureSeats deletes a finished, game-less row; the re-pair
    // seats the board again) — as the fix-round-4b suite above stands for it.
    await sql`delete from fixture_external_play where fixture_id = ${s.fixtureId}`;
    const snap = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect([snap.boardClosed, snap.creation], "open again: no closed card").toEqual([false, { state: "creating" }]);
    const d = deps();
    await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(d.create, "the re-paired board is asked for its game").toHaveBeenCalledTimes(1);
    // T9's create mints the fresh row before its claim (the real writer; the create itself is this suite's stub).
    await ensureBridgeRow((await loadOnlinePlayFixture(s.fixtureId))!);
    const [b] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(b!.status, "a fresh bridge").toBe("pending");
    const fresh = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect([fresh.boardClosed, fresh.creation], "the room follows the new bridge").toEqual([false, { state: "creating" }]);
  });
});

// ─── Timed check-in batches in the room (spec §3.2.1; capacity tests 6 [reader:compose] [reader:checkin-counts] [reader:claim], 8, 9, 11's server half) ───
// Every instant below is OPENED + batch x CHECKIN_BATCH_GAP_MS (+ DEADLINE_AFTER_MS), written from the constants and never
// read back from windowFor. The seed stores `staggered`, as the open does; the camera policy stays `off`, so the real seat
// seats without a vendor and the window is the only thing under test.
describe.skipIf(!process.env.DATABASE_URL)("match room — timed batches", () => {
  const OPENED = new Date("2026-10-01T12:00:00.000Z");
  const startOf = (batch: number) => new Date(OPENED.getTime() + batch * CHECKIN_BATCH_GAP_MS);
  const opensOf = (batch: number) => (batch === 0 ? new Date(OPENED.getTime() - WINDOW_OPEN_LEAD_MS) : startOf(batch));
  const closesOf = (batch: number) => new Date(startOf(batch).getTime() + DEADLINE_AFTER_MS);
  /** [batch, rank]: the first board of batch 0 and the first of batch 2. */
  const BATCHES: [number, number][] = [
    [0, 0],
    [2, 2 * CHECKIN_BATCH_SIZE],
  ];
  const seedAt = (rank: number) =>
    seed({ roundOpenedAt: OPENED, staggered: true, rank, scheduledAt: new Date(OPENED.getTime() + 10 * 60_000) });
  const view = (s: SeedOnlineChessFixtureResult, at: Date) =>
    readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ now: at }));

  it("[reader:compose] the room of batch 0 and of batch 2 reads its OWN window: opensAt, deadline, and the phase either side of each edge", async () => {
    let checked = 0;
    for (const [batch, rank] of BATCHES) {
      const s = await seedAt(rank);
      const v = await view(s, opensOf(batch));
      expect(v.opensAt, `batch ${batch} opensAt`).toBe(opensOf(batch).toISOString());
      expect(v.deadline, `batch ${batch} deadline`).toBe(closesOf(batch).toISOString());
      expect(v.roundOpenedAt, "the round's own stamp rides along unchanged").toBe(OPENED.toISOString());
      expect((await view(s, new Date(opensOf(batch).getTime() - 1))).phase, `batch ${batch}, 1 ms before it opens`).toBe("before");
      expect((await view(s, opensOf(batch))).phase, `batch ${batch}, at its opening`).toBe("open");
      expect((await view(s, new Date(closesOf(batch).getTime() - 1))).phase, `batch ${batch}, 1 ms before its deadline`).toBe("open");
      expect((await view(s, closesOf(batch))).phase, `batch ${batch}, at its deadline`).toBe("closed");
      checked += 1;
    }
    expect(checked, "anti-vacuity: batches read").toBe(BATCHES.length);
  });

  it("[reader:checkin-counts] a check-in counts only inside ITS board's window: a batch-2 stamp placed in batch 0's window does not count for it", async () => {
    let checked = 0;
    for (const [batch, rank] of BATCHES) {
      const s = await seedAt(rank);
      await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
      const stampAt = async (at: Date) => {
        await sql`update fixture_availability set checked_in_at = ${at} where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
        return (await view(s, opensOf(batch))).you.checkedIn;
      };
      expect(await stampAt(new Date(opensOf(batch).getTime() - 1)), `batch ${batch}: a stamp 1 ms before the window`).toBe(false);
      expect(await stampAt(opensOf(batch)), `batch ${batch}: a stamp at its opening`).toBe(true);
      expect(await stampAt(new Date(closesOf(batch).getTime() - 1)), `batch ${batch}: a stamp 1 ms before the deadline`).toBe(true);
      expect(await stampAt(closesOf(batch)), `batch ${batch}: a stamp at the deadline`).toBe(false);
      checked += 1;
    }
    // The differential: the SAME instant (the first millisecond of batch 0's window) counts for batch 0 and not for batch 2.
    const inBatch0 = opensOf(0);
    const counts: boolean[] = [];
    for (const [, rank] of BATCHES) {
      const s = await seedAt(rank);
      await stampFixtureCheckIn(s.home.personId, s.fixtureId, s.orgId);
      await sql`update fixture_availability set checked_in_at = ${inBatch0} where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
      counts.push((await view(s, inBatch0)).you.checkedIn);
    }
    expect(counts, "one instant, two boards: counted for batch 0, not for batch 2").toEqual([true, false]);
    expect(checked, "anti-vacuity").toBe(BATCHES.length);
  });

  it("[reader:claim] and test 8: a claim before the board's batch opens is refused `checkin_not_open`, stamps nothing, publishes nothing, creates nothing; at the opening it seats", async () => {
    const s = await seedAt(2 * CHECKIN_BATCH_SIZE);
    const early = deps({ now: new Date(opensOf(2).getTime() - 1) });
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, early);
    expect(c.seat).toEqual({ seated: false, reason: "checkin_not_open", participant: null });
    expect(c.snapshot.phase, "the answer's own snapshot agrees with the refusal").toBe("before");
    expect((await rows(s.fixtureId)).availability, "no check-in").toEqual([]);
    expect(early.publish).not.toHaveBeenCalled();
    expect(early.create).not.toHaveBeenCalled();
    const open = deps({ now: opensOf(2) });
    const seated = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, open);
    expect(seated.seat?.seated, "the same claim at the opening").toBe(true);
    expect((await rows(s.fixtureId)).availability.length, "the check-in is written").toBe(1);
  });

  it("test 9: arriving DEADLINE_AFTER_MS - 1 min after the batch opened seats, and the game is asked for when the SECOND side is seated - no clock penalty", async () => {
    // The check-in stamp is the database's own now() (stampFixtureCheckIn), so the round is opened relative to the REAL clock
    // for the stamps to count; the claims' `now` is injected, the way the sweep and the other suites move time.
    const GAP = CHECKIN_BATCH_GAP_MS;
    const opened = new Date(Date.now() - 2 * GAP - 60_000);
    const start = new Date(opened.getTime() + 2 * GAP);
    const s = await seed({ roundOpenedAt: opened, staggered: true, rank: 2 * CHECKIN_BATCH_SIZE, scheduledAt: opened });
    const first = deps({ now: new Date(start.getTime() + 1_000) });
    expect((await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, first)).seat?.seated).toBe(true);
    expect(first.create, "one side in: nothing to ask for yet").not.toHaveBeenCalled();
    const late = deps({ now: new Date(start.getTime() + DEADLINE_AFTER_MS - 60_000) });
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, late);
    expect(c.seat?.seated, "seated, a minute before the deadline").toBe(true);
    expect(late.create, "the game is asked for when the second side is seated").toHaveBeenCalledTimes(1);
  });

  it("test 9 (boundary pair): at the deadline exactly the claim is window_closed - nothing stamped; one ms before it is seated", async () => {
    const GAP = CHECKIN_BATCH_GAP_MS;
    const opened = new Date(Date.now() - 2 * GAP - 60_000);
    const start = new Date(opened.getTime() + 2 * GAP);
    const s = await seed({ roundOpenedAt: opened, staggered: true, rank: 2 * CHECKIN_BATCH_SIZE, scheduledAt: opened });
    const deadline = new Date(start.getTime() + DEADLINE_AFTER_MS);
    const closed = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, deps({ now: deadline }));
    expect(closed.seat).toEqual({ seated: false, reason: "window_closed", participant: null });
    expect((await rows(s.fixtureId)).availability, "a refusal stamps no check-in").toEqual([]);
    const edge = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, deps({ now: new Date(deadline.getTime() - 1) }));
    expect(edge.seat?.seated).toBe(true);
  });

  it("a claim that STARTS inside the window and is seated AFTER the deadline is dated at the instant it was judged open - the check-in counts and the game is asked for (the B-end load run's board that was never created)", async () => {
    // Production passes no clock: the claim's `now` is read once, at its start, and the window judged against it. The seat then takes
    // as long as the vendor takes (here 6 s); the stamp used to be the database's now() AFTER the seat, which lay past the deadline,
    // so a player seated and judged in time read as never having come and the board was never created (it forfeited 234 s later).
    const opened = new Date(Date.now() - DEADLINE_AFTER_MS + 5_000);
    const deadline = new Date(opened.getTime() + DEADLINE_AFTER_MS);
    const s = await seed({ roundOpenedAt: opened, staggered: false, scheduledAt: opened });
    // The other side is in, honestly, a minute before the deadline.
    const away = deps({ now: new Date(deadline.getTime() - 60_000) });
    expect((await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, away)).seat?.seated, "premise: the other side is seated").toBe(true);
    expect(away.create, "premise: one side in, nothing to ask for").not.toHaveBeenCalled();
    const claim = deps({ seat: vi.fn(async () => { await new Promise((r) => setTimeout(r, 6_000)); return { seated: true as const, participant: null }; }) });
    delete (claim as { now?: Date }).now; // the production clock
    expect(Date.now(), "premise: the claim starts before the deadline (a loaded machine fails here, loudly, and is not a pass)").toBeLessThan(deadline.getTime());
    const got = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, claim);
    expect(got.seat?.seated, "seated").toBe(true);
    expect(Date.now(), "premise: the seat came back AFTER the deadline - the case under test").toBeGreaterThan(deadline.getTime());
    const stamped = (await rows(s.fixtureId)).availability.find((a) => a.person_id === s.home.personId);
    expect(stamped?.checked_in_at && new Date(stamped.checked_in_at).getTime(), "dated before the deadline, at the instant it was judged open").toBeLessThan(deadline.getTime());
    expect(claim.create, "both sides count, so the game is asked for").toHaveBeenCalledTimes(1);
  }, 30_000);
});
