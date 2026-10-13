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
import { roomPhase, windowFor, DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { mintMatchRoomToken } from "../match-room-token";
import { stampFixtureCheckIn } from "../me";
import { act, type PlayResult } from "../external-play/play";
import { fenAfter } from "@/server/external-play/fen";
import { holdRefusedNoShow, writeResultFrom } from "../external-play/result";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { resolveExternalPlay } from "../external-play/resolve";
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
  type RoomDeps,
} from "../external-play/room";
import { hasLiveVideoPublisher } from "@/server/external-play/video/realtimekit";
import { GUARD_FAULT_MAX_STAMPS } from "@/server/external-play/video/guard-faults";
import { GUARD_FAULT_FLAG_STAMPS } from "@/server/external-play/video/match-camera-off";
import { CAMERA_FAULT_PING_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { log } from "@/server/logger";
import { makeUser } from "./_seed";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

// `stampFixtureCheckIn` stamps the DB's own now() (real wall clock) and
// `checkInCounts` judges THAT stamp against the open's window, so the open is
// anchored to the real clock: T five minutes ahead, the window T-10..T+20.
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
  over: Partial<{ status: string; whiteSide: "home" | "away"; moves: string[]; needsReason: string; revokedSeat: string; whiteMs: number; blackMs: number; lastMoveAt: Date }> = {},
) {
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  const whiteSide = over.whiteSide ?? "home";
  const white = whiteSide === "home" ? s.home : s.away;
  const black = whiteSide === "home" ? s.away : s.home;
  const moves = over.moves ?? [];
  await sql`
    insert into fixture_external_play
      (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
       moves_uci, move_count, last_move_at, white_ms, black_ms, needs_reason, revoked_seat)
    values (${s.fixtureId}, ${s.orgId}, ${over.status ?? "ready"}, ${T}, ${gameId}, ${whiteSide}, ${white.lichessId},
            ${black.lichessId}, ${sql.json(moves as never)}, ${moves.length}, ${over.lastMoveAt ?? (moves.length ? now : null)},
            ${over.whiteMs ?? null}, ${over.blackMs ?? null}, ${over.needsReason ?? null}, ${over.revokedSeat ?? null})
    on conflict (fixture_id) do update set status = excluded.status, challenge_id = excluded.challenge_id,
      white_side = excluded.white_side, white_lichess_id = excluded.white_lichess_id, black_lichess_id = excluded.black_lichess_id,
      moves_uci = excluded.moves_uci, move_count = excluded.move_count, last_move_at = excluded.last_move_at,
      white_ms = excluded.white_ms, black_ms = excluded.black_ms, needs_reason = excluded.needs_reason,
      revoked_seat = excluded.revoked_seat`;
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
    const w = windowFor(T);
    const open = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(open).toMatchObject({ phase: "open", opensAt: w.opensAt.toISOString(), deadline: w.deadline.toISOString() });
    const closed = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ now: w.deadline }));
    expect(closed.phase).toBe("closed");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — taking the seat", () => {
  it("before the window: refused round_not_open, nothing stamped, nothing published", async () => {
    const s = await seed();
    const early = new Date(T.getTime() - 11 * 60_000);
    const d = deps({ now: early });
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(c.seat).toEqual({ seated: false, reason: "round_not_open", participant: null });
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
    expect(seat).toHaveBeenCalledWith({ fixtureId: s.fixtureId, personId: s.home.personId }, { now });
    expect((await rows(s.fixtureId)).availability, "a refused seat is not a check-in").toEqual([]);
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

  it("T11 M7: a token_revoked hold freezes ONE seat — its player reads `you`, the opponent `opponent` and keeps a live board and the watch link", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "needs_organiser", needsReason: "token_revoked", revokedSeat: "white", moves: ["e2e4", "e7e5"] });
    const white = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    const black = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect(white.frozen).toBe("you");
    expect(black.frozen).toBe("opponent");
    expect(black.held, "the opponent's board is not held").toBe(false);
    expect(black.game?.over).toBe(false);
    expect(black.watchUrl, "a held board still moving keeps its link").not.toBeNull();
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
    expect(roomPhase(late, T)).toBe("closed");
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
    // The client spaces its own reports CLOCK_ZERO_SPACING_MS apart (and a
    // flag settles on Lichess's NEXT read), so the server's cooldown must be
    // shorter than that spacing, or it would swallow the retry that settles it.
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

  it("clock-zero before the clocks run (ply < 2) or with no game asks nothing of Lichess", async () => {
    const s = await seed();
    const rec = vi.fn(async () => null);
    expect(await reportClockZero({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ reconcile: rec }))).toEqual({ reconciled: false });
    await gameOnFile(s, { status: "live", moves: ["e2e4"], whiteMs: 0, blackMs: 0, lastMoveAt: new Date(now.getTime() - 3_600_000) });
    expect(await reportClockZero({ kind: "session", userId: s.home.userId }, s.fixtureId, deps({ reconcile: rec }))).toEqual({ reconciled: false });
    expect(rec).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("match room — the opponent's presence (review I8: the player's own meeting join answers it; the server only says who)", () => {
  /** A camera-required board, both players in the meeting as preflight
   *  leaves them. */
  async function cameraBoard(bridge: Parameters<typeof gameOnFile>[1] | null = { status: "live", moves: ["e2e4", "e7e5"] }, policy: "required" | "optional" = "required") {
    const s = await seed({ cameraPolicy: policy });
    if (bridge) await gameOnFile(s, bridge);
    const meetingId = `mtg-${randomUUID()}`;
    await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${s.fixtureId}, ${s.orgId}, ${meetingId})`;
    const part = { home: `pt-home-${randomUUID().slice(0, 8)}`, away: `pt-away-${randomUUID().slice(0, 8)}` };
    await sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${s.fixtureId}, ${s.home.personId}, 'player', ${part.home}),
             (${s.fixtureId}, ${s.away.personId}, 'player', ${part.away})`;
    return { s, meetingId, part };
  }
  const moves = ["e2e4", "e7e5"];
  const boards: { label: string; bridge: Parameters<typeof gameOnFile>[1] | null; home: boolean; away: boolean }[] = [
    { label: "live", bridge: { status: "live", moves }, home: true, away: true },
    { label: "no game yet", bridge: null, home: false, away: false },
    { label: "provider_error hold", bridge: { status: "needs_organiser", needsReason: "provider_error", moves }, home: false, away: false },
    { label: "finished", bridge: { status: "finished", moves }, home: false, away: false },
    { label: "White (home) frozen", bridge: { status: "needs_organiser", needsReason: "token_revoked", revokedSeat: "white", moves }, home: false, away: true },
  ];

  it("no vendor call on a room read — every board state × both seats, with RealtimeKit fully configured and fetch watched", async () => {
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
      await hasLiveVideoPublisher({ meetingId: "mtg-control", participantId: "pt-control" }).catch(() => null);
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

  it("the opponent's participant id is sent only where the pill may show — the live board; never before the game, on a held or finished board, or to a frozen seat (whose opponent still gets it); each player gets the OTHER seat", async () => {
    let checked = 0;
    for (const b of boards) {
      const { s, part } = await cameraBoard(b.bridge);
      for (const side of ["home", "away"] as const) {
        const other = side === "home" ? "away" : "home";
        const snap = await readRoom({ kind: "session", userId: s[side].userId }, s.fixtureId, deps());
        expect(snap.opponentPresence, `${b.label} / ${side}`).toEqual(b[side] ? { participantId: part[other] } : null);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: board × seat").toBe(boards.length * 2);
  });

  it("the edges: policy off ⇒ no pill; optional ⇒ the pill; an opponent with no seat in the meeting, or an ended meeting ⇒ absent (participantId null), never someone else's id", async () => {
    const off = await seed({ cameraPolicy: "off" });
    await gameOnFile(off, { status: "live", moves });
    expect((await readRoom({ kind: "session", userId: off.home.userId }, off.fixtureId, deps())).opponentPresence).toBeNull();

    const opt = await cameraBoard({ status: "live", moves }, "optional");
    expect((await readRoom({ kind: "session", userId: opt.s.home.userId }, opt.s.fixtureId, deps())).opponentPresence).toEqual({
      participantId: opt.part.away,
    });

    // The away player never reached the meeting; an arbiter did.
    const s = await seed({ cameraPolicy: "required" });
    await gameOnFile(s, { status: "live", moves });
    await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${s.fixtureId}, ${s.orgId}, ${`mtg-${randomUUID()}`})`;
    await sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${s.fixtureId}, ${s.home.personId}, 'player', ${`ph-${randomUUID()}`}),
             (${s.fixtureId}, null, 'arbiter', ${`arb-${randomUUID()}`})`;
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps())).opponentPresence).toEqual({ participantId: null });

    const ended = await cameraBoard();
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${ended.s.fixtureId}`;
    expect((await readRoom({ kind: "session", userId: ended.s.home.userId }, ended.s.fixtureId, deps())).opponentPresence).toEqual({
      participantId: null,
    });
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
      expect((await read("away")).opponentPresence, "premise: before, the pill").toEqual({ participantId: part.home });
      await reportCameraFault({ kind: "session", userId: s.home.userId }, s.fixtureId, { state: "start", participantId: part.home }, deps({ now: t1 }));
      expect((await read("away")).opponentPresence, "our fault: no pill").toBeNull();
      expect((await read("home")).opponentPresence, "home still sees away").toEqual({ participantId: part.away });
      await reportCameraFault({ kind: "session", userId: s.home.userId }, s.fixtureId, { state: "end", participantId: part.home }, deps({ now: t2 }));
      expect((await read("away")).opponentPresence, "closed: the pill again").toEqual({ participantId: part.home });
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
      await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${lone.fixtureId}, ${lone.orgId}, ${`mtg-${randomUUID()}`})`;
      const ph = `ph-${randomUUID()}`;
      await sql`insert into fixture_video_participants (fixture_id, person_id, preset, participant_id) values (${lone.fixtureId}, ${lone.home.personId}, 'player', ${ph})`;
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
      async function priorStamps(fixtureId: string, personId: string, n: number) {
        for (let i = 0; i < n; i += 1) {
          const from = new Date(now.getTime() - (n - i) * 10_000);
          await sql`
            insert into fixture_video_guard_faults (fixture_id, person_id, started_at, ended_at)
            values (${fixtureId}, ${personId}, ${from}, ${new Date(from.getTime() + 1_000)})`;
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
          expect(snap.opponentPresence).toBeNull();
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
