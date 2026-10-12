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
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { roomPhase, windowFor, DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { mintMatchRoomToken } from "../match-room-token";
import { stampFixtureCheckIn } from "../me";
import { fenAfter, type PlayResult } from "../external-play/play";
import { writeResultFrom } from "../external-play/result";
import { appendEvent } from "@/server/engine-db";
import type { GameSnapshot } from "@/server/external-play/types";
import { CLOCK_ZERO_SPACING_MS } from "@/components/public-site/match-room/use-room";
import {
  CLOCK_ZERO_COOLDOWN_MS,
  CLOCK_ZERO_TOLERANCE_MS,
  actInRoom,
  claimRoomSeat,
  readRoom,
  reportClockZero,
  type RoomDeps,
} from "../external-play/room";
import { presenceCache, PRESENCE_TTL_MS } from "../external-play/room-presence";
import { RealtimeKitError } from "@/server/external-play/video/realtimekit";
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

  it("I7: a double forfeit on the ledger reads as NO RESULT, 0–0, for both players — never a draw", async () => {
    const s = await seed();
    await gameOnFile(s, { status: "live", moves: ["e2e4", "e7e5"] });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, { type: "boardgame.result", payload: { winner: null, method: "double_forfeit" } });
    const [fx] = await sql<{ status: string; outcome: { kind: string } | null }[]>`select status, outcome from fixtures where id = ${s.fixtureId}`;
    expect(fx!.outcome, "premise: the engine folded it to no_result").toEqual({ kind: "no_result" });
    let checked = 0;
    for (const who of [s.home, s.away]) {
      const snap = await readRoom({ kind: "session", userId: who.userId }, s.fixtureId, deps());
      expect(snap.result).toEqual({ outcome: "no_result", method: "double_forfeit", score: "0–0" });
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("I2: who may act is play.ts's own predicate — and every board the room says nobody may act on, T10 refuses (404)", async () => {
    type Case = {
      label: string;
      bridge: Parameters<typeof gameOnFile>[1];
      // Ruling M7 (T11): a token_revoked hold freezes only the revoked seat;
      // every other hold and a finished board accept nothing (T10 play.ts).
      white: boolean;
      black: boolean;
      held: boolean;
      clockRunning: boolean;
    };
    const moves = ["e2e4", "e7e5"];
    const cases: Case[] = [
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
    ];
    let checked = 0;
    let refusedByPlay = 0;
    for (const c of cases) {
      const s = await seed();
      await gameOnFile(s, c.bridge);
      const white = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
      const black = await readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
      expect([white.canAct, black.canAct], c.label).toEqual([c.white, c.black]);
      expect(white.held, `${c.label}: held`).toBe(c.held);
      expect(white.game?.clockRunning, `${c.label}: clocks`).toBe(c.clockRunning);
      // The other authority agrees: where the room says no, T10's real act
      // refuses before any grant, token or Lichess call.
      for (const [who, v] of [[s.home, white], [s.away, black]] as const) {
        if (v.canAct) continue;
        await expect(
          actInRoom({ kind: "session", userId: who.userId }, s.fixtureId, { kind: "draw", accept: false }, deps({ reconcile: vi.fn() })),
          `${c.label}: T10 refuses`,
        ).rejects.toMatchObject({ status: 404 });
        refusedByPlay += 1;
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every bridge state").toBe(cases.length);
    expect(refusedByPlay, "anti-vacuity: refusals paired with T10").toBe(9);
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

describe.skipIf(!process.env.DATABASE_URL)("match room — the opponent's presence (review I8: vendor calls do not scale with reads)", () => {
  /** A camera-required board with a live game and both players in the
   *  meeting, as preflight leaves them. */
  async function cameraBoard(bridge: Parameters<typeof gameOnFile>[1] = { status: "live", moves: ["e2e4", "e7e5"] }) {
    const s = await seed({ cameraPolicy: "required" });
    await gameOnFile(s, bridge);
    const meetingId = `mtg-${randomUUID()}`;
    await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${s.fixtureId}, ${s.orgId}, ${meetingId})`;
    const part = { home: `pt-home-${randomUUID().slice(0, 8)}`, away: `pt-away-${randomUUID().slice(0, 8)}` };
    await sql`
      insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
      values (${s.fixtureId}, ${s.home.personId}, 'player', ${part.home}),
             (${s.fixtureId}, ${s.away.personId}, 'player', ${part.away})`;
    return { s, meetingId, part };
  }

  it("N concurrent reads make ONE vendor call per seat asked about; more reads inside the TTL make none; the TTL's end asks again", async () => {
    const { s, meetingId, part } = await cameraBoard();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const presence = vi.fn(async () => {
      await gate;
      return true;
    });
    const d = deps({ presence, presenceCache: presenceCache() });
    const N = 12;
    const home = Array.from({ length: N }, () => readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d));
    const away = Array.from({ length: N }, () => readRoom({ kind: "session", userId: s.away.userId }, s.fixtureId, d));
    await vi.waitFor(() => expect(presence).toHaveBeenCalledTimes(2));
    release();
    const snaps = await Promise.all([...home, ...away]);
    expect(snaps.length, "anti-vacuity: reads").toBe(2 * N);
    expect(snaps.every((x) => x.opponentCameraLive === true)).toBe(true);
    expect(presence, `${2 * N} reads, one call per seat`).toHaveBeenCalledTimes(2);
    // Each player asks about the OTHER seat.
    expect(presence.mock.calls.map((c) => (c as unknown as [{ meetingId: string; participantId: string }])[0])).toEqual(
      expect.arrayContaining([
        { meetingId, participantId: part.away },
        { meetingId, participantId: part.home },
      ]),
    );
    for (let i = 0; i < 5; i += 1) await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(presence, "inside the TTL: no call").toHaveBeenCalledTimes(2);
    await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, { ...d, now: new Date(now.getTime() + PRESENCE_TTL_MS) });
    expect(presence, "the TTL's end asks again").toHaveBeenCalledTimes(3);
  });

  it("asked only where the pill shows — the live board; never before the game, on a held or finished board, or for a frozen seat (whose opponent still asks)", async () => {
    const moves = ["e2e4", "e7e5"];
    const cases: { label: string; bridge: Parameters<typeof gameOnFile>[1] | null; home: boolean; away: boolean }[] = [
      { label: "live", bridge: { status: "live", moves }, home: true, away: true },
      { label: "no game yet", bridge: null, home: false, away: false },
      { label: "provider_error hold", bridge: { status: "needs_organiser", needsReason: "provider_error", moves }, home: false, away: false },
      { label: "finished", bridge: { status: "finished", moves }, home: false, away: false },
      { label: "White (home) frozen", bridge: { status: "needs_organiser", needsReason: "token_revoked", revokedSeat: "white", moves }, home: false, away: true },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seed({ cameraPolicy: "required" });
      if (c.bridge) await gameOnFile(s, c.bridge);
      await sql`insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${s.fixtureId}, ${s.orgId}, ${`mtg-${randomUUID()}`})`;
      await sql`
        insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
        values (${s.fixtureId}, ${s.home.personId}, 'player', ${`ph-${randomUUID()}`}),
               (${s.fixtureId}, ${s.away.personId}, 'player', ${`pa-${randomUUID()}`})`;
      for (const side of ["home", "away"] as const) {
        const presence = vi.fn(async () => true);
        const snap = await readRoom({ kind: "session", userId: s[side].userId }, s.fixtureId, deps({ presence, presenceCache: presenceCache() }));
        expect(presence.mock.calls.length, `${c.label} / ${side}: calls`).toBe(c[side] ? 1 : 0);
        expect(snap.opponentCameraLive, `${c.label} / ${side}`).toBe(c[side] ? true : null);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: board × seat").toBe(cases.length * 2);
  });

  it("m6: serverNow is stamped when the snapshot is composed, not when the request began — a slow vendor answer does not age it", async () => {
    const { s } = await cameraBoard();
    const SLOW_MS = 400;
    const presence = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return true;
    });
    // The real clock (no injected now): what production stamps.
    const d = { ...deps({ presence, presenceCache: presenceCache() }), now: undefined };
    const started = Date.now();
    const snap = await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d);
    expect(presence, "premise: the slow call was made").toHaveBeenCalledTimes(1);
    expect(Date.parse(snap.serverNow) - started).toBeGreaterThanOrEqual(SLOW_MS);
  });

  it("the vendor not answering is unknown (null) — and is not asked again inside the TTL", async () => {
    const { s } = await cameraBoard();
    const presence = vi.fn(async () => {
      throw new RealtimeKitError(502, "unavailable", "vendor down");
    });
    const d = deps({ presence, presenceCache: presenceCache() });
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d)).opponentCameraLive).toBeNull();
    expect((await readRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, d)).opponentCameraLive).toBeNull();
    expect(presence).toHaveBeenCalledTimes(1);
  });
});
