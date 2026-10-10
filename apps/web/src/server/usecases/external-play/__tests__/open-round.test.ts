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
  sent: [] as { to: string; fixtureUrl: string; opponentName: string; roundNo: number; scheduledLabel: string }[],
  fail: new Set<string>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(
      async (to: string, args: Parameters<typeof actual.sendExternalPlayInviteEmail>[1]) => {
        if (mail.fail.has(to)) return false;
        mail.sent.push({
          to,
          fixtureUrl: args.fixtureUrl,
          opponentName: args.opponentName,
          roundNo: args.roundNo,
          scheduledLabel: args.scheduledLabel,
        });
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
import { moveFixture } from "../../schedule";
import { ensureBridgeRow, loadOnlinePlayFixture } from "../guard";
import { readMatchRoom } from "../room";
import { mintMatchRoomToken } from "../../match-room-token";
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

describe.skipIf(!HAS_DB)("openRound — boards with NO start time (ruling 2026-10-10)", () => {
  it("are invited, and their bridge rows are minted on the round's opened_at", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2, scheduledAt: null });
    const t0 = new Date(Date.now() - 2 * MIN);
    expect(await open(r, 1, t0)).toEqual({ opened: true, invited: 4, skipped: [] });
    expect(sentTo()).toEqual(emailsOf(r).sort());
    // The mail names the open as the start (no start time to name): the
    // open's UTC hour and minute, never the epoch a NULL formats as.
    const hhmm = t0.toISOString().slice(11, 16);
    expect(mail.sent.map((m) => m.scheduledLabel).filter((l) => l.includes(hhmm))).toHaveLength(4);
    for (const b of r.boards) {
      const [row] = await sql<{ basis: Date }[]>`
        select scheduled_at_basis as basis from fixture_external_play where fixture_id = ${b.fixtureId}`;
      expect(row!.basis.getTime()).toBe(t0.getTime());
    }
  });

  it("T8 seats and T9 creates the game on such a board, through the real calls", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const b = r.boards[0]!;
    expect(await seatPlayer({ fixtureId: b.fixtureId, personId: b.home.personId })).toEqual({
      seated: false,
      reason: "round_not_open",
    });
    expect(await createGameIfReady(b.fixtureId, { publish: async () => undefined })).toEqual({
      created: false,
      reason: "not_ready",
    });
    await open(r);
    expect(await seatPlayer({ fixtureId: b.fixtureId, personId: b.home.personId })).toEqual({
      seated: true,
      participant: null,
    });
    const out = await createGameIfReady(b.fixtureId, { publish: async () => undefined });
    expect(out.created).toBe(true);
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    expect((await bridgeOf(b.fixtureId))?.status).toBe("ready");
  });

  it("a board with no start time added AFTER the open gets its row from T9 on the round's opened_at", async () => {
    // ensureBridgeRow's fallback: no attach ran for this board (no re-open),
    // so the create path mints its row — on the open, not on a NULL.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null, spares: 1 });
    const t0 = new Date(Date.now() - 2 * MIN);
    await open(r, 1, t0);
    const { fixture_id } = await addFixture(r.owner, r.stageId, {
      home_entrant_id: r.spares[0]!.home.entrantId,
      away_entrant_id: r.spares[0]!.away.entrantId,
      round_no: 1,
      scheduled_at: null,
    });
    expect(await bridgeOf(fixture_id), "premise: nothing attached it").toBeNull();
    expect((await createGameIfReady(fixture_id, { publish: async () => undefined })).created).toBe(true);
    const [row] = await sql<{ basis: Date }[]>`
      select scheduled_at_basis as basis from fixture_external_play where fixture_id = ${fixture_id}`;
    expect(row!.basis.getTime()).toBe(t0.getTime());
  });

  it("assumption guard: a NULL-time board in an UNOPENED round has no basis, and minting its row says so", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const f = await loadOnlinePlayFixture(r.boards[0]!.fixtureId);
    expect(f?.scheduledAt).toBeNull();
    await expect(ensureBridgeRow(f!)).rejects.toThrow(/no start time and its round is not open/);
    expect(await bridgeOf(r.boards[0]!.fixtureId)).toBeNull();
  });

  it("a match-room token cannot resolve a NULL-time board (no start time for its claim to match) ⇒ 404", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const b = r.boards[0]!;
    await open(r);
    const token = await mintMatchRoomToken({
      fixtureId: b.fixtureId,
      personId: b.home.personId,
      scheduledAt: new Date().toISOString(),
    });
    await expect(readMatchRoom({ kind: "token", token }, b.fixtureId, new Date())).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    // positive pair: the same player by session reads the room.
    expect((await readMatchRoom({ kind: "session", userId: b.home.userId }, b.fixtureId, new Date())).phase).toBe(
      "open",
    );
  });

  it("the match room shows no window for a NULL-time board until the open, then the open's window", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const b = r.boards[0]!;
    const before = await readMatchRoom({ kind: "session", userId: b.home.userId }, b.fixtureId, new Date());
    expect(before).toMatchObject({ phase: "before", opensAt: null, deadline: null });
    const t0 = new Date(Date.now() - MIN);
    await open(r, 1, t0);
    const after = await readMatchRoom({ kind: "session", userId: b.home.userId }, b.fixtureId, new Date());
    expect(after.phase).toBe("open");
    expect(after.deadline).toBe(new Date(t0.getTime() + DEADLINE_AFTER_MS).toISOString());
  });

  it("a start time set later resets a challenge-less pending row ONCE; a row with a game is never reset", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2, scheduledAt: null });
    const [gameBoard, quietBoard] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    await open(r);
    expect((await createGameIfReady(gameBoard.fixtureId, { publish: async () => undefined })).created).toBe(true);
    const gameRow = await sql`select * from fixture_external_play where fixture_id = ${gameBoard.fixtureId}`;
    mail.sent.length = 0;

    // The organiser gives both boards a start time, through the real move.
    const X = "2026-10-01T15:00:00.000Z";
    await moveFixture(r.owner, gameBoard.fixtureId, { scheduled_at: X });
    await moveFixture(r.owner, quietBoard.fixtureId, { scheduled_at: X });

    // The next open reads both through the guard: the quiet board's row is
    // reset onto the new time (its invite with it) and re-invited; the game
    // board's row is untouched.
    expect(await open(r)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(sentTo()).toEqual([quietBoard.home.email, quietBoard.away.email].sort());
    const [quiet] = await sql<{ basis: Date; w: Date | null; b: Date | null }[]>`
      select scheduled_at_basis as basis, white_emailed_at as w, black_emailed_at as b
        from fixture_external_play where fixture_id = ${quietBoard.fixtureId}`;
    expect(quiet!.basis.toISOString()).toBe(X);
    expect(await sql`select * from fixture_external_play where fixture_id = ${gameBoard.fixtureId}`).toEqual(gameRow);

    // ONCE: the basis now matches, so another open resets nothing and mails nobody.
    mail.sent.length = 0;
    expect(await open(r)).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(mail.sent).toHaveLength(0);
    const [still] = await sql<{ w: Date | null; b: Date | null }[]>`
      select white_emailed_at as w, black_emailed_at as b from fixture_external_play where fixture_id = ${quietBoard.fixtureId}`;
    expect(still!.w?.getTime()).toBe(quiet!.w?.getTime());
    expect(still!.b?.getTime()).toBe(quiet!.b?.getTime());
    expect(await sql`select * from fixture_external_play where fixture_id = ${gameBoard.fixtureId}`).toEqual(gameRow);
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

  // Controller ruling (pre-review, 2026-10-10): a round a game stands behind
  // — a recorded challenge, or a create whose outcome is unknown — is NOT
  // re-paired. Unpair and delete-entrant refuse 409 ONLINE_GAME_EXISTS and
  // change nothing; the organiser voids the game first (T16).
  async function roundState(stageId: string, fixtureIds: string[]) {
    const seats = await swissRound1(stageId);
    const rows = await Promise.all(fixtureIds.map((id) => bridgeOf(id)));
    return { seats, rows };
  }

  it("unpair REFUSES a round with a game on one board — 409 ONLINE_GAME_EXISTS, and nothing changes on any board", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    const [gameBoard, quietBoard] = before.map((b) => b.fixtureId) as [string, string];
    expect((await createGameIfReady(gameBoard, { publish: async () => undefined })).created).toBe(true);
    expect((await bridgeOf(gameBoard))!.challenge_id, "premise: a recorded game").not.toBeNull();
    expect((await bridgeOf(quietBoard))!.white_emailed_at, "premise: the other board was invited").not.toBeNull();
    const snapshot = await roundState(s.stageId, [gameBoard, quietBoard]);

    expect(await refusal(unpairSwissRound(s.owner, s.stageId))).toEqual({ status: 409, code: "ONLINE_GAME_EXISTS" });
    // No seat cleared, no row deleted — on the game board AND the other one.
    expect(await roundState(s.stageId, [gameBoard, quietBoard])).toEqual(snapshot);
  });

  it("unpair REFUSES a round whose board has a create of unknown outcome (a game may exist)", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    const [first, other] = before.map((b) => b.fixtureId) as [string, string];
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "timeout" });
    expect(await createGameIfReady(first, { publish: async () => undefined })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const held = (await bridgeOf(first))!;
    expect(held.challenge_id, "premise: no game recorded").toBeNull();
    expect(held.create_sent_at, "premise: the T9 create marker").not.toBeNull();
    const snapshot = await roundState(s.stageId, [first, other]);

    expect(await refusal(unpairSwissRound(s.owner, s.stageId))).toEqual({ status: 409, code: "ONLINE_GAME_EXISTS" });
    expect(await roundState(s.stageId, [first, other])).toEqual(snapshot);
  });

  it("a bridge row T9 mints DURING the seat clear cannot slip past it: the mint waits, then finds the seats gone", async () => {
    // Staged, not raced. Board B has no bridge row yet (forced by SQL: it
    // stands for a board T9's ensureBridgeRow would mint, e.g. one added
    // after the open). T9 has already read B's seats. Another session holds
    // board A's row so the unpair is seen PAUSED mid-clear; T9's mint for B
    // must then wait behind the clear and, once it commits, insert nothing —
    // the clear's check never saw a row, so no row may appear after it.
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const [a, b] = (await swissRound1(s.stageId)).map((x) => x.fixtureId) as [string, string];
    await open(s);
    await sql`delete from fixture_external_play where fixture_id = ${b}`;
    const seenByT9 = (await loadOnlinePlayFixture(b))!;
    expect(seenByT9.bridge, "premise: B has no row").toBeNull();

    const waiting = async (pattern: string) => {
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and query ilike ${pattern}`;
      return w!.n > 0;
    };
    const settle = <T,>(p: Promise<T>) => {
      const box = { done: false, out: undefined as unknown as { ok: true; v: T } | { ok: false; e: unknown } };
      const done = p.then(
        (v) => (box.out = { ok: true, v }),
        (e: unknown) => (box.out = { ok: false, e }),
      ).finally(() => (box.done = true));
      return { box, done };
    };

    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`select 1 from fixture_external_play where fixture_id = ${a} for update`;
      const unpair = settle(unpairSwissRound(s.owner, s.stageId));
      let paused = false;
      for (let i = 0; i < 100 && !paused; i++) {
        paused = await waiting("%delete from fixture_external_play%");
        if (!paused) await new Promise((res) => setTimeout(res, 50));
      }
      expect(paused, "the unpair never paused mid-clear").toBe(true);

      const mint = settle(ensureBridgeRow(seenByT9));
      let mintWaited = false;
      for (let i = 0; i < 60 && !mintWaited && !mint.box.done; i++) {
        mintWaited = await waiting("%insert into fixture_external_play%");
        if (!mintWaited) await new Promise((res) => setTimeout(res, 50));
      }
      expect(mint.box.done, "the mint ran THROUGH a seat clear in progress").toBe(false);
      expect(mintWaited).toBe(true);

      await holder`commit`;
      await unpair.done;
      await mint.done;
      expect(unpair.box.out.ok, "no game on either board — the unpair goes through").toBe(true);
      expect(mint.box.out.ok).toBe(true);
    } finally {
      await holder`rollback`.catch(() => undefined); // a no-op after the commit
      holder.release();
    }
    expect(await bridgeOf(b), "the mint found the seats gone and wrote nothing").toBeNull();
    const [seats] = await sql`select home_entrant_id, away_entrant_id from fixtures where id = ${b}`;
    expect(seats).toEqual({ home_entrant_id: null, away_entrant_id: null });
  });

  it("delete-entrant REFUSES likewise when the entrant's round has a game", async () => {
    // Delete is pre-Start only and a game needs a started division, so the
    // division is put back to 'setup' by SQL (no product path does this) to
    // drive the REAL deleteEntrant into the shared seat clear.
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    const [gameBoard, other] = before.map((b) => b.fixtureId) as [string, string];
    expect((await createGameIfReady(gameBoard, { publish: async () => undefined })).created).toBe(true);
    await sql`update divisions set status = 'setup' where id = ${s.divisionId}`;
    const snapshot = await roundState(s.stageId, [gameBoard, other]);

    expect(await refusal(deleteEntrant(s.owner, before[0]!.home))).toEqual({ status: 409, code: "ONLINE_GAME_EXISTS" });
    expect(await roundState(s.stageId, [gameBoard, other])).toEqual(snapshot);
    const [still] = await sql`select 1 from entrants where id = ${before[0]!.home}`;
    expect(still, "the entrant was not deleted").toBeDefined();
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
