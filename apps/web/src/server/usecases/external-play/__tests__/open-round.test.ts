// T19 — the organiser opens a round (D12). Nothing seats and no game is
// created until this stamps `stage_round_opens` and sends the invites.
//
// Single-sport by construction for everything but the sport sweep: online
// play exists only for `boardgame` (`supportsOnlinePlay`), so every other
// sport is a refusal, swept once below over the engine's own registry.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";

// The email seam: the real `send` no-ops without RESEND_API_KEY (vitest.config
// strips it) and would report every invite as failed, so the invite sender is
// replaced. `fail` names recipients whose send the provider refuses.
const mail = vi.hoisted(() => ({
  sent: [] as { to: string; fixtureUrl: string; opponentName: string; roundNo: number }[],
  fail: new Set<string>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(
      async (to: string, args: Parameters<typeof actual.sendExternalPlayInviteEmail>[1]) => {
        if (mail.fail.has(to)) return false;
        mail.sent.push({ to, fixtureUrl: args.fixtureUrl, opponentName: args.opponentName, roundNo: args.roundNo });
        return true;
      },
    ),
  };
});

// T9's Lichess calls, module-mocked exactly as T9's own suite does — only the
// readiness case below reaches them.
const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

// Race staging for the two "the round changed underneath" guards: a hook run
// at the exact point between the unlocked reads and the locked transaction.
const race = vi.hoisted(() => ({
  guardNullFor: null as string | null,
  afterSeats: null as null | (() => Promise<void>),
}));
vi.mock("../guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../guard")>();
  return {
    ...actual,
    loadOnlinePlayFixture: async (id: string) =>
      race.guardNullFor === id ? null : actual.loadOnlinePlayFixture(id),
  };
});
vi.mock("../invite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../invite")>();
  return {
    ...actual,
    boardSeats: async (f: Parameters<typeof actual.boardSeats>[0]) => {
      const seats = await actual.boardSeats(f);
      if (race.afterSeats) {
        const hook = race.afterSeats;
        race.afterSeats = null;
        await hook();
      }
      return seats;
    },
  };
});

import { openRound, roundOpenedAt } from "../open-round";
import { bridgeTakesInvites } from "../invite";
import { seatPlayer } from "../preflight";
import { createGameIfReady } from "../create-game";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { addFixture, generateStageFixtures, unpairSwissRound, createStages } from "../../stages";
import { deleteEntrant } from "../../entrants";
import { patchDivision } from "../../divisions";
import {
  seedOnlineChessRound,
  seedOnlineSwiss,
  seedOwner,
  type SeedOnlineChessRoundResult,
} from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;

beforeEach(() => {
  mail.sent.length = 0;
  mail.fail.clear();
  race.guardNullFor = null;
  race.afterSeats = null;
  vi.clearAllMocks();
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Readers.

async function stampRows(stageId: string, roundNo = 1) {
  return sql<{ id: string; opened_at: Date; opened_by: string }[]>`
    select id, opened_at, opened_by from stage_round_opens where stage_id = ${stageId} and round_no = ${roundNo}`;
}

type BridgeView = {
  round_open_id: string | null;
  white_emailed_at: Date | null;
  black_emailed_at: Date | null;
  status: string;
  challenge_id: string | null;
  create_sent_at: Date | null;
};

async function bridgeOf(fixtureId: string): Promise<BridgeView | null> {
  const [row] = await sql<BridgeView[]>`
    select round_open_id, white_emailed_at, black_emailed_at, status, challenge_id, create_sent_at
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return row ?? null;
}

async function auditTypes(competitionId: string): Promise<string[]> {
  const rows = await sql<{ type: string }[]>`
    select type from competition_events
     where competition_id = ${competitionId} and type like 'external_play.round_%'
     order by created_at, id`;
  return rows.map((r) => r.type);
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string | undefined }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected a refusal, got a resolve");
}

const emailsOf = (r: SeedOnlineChessRoundResult) => r.boards.flatMap((b) => [b.home.email, b.away.email]);
const sentTo = () => mail.sent.map((m) => m.to).sort();
const open = (r: { stageId: string; ownerUserId: string }, roundNo = 1, now?: Date) =>
  openRound({ stageId: r.stageId, roundNo, actorUserId: r.ownerUserId }, now ? { now } : {});

describe.skipIf(!HAS_DB)("openRound — the stamp", () => {
  it("is not open until the organiser opens it, then carries the stamp", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });

    expect(await roundOpenedAt({ stageId: r.stageId, roundNo: 1 })).toBeNull();

    const before = new Date();
    const res = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId });
    // Two seats per board, two boards: a COUNT, so an invite that silently
    // reaches nobody is visible.
    expect(res).toEqual({ opened: true, invited: 4, skipped: [] });

    const at = await roundOpenedAt({ stageId: r.stageId, roundNo: 1 });
    expect(at).toBeInstanceOf(Date);
    expect(at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(sentTo()).toEqual(emailsOf(r).sort());

    // The invite record is the per-seat stamp on a row naming THIS open.
    const [stamp] = await stampRows(r.stageId);
    expect(stamp!.opened_by).toBe(r.ownerUserId);
    for (const b of r.boards) {
      const row = await bridgeOf(b.fixtureId);
      expect(row?.round_open_id).toBe(stamp!.id);
      expect(row?.white_emailed_at).toBeInstanceOf(Date);
      expect(row?.black_emailed_at).toBeInstanceOf(Date);
    }
    // Each invite names the player's own board and opponent.
    for (const b of r.boards) {
      const toHome = mail.sent.find((m) => m.to === b.home.email)!;
      expect(toHome.fixtureUrl).toContain(`/fixtures/${b.fixtureId}`);
      expect(toHome.opponentName).toBe(`P${r.boards.indexOf(b) + 1}B`);
      expect(toHome.roundNo).toBe(1);
    }
    expect(await auditTypes(r.competitionId)).toEqual(["external_play.round_opened"]);
  });

  it("another round and another stage stay unopened — the grain is (stage, round)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const other = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const late = r.spares[0]!;
    await addFixture(r.owner, r.stageId, {
      home_entrant_id: late.home.entrantId,
      away_entrant_id: late.away.entrantId,
      round_no: 2,
      scheduled_at: "2026-10-01T13:10:00.000Z",
    });

    expect(await open(r)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(await roundOpenedAt({ stageId: r.stageId, roundNo: 2 })).toBeNull();
    expect(await roundOpenedAt({ stageId: other.stageId, roundNo: 1 })).toBeNull();
    expect(sentTo()).toEqual(emailsOf(r).sort());

    // Round 2 opens on its own stamp and leaves round 1's alone.
    const r1 = (await stampRows(r.stageId, 1))[0]!;
    expect(await open(r, 2)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect((await stampRows(r.stageId, 2))).toHaveLength(1);
    expect((await stampRows(r.stageId, 1))[0]!.opened_at.getTime()).toBe(r1.opened_at.getTime());
  });
});

describe.skipIf(!HAS_DB)("openRound — idempotent per seat, in BOTH directions", () => {
  it("re-opening sends nothing, but a board added after the open still gets invited", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });

    expect(await open(r)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(mail.sent).toHaveLength(2);
    const first = (await stampRows(r.stageId))[0]!;

    // direction 1: nothing new to do — and no second stamp, no second audit.
    expect(await open(r)).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(mail.sent).toHaveLength(2);
    expect(await stampRows(r.stageId)).toHaveLength(1);

    // direction 2: the organiser adds a match to the already-open round,
    // through the real ad-hoc fixture usecase.
    const late = r.spares[0]!;
    const { fixture_id } = await addFixture(r.owner, r.stageId, {
      home_entrant_id: late.home.entrantId,
      away_entrant_id: late.away.entrantId,
      round_no: 1,
      scheduled_at: "2026-10-01T12:10:00.000Z",
    });
    expect(await open(r)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(mail.sent).toHaveLength(4);
    expect(new Set(mail.sent.map((m) => m.to)).size).toBe(4); // nobody emailed twice
    expect(mail.sent.slice(2).map((m) => m.to).sort()).toEqual([late.home.email, late.away.email].sort());
    expect((await bridgeOf(fixture_id))?.round_open_id).toBe(first.id);

    // A partly invited round keeps its window: the stamp did not move.
    const after = await stampRows(r.stageId);
    expect(after).toHaveLength(1);
    expect(after[0]!.opened_at.getTime()).toBe(first.opened_at.getTime());
    expect(await auditTypes(r.competitionId)).toEqual([
      "external_play.round_opened",
      "external_play.round_reinvited",
    ]);
  });
});

describe.skipIf(!HAS_DB)("openRound — the window (Q2)", () => {
  // Derived from the declared deadline, never a literal: one minute either
  // side of opened_at + DEADLINE_AFTER_MS.
  const lateBoard = async (r: SeedOnlineChessRoundResult) => {
    const late = r.spares[0]!;
    const { fixture_id } = await addFixture(r.owner, r.stageId, {
      home_entrant_id: late.home.entrantId,
      away_entrant_id: late.away.entrantId,
      round_no: 1,
      scheduled_at: "2026-10-01T12:10:00.000Z",
    });
    return { fixtureId: fixture_id, late };
  };

  it("a board added after the round's window closed is NOT invited, is reported per fixture, and no window moves", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const now = new Date();
    const openedAt = new Date(now.getTime() - DEADLINE_AFTER_MS - MIN);
    await open(r, 1, openedAt);
    const { fixtureId } = await lateBoard(r);
    mail.sent.length = 0;

    expect(await open(r, 1, now)).toEqual({
      opened: false,
      reason: "already_open",
      skipped: [{ fixtureId, reason: "window_closed" }],
    });
    expect(mail.sent).toHaveLength(0);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(openedAt.getTime());
    expect(await bridgeOf(fixtureId)).toBeNull(); // nothing attached, nothing stamped
  });

  it("positive pair: the same late board inside the window IS invited, and the window does not move", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const now = new Date();
    const openedAt = new Date(now.getTime() - DEADLINE_AFTER_MS + MIN);
    await open(r, 1, openedAt);
    const { late } = await lateBoard(r);
    mail.sent.length = 0;

    expect(await open(r, 1, now)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(sentTo()).toEqual([late.home.email, late.away.email].sort());
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(openedAt.getTime());
  });
});

describe.skipIf(!HAS_DB)("openRound — stamp before send, un-stamp on a failed send", () => {
  it("a refused send leaves that seat un-invited; the next open retries ONLY it, in the same window", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const b0 = r.boards[0]!;
    mail.fail.add(b0.home.email);

    expect(await open(r)).toEqual({
      opened: true,
      invited: 3,
      skipped: [{ fixtureId: b0.fixtureId, reason: "send_failed" }],
    });
    const row = (await bridgeOf(b0.fixtureId))!;
    const stamped = [row.white_emailed_at, row.black_emailed_at].filter((x) => x !== null);
    expect(stamped, "only the seat whose mail went out is stamped").toHaveLength(1);
    const first = (await stampRows(r.stageId))[0]!;

    mail.fail.clear();
    expect(await open(r)).toEqual({ opened: true, invited: 1, skipped: [] });
    expect(mail.sent.filter((m) => m.to === b0.home.email)).toHaveLength(1);
    expect(new Set(mail.sent.map((m) => m.to)).size).toBe(4);
    expect(mail.sent).toHaveLength(4); // each player exactly once
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(first.opened_at.getTime());
    // The retry kept the board's OTHER seat's record: a third open has nobody
    // left to invite.
    expect(await open(r)).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(mail.sent).toHaveLength(4);
  });

  it("when EVERY send failed, the round holds no invited seat, so the re-open starts a fresh window", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    for (const e of emailsOf(r)) mail.fail.add(e);
    const t0 = new Date(Date.now() - 30 * MIN);
    expect(await open(r, 1, t0)).toEqual({
      opened: true,
      invited: 0,
      skipped: [{ fixtureId: r.boards[0]!.fixtureId, reason: "send_failed" }],
    });
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(t0.getTime());

    mail.fail.clear();
    const t1 = new Date();
    expect(await open(r, 1, t1)).toEqual({ opened: true, invited: 2, skipped: [] });
    const stamps = await stampRows(r.stageId);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.opened_at.getTime(), "fresh window").toBe(t1.getTime());
    expect(await auditTypes(r.competitionId)).toEqual([
      "external_play.round_opened",
      "external_play.round_reopened",
    ]);
  });
});

describe.skipIf(!HAS_DB)("openRound — refusals write nothing, each with its positive pair", () => {
  async function expectNothingWritten(r: SeedOnlineChessRoundResult) {
    expect(await stampRows(r.stageId)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    const rows = await sql`select 1 from fixture_external_play ep join fixtures f on f.id = ep.fixture_id
                            where f.stage_id = ${r.stageId}`;
    expect(rows).toHaveLength(0);
    expect(await auditTypes(r.competitionId)).toEqual([]);
  }

  it("empty case: a round with no fixtures ⇒ no_fixtures", async () => {
    // Round 1 holds a board; round 2 holds none.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    expect(await open(r, 2)).toEqual({ opened: false, reason: "no_fixtures" });
    await expectNothingWritten(r);
    expect(await stampRows(r.stageId, 2)).toHaveLength(0);
  });

  it("a round holding an unpaired slot ⇒ not_paired", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, unpaired: true });
    expect(await open(r)).toEqual({ opened: false, reason: "not_paired" });
    await expectNothingWritten(r);
  });

  it("positive pair: a BYE is not an unpaired slot — the round opens and the bye's player is not invited", async () => {
    // The brief's predicate (any null seat ⇒ not_paired) refused every
    // odd-field Swiss round; a bye is a settled award, not a board.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, bye: true });
    expect(await open(r)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(sentTo()).toEqual(emailsOf(r).sort());
    expect(mail.sent.map((m) => m.to)).not.toContain(r.bye!.side.email);
    expect(await bridgeOf(r.bye!.fixtureId)).toBeNull();
  });

  it("a round of byes alone has nothing to play ⇒ no_fixtures", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 0, bye: true });
    expect(await open(r)).toEqual({ opened: false, reason: "no_fixtures" });
    await expectNothingWritten(r);
  });

  it("boards with no start time ⇒ not_scheduled (the guard serves only scheduled boards)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    expect(await open(r)).toEqual({ opened: false, reason: "not_scheduled" });
    await expectNothingWritten(r);
  });

  it("a division that has not started ⇒ division_not_started", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, divisionStarted: false });
    expect(await open(r)).toEqual({ opened: false, reason: "division_not_started" });
    await expectNothingWritten(r);
  });

  it("addendum 1: a PRE-GATE stored clock ⇒ clock_not_playable, before any stamp or invite", async () => {
    // LEGACY DATA: written by SQL after a valid create, because T6's save gate
    // refuses 1+0 today. An unlocked division that stored it before the gate
    // is never re-checked on save; this is where the organiser learns.
    for (const clock of [{ base: 60, increment: 0 }, { base: 900, increment: 10, delay: 5 }]) {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      await sql`update divisions set config = jsonb_set(config, '{clock}', ${sql.json(clock)}) where id = ${r.divisionId}`;
      expect(await open(r), JSON.stringify(clock)).toEqual({ opened: false, reason: "clock_not_playable" });
      await expectNothingWritten(r);
    }
  });

  it("positive pair: every ship-1 control opens, 10+0 and 15+0 included (owner ruling 2026-10-09)", async () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const r = await seedOnlineChessRound({
        roundNo: 1,
        fixtures: 1,
        clock: { base: tc.limitSeconds, increment: tc.incrementSeconds },
      });
      expect(await open(r), tc.key).toEqual({ opened: true, invited: 2, skipped: [] });
      checked++;
    }
    expect(checked).toBe(SHIP1_TIME_CONTROLS.length);
    expect(SHIP1_TIME_CONTROLS.map((t) => t.key)).toEqual(expect.arrayContaining(["10+0", "15+0"]));
  });

  it("a division not played online ⇒ 422 ROUND_NOT_ONLINE, nothing written", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, onlinePlay: "off" });
    expect(await refusal(open(r))).toEqual({ status: 422, code: "ROUND_NOT_ONLINE" });
    await expectNothingWritten(r);
  });

  it("another sport: every registered sport but boardgame ⇒ 422 ROUND_NOT_ONLINE (registry sweep)", async () => {
    // A non-boardgame division cannot SAVE onlinePlay 'lichess' (the API
    // refuses it), so the state is forced by SQL: the refusal must come from
    // the sport check, not from the config.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    let checked = 0;
    for (const mod of builtinModules) {
      if (mod.key === "boardgame") continue;
      await sql`update divisions set sport_key = ${mod.key} where id = ${r.divisionId}`;
      expect(await refusal(open(r)), mod.key).toEqual({ status: 422, code: "ROUND_NOT_ONLINE" });
      checked++;
    }
    expect(checked).toBe(builtinModules.length - 1);
    expect(checked).toBeGreaterThan(0);
    await expectNothingWritten(r);
  });

  it("an unknown stage ⇒ 404", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    expect(
      await refusal(openRound({ stageId: randomUUID(), roundNo: 1, actorUserId: r.ownerUserId })),
    ).toEqual({ status: 404, code: undefined });
  });
});

describe.skipIf(!HAS_DB)("openRound — authorised FIRST, and an unauthorised caller writes no stamp", () => {
  it("a player of the round is refused 403 and writes nothing", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const player = r.boards[0]!.home.userId;
    expect(await refusal(openRound({ stageId: r.stageId, roundNo: 1, actorUserId: player }))).toEqual({
      status: 403,
      code: "OPEN_ROUND_FORBIDDEN",
    });
    expect(await stampRows(r.stageId)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("another organisation's organiser is refused 403 and writes nothing", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const stranger = await seedOwner();
    expect(await refusal(openRound({ stageId: r.stageId, roundNo: 1, actorUserId: stranger.userId! }))).toEqual({
      status: 403,
      code: "OPEN_ROUND_FORBIDDEN",
    });
    expect(await stampRows(r.stageId)).toHaveLength(0);
  });

  it("a viewer of the organisation is refused; an admin may open (EDITOR_ROLES)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const mk = async (role: "viewer" | "admin") => {
      const [u] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified, locale)
        values (${`${role}-${randomUUID().slice(0, 8)}@t.local`}, ${role}, true, 'en') returning id`;
      await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${u!.id}, ${role})`;
      return u!.id;
    };
    const viewer = await mk("viewer");
    expect(await refusal(openRound({ stageId: r.stageId, roundNo: 1, actorUserId: viewer }))).toEqual({
      status: 403,
      code: "OPEN_ROUND_FORBIDDEN",
    });
    expect(await stampRows(r.stageId)).toHaveLength(0);
    const admin = await mk("admin");
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: admin })).toEqual({
      opened: true,
      invited: 2,
      skipped: [],
    });
    expect((await stampRows(r.stageId))[0]!.opened_by).toBe(admin);
  });
});

describe.skipIf(!HAS_DB)("openRound — the real producer feeds the real consumers", () => {
  it("T8: the same player is round_not_open before the open and seated after it", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    for (const p of [b.home, b.away]) {
      expect(await seatPlayer({ fixtureId: b.fixtureId, personId: p.personId })).toEqual({
        seated: false,
        reason: "round_not_open",
      });
    }
    await open(r);
    for (const p of [b.home, b.away]) {
      // Camera policy off (the competition floor): seated with no video.
      expect(await seatPlayer({ fixtureId: b.fixtureId, personId: p.personId })).toEqual({
        seated: true,
        participant: null,
      });
    }
  });

  it("addendum 4: T9's readiness is not_ready before the open and creates the game after it", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const fixtureId = r.boards[0]!.fixtureId;
    const publish = vi.fn(async () => undefined);
    expect(await createGameIfReady(fixtureId, { publish })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();

    await open(r);
    const out = await createGameIfReady(fixtureId, { publish });
    expect(out.created).toBe(true);
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    const row = await bridgeOf(fixtureId);
    expect(row?.status).toBe("ready");
    // The game sits on the row the open attached: same open, stamps intact.
    expect(row?.round_open_id).toBe((await stampRows(r.stageId))[0]!.id);
    expect(row?.white_emailed_at).toBeInstanceOf(Date);
  });

  it("addendum 2: after a REAL open, a camera-policy upgrade on that division is refused 409 POLICY_LOCKED", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    await open(r);
    expect(await refusal(patchDivision(r.owner, r.divisionId, { camera_policy: "required" }))).toEqual({
      status: 409,
      code: "POLICY_LOCKED",
    });
    const [d] = await sql<{ camera_policy: string | null }[]>`select camera_policy from divisions where id = ${r.divisionId}`;
    expect(d!.camera_policy).toBeNull();
    // ...and relaxing stays allowed after the open (D9).
    await patchDivision(r.owner, r.divisionId, { camera_policy: "off" });
  });

  it("positive pair: before any open, the same upgrade is accepted", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    await patchDivision(r.owner, r.divisionId, { camera_policy: "required" });
    const [d] = await sql<{ camera_policy: string | null }[]>`select camera_policy from divisions where id = ${r.divisionId}`;
    expect(d!.camera_policy).toBe("required");
  });
});

describe("bridgeTakesInvites — which bridge rows an open may invite into", () => {
  // A table, so each clause of the predicate is pinned on its own.
  const pending = { status: "pending", challenge_id: null, create_sent_at: null };
  const cases: [string, Parameters<typeof bridgeTakesInvites>[0], boolean][] = [
    ["no row", null, true],
    ["plain pending row", pending, true],
    ["a recorded game", { ...pending, challenge_id: "gm1" }, false],
    ["a create in flight / outcome unknown", { ...pending, create_sent_at: new Date() }, false],
    ["ready", { ...pending, status: "ready" }, false],
    ["live", { ...pending, status: "live" }, false],
    ["finished", { ...pending, status: "finished" }, false],
    ["held for the organiser", { ...pending, status: "needs_organiser" }, false],
  ];
  it.each(cases)("%s ⇒ %s", (_name, row, want) => {
    expect(bridgeTakesInvites(row)).toBe(want);
  });
  it("covers every status the bridge CHECK declares", async () => {
    if (!HAS_DB) return;
    const [c] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'fixture_external_play_status_check'`;
    const declared = [...c!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    const covered = new Set(cases.map(([, row]) => row?.status).filter(Boolean));
    expect([...covered].sort()).toEqual([...declared].sort());
  });
});

describe.skipIf(!HAS_DB)("openRound — the round changing underneath (assumption guards)", () => {
  it("waits on the division lock every pairing write takes, and sees a re-pair committed while it waited", async () => {
    // Staged, not raced: another session holds the division lock FIRST; the
    // open must be seen WAITING on it (pg_stat_activity) before the holder
    // re-pairs and commits.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const fixtureId = r.boards[0]!.fixtureId;
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      const pending = open(r).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      let waited = false;
      for (let i = 0; i < 100 && !waited; i++) {
        const [w] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        waited = w!.n > 0;
        if (!waited) await new Promise((res) => setTimeout(res, 50));
      }
      expect(waited, "openRound never waited on the division lock").toBe(true);
      await holder`update fixtures set away_entrant_id = ${r.spares[0]!.away.entrantId} where id = ${fixtureId}`;
      await holder`commit`;
      const out = await pending;
      expect(out.ok).toBe(false);
      const err = (out as { e: unknown }).e;
      expect(err instanceof HttpError ? [err.status, err.code] : err).toEqual([409, "ROUND_CHANGED"]);
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
    expect(await stampRows(r.stageId)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("a board the guard no longer serves between the read and the open ⇒ 409 ROUND_CHANGED, nothing written", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    race.guardNullFor = r.boards[1]!.fixtureId;
    expect(await refusal(open(r))).toEqual({ status: 409, code: "ROUND_CHANGED" });
    expect(await stampRows(r.stageId)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("a board whose bridge row names ANOTHER round's open is refused loudly, never read as invited", async () => {
    // Not product-reachable (no path moves a fixture between rounds); forced
    // by SQL to reach the assertion that says so.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    await open(r);
    const late = r.spares[0]!;
    const { fixture_id } = await addFixture(r.owner, r.stageId, {
      home_entrant_id: late.home.entrantId,
      away_entrant_id: late.away.entrantId,
      round_no: 2,
      scheduled_at: "2026-10-01T13:10:00.000Z",
    });
    await open(r, 2);
    await sql`update fixtures set round_no = 1 where id = ${fixture_id}`;
    mail.sent.length = 0;
    await expect(open(r)).rejects.toThrow(/names open .* not this round's/);
    expect(mail.sent).toHaveLength(0);
  });

  // Each clause of the locked re-check, on its own: the board changes after
  // its seats were read and before the lock.
  const changes: [string, (fixtureId: string, spare: string) => Promise<unknown>][] = [
    ["home seat re-paired", (f, e) => sql`update fixtures set home_entrant_id = ${e} where id = ${f}`],
    ["away seat re-paired", (f, e) => sql`update fixtures set away_entrant_id = ${e} where id = ${f}`],
    ["moved to another round", (f) => sql`update fixtures set round_no = 99 where id = ${f}`],
    ["settled (withdrawal)", (f) => sql`update fixtures set status = 'abandoned' where id = ${f}`],
    ["deleted", (f) => sql`delete from fixtures where id = ${f}`],
  ];
  it.each(changes)("a board %s mid-call ⇒ 409 ROUND_CHANGED, nobody mailed", async (_name, change) => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const fixtureId = r.boards[0]!.fixtureId;
    race.afterSeats = async () => {
      await change(fixtureId, r.spares[0]!.away.entrantId);
    };
    expect(await refusal(open(r))).toEqual({ status: 409, code: "ROUND_CHANGED" });
    expect(await stampRows(r.stageId)).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Re-pairing after the open (addendum 5, ruling Q1), through the REAL
// unpair / re-pair calls.

type BoardSeat = { fixtureId: string; home: string; away: string };

async function swissRound1(stageId: string): Promise<BoardSeat[]> {
  return sql<BoardSeat[]>`
    select id as "fixtureId", home_entrant_id as home, away_entrant_id as away
      from fixtures
     where stage_id = ${stageId} and round_no = 1 and status = 'scheduled'
       and home_entrant_id is not null and away_entrant_id is not null
     order by seq_in_round`;
}

const pairKey = (b: BoardSeat) => [b.home, b.away].sort().join("|");

describe.skipIf(!HAS_DB)("openRound — re-pairing after the open", () => {
  it("a full re-pair deletes the old invites with the seats: re-open is a fresh window and everyone is invited", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const emailOf = new Map(s.players.map((p) => [p.entrantId, p.email]));
    const before = await swissRound1(s.stageId);
    expect(before, "premise: 4 players ⇒ 2 boards").toHaveLength(2);
    const t0 = new Date(Date.now() - 30 * MIN);
    expect(await open(s, 1, t0)).toEqual({ opened: true, invited: 4, skipped: [] });

    await unpairSwissRound(s.owner, s.stageId);
    for (const b of before) {
      expect(await bridgeOf(b.fixtureId), "the unpair took the invite with the seats").toBeNull();
    }
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const after = await swissRound1(s.stageId);
    expect(after).toHaveLength(2);
    expect(after.map(pairKey).sort(), "premise: the re-pair produced different pairings").not.toEqual(
      before.map(pairKey).sort(),
    );

    mail.sent.length = 0;
    const t1 = new Date();
    expect(await open(s, 1, t1)).toEqual({ opened: true, invited: 4, skipped: [] });
    const stamps = await stampRows(s.stageId);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.opened_at.getTime(), "a fresh window").toBe(t1.getTime());
    // One invite per player, per board, per pairing: each current seat got
    // exactly one, naming its CURRENT board.
    let checked = 0;
    for (const b of after) {
      for (const e of [b.home, b.away]) {
        const got = mail.sent.filter((m) => m.to === emailOf.get(e));
        expect(got).toHaveLength(1);
        expect(got[0]!.fixtureUrl).toContain(`/fixtures/${b.fixtureId}`);
        checked++;
      }
    }
    expect(checked).toBe(4);
    expect(await auditTypes(s.competitionId)).toEqual([
      "external_play.round_opened",
      "external_play.round_reopened",
    ]);
  });

  it("a board with a GAME survives the unpair untouched; its new occupants are not invited", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    // Opened 30 minutes ago; the game was made inside that window.
    const t0 = new Date(Date.now() - 30 * MIN);
    await open(s, 1, t0);
    const gameBoard = before[0]!.fixtureId;
    expect(
      (await createGameIfReady(gameBoard, { publish: async () => undefined, now: new Date(t0.getTime() + MIN) }))
        .created,
    ).toBe(true);
    const kept = (await bridgeOf(gameBoard))!;
    expect(kept.challenge_id).not.toBeNull();

    await unpairSwissRound(s.owner, s.stageId);
    expect(await bridgeOf(gameBoard), "a game exists — the row is left alone").toEqual(kept);
    expect(await bridgeOf(before[1]!.fixtureId)).toBeNull();

    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const after = await swissRound1(s.stageId);
    mail.sent.length = 0;
    const res = await open(s);
    // Only the game-less board takes invites; it holds none, so the window is
    // fresh — the game board is on neither side of that count. (Counted as
    // "invited", it would hold the re-paired board to the 30-minute-old window,
    // already closed: a board nobody could ever play.)
    expect(res).toEqual({ opened: true, invited: 2, skipped: [] });
    expect((await stampRows(s.stageId))[0]!.opened_at.getTime()).toBeGreaterThan(t0.getTime());
    expect(await bridgeOf(gameBoard)).toEqual(kept);
    const gameSeats = after.find((b) => b.fixtureId === gameBoard)!;
    const emailOf = new Map(s.players.map((p) => [p.entrantId, p.email]));
    for (const e of [gameSeats.home, gameSeats.away]) {
      expect(mail.sent.filter((m) => m.fixtureUrl.includes(gameBoard) && m.to === emailOf.get(e))).toHaveLength(0);
    }
  });

  it("a board whose create outcome is UNKNOWN (a game may exist) survives the unpair too", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const [first] = await swissRound1(s.stageId);
    await open(s);
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "timeout" });
    expect(await createGameIfReady(first!.fixtureId, { publish: async () => undefined })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const held = (await bridgeOf(first!.fixtureId))!;
    expect(held.challenge_id, "premise: no game recorded").toBeNull();
    expect(held.create_sent_at, "premise: the T9 create marker").not.toBeNull();

    await unpairSwissRound(s.owner, s.stageId);
    expect(await bridgeOf(first!.fixtureId)).toEqual(held);
  });

  it("delete-entrant cannot reach an opened round: Delete needs setup, Open needs a started division", async () => {
    // Swiss withdrawal (the started-division path) throws WRONG_PHASE until
    // W2b merges, so it is not driven here. Delete is pre-Start only, and the
    // open refuses a division that has not started, so no stamp or invite can
    // exist for clearSwissFixtureSeats to see on this path.
    const s = await seedOnlineSwissUnstarted();
    expect(await open(s)).toEqual({ opened: false, reason: "division_not_started" });
    const [victim] = await swissRound1(s.stageId);
    expect(victim, "premise: round 1 is paired before Start").toBeDefined();
    await deleteEntrant(s.owner, victim!.home);
    // The delete went through (its own reconcile unpaired round 1), and the
    // open never wrote anything for it to clear.
    const [gone] = await sql`select 1 from entrants where id = ${victim!.home}`;
    expect(gone).toBeUndefined();
    expect(await stampRows(s.stageId)).toHaveLength(0);
    const rows = await sql`select 1 from fixture_external_play ep join fixtures f on f.id = ep.fixture_id
                            where f.stage_id = ${s.stageId}`;
    expect(rows).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });
});

/** Swiss round 1 paired but the division never started — the only state the
 *  real deleteEntrant accepts. */
async function seedOnlineSwissUnstarted() {
  const owner = await seedOwner();
  const { createCompetition } = await import("../../competitions");
  const { createDivision } = await import("../../divisions");
  const { createEntrants } = await import("../../entrants");
  const competition = await createCompetition(owner, {
    name: "T19 pre-Start",
    visibility: "public",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay: "off", clock: { base: 900, increment: 10 } },
  });
  await createEntrants(
    owner,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `U${i + 1}`, seed: i + 1, members: [] })),
  );
  // Unrostered entrants: built before online play was turned on, then flipped
  // (the seed's documented bypass of the link requirement).
  await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${division.id}`;
  const [stage] = await createStages(owner, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3 },
    progression: null,
  });
  await generateStageFixtures(owner, stage!.id);
  await generateStageFixtures(owner, stage!.id);
  await sql`update fixtures set scheduled_at = '2026-10-01T12:10:00Z' where stage_id = ${stage!.id}`;
  return { stageId: stage!.id, owner, ownerUserId: owner.userId! };
}
