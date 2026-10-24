// T19 — the organiser opens a round (D12). Nothing seats and no game is
// created until this stamps `stage_round_opens` and sends the invites.
//
// Single-sport by construction for everything but the sport sweep: online
// play exists only for `boardgame` (`supportsOnlinePlay`), so every other
// sport is a refusal, swept once below over the engine's own registry.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { backendPid, pollWaitersBehind, waitersBehind } from "./_lock-waiters";
import { HttpError } from "@/lib/errors";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS, MINT_CLAIM_STALE_MS, windowFor } from "@/server/external-play/window";
import { boardOpenFor } from "@/server/external-play/round-open";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";

// The email seam: the invite is rendered, queued on the email outbox in the open's transaction and sent after commit through
// the outbox's one network seam (`transport.deliver`), which is replaced here (_invite-mail.ts). `fail` names recipients whose
// send the provider refuses for good.
const mail = vi.hoisted(() => ({
  sent: [] as SentInvite[],
  fail: new Set<string>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
// The invite is queued on the email outbox and sent after commit through its one network seam; the provider's answer is ours.
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
});
beforeEach(() => stubOutboxEnv());
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
  // `${fixtureId}|${colour}` whose queueFixtureInvite call THROWS (inside the seat's
  // savepoint: review M1), whose queueFixtureInvite queues NOTHING (a seat with no
  // address: the claimed seat is un-stamped after the commit) and whose releaseSeat
  // call THROWS.
  sendThrows: new Set<string>(),
  noRows: new Set<string>(),
  releaseThrows: new Set<string>(),
  afterEnsure: null as null | (() => Promise<void>),
}));
vi.mock("../guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../guard")>();
  return {
    ...actual,
    loadOnlinePlayFixture: async (id: string) =>
      race.guardNullFor === id ? null : actual.loadOnlinePlayFixture(id),
    ensureBridgeRow: async (...args: Parameters<typeof actual.ensureBridgeRow>) => {
      await actual.ensureBridgeRow(...args);
      if (race.afterEnsure) {
        const hook = race.afterEnsure;
        race.afterEnsure = null;
        await hook();
      }
    },
  };
});
vi.mock("../invite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../invite")>();
  return {
    ...actual,
    queueFixtureInvite: async (...args: Parameters<typeof actual.queueFixtureInvite>) => {
      const key = `${args[1].fixture.fixtureId}|${args[1].seat.colour}`;
      if (race.sendThrows.has(key)) throw new Error("staged: queueing threw");
      if (race.noRows.has(key)) return [];
      return actual.queueFixtureInvite(...args);
    },
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

// The un-stamp is the seat-stamp module's (the outbox's chess hook shares it); the test's throw rides on its own import of it.
vi.mock("../seat-stamp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../seat-stamp")>();
  return {
    ...actual,
    releaseSeat: async (...args: Parameters<typeof actual.releaseSeat>) => {
      if (race.releaseThrows.has(`${args[1]}|${args[2]}`)) throw new Error("staged: release failed");
      return actual.releaseSeat(...args);
    },
  };
});

import { openRound, roundOpenedAt } from "../open-round";
import { bridgeTakesInvites } from "../invite";
import { organiserOverrideVideo, seatPlayer, type PreflightDeps } from "../preflight";
import { sweepExternalPlay } from "../sweep";
import { RealtimeKitDeferred, addParticipant, endMeeting, ensureMeeting, refreshParticipantToken } from "@/server/external-play/video/realtimekit";
import { log } from "@/server/logger";
import { createGameIfReady } from "../create-game";
import { resolveExternalPlay } from "../resolve";
import { holdForOrganiser, writeResultFrom } from "../result";
import type { GameSnapshot } from "@/server/external-play/types";
import { getFixtureState } from "../../fixtures";
import { scoreEvent } from "../../scoring";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import {
  addFixture,
  generateStageFixtures,
  rebuildStageFixtures,
  unpairSwissRound,
  createStages,
} from "../../stages";
import { deleteEntrant } from "../../entrants";
import { patchDivision } from "../../divisions";
import { divisionLockedFields } from "../../rule-locks";
import { formatLockedStageIds, putStageRules } from "../../stage-rules";
import { moveFixture } from "../../schedule";
import { ensureBridgeRow, loadOnlinePlayFixture } from "../guard";
import { readRoom } from "../room";
import { mintMatchRoomToken } from "../../match-room-token";
import {
  seedOnlineChessRound,
  seedOnlineChessRoundWithRankedBoard,
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
  race.sendThrows.clear();
  race.noRows.clear();
  race.releaseThrows.clear();
  race.afterEnsure = null;
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
    expect(res).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });

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
      expect(toHome.fixtureUrl).toContain(`/fixtures/${b.fixtureId}/play?t=`);
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

    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect(await roundOpenedAt({ stageId: r.stageId, roundNo: 2 })).toBeNull();
    expect(await roundOpenedAt({ stageId: other.stageId, roundNo: 1 })).toBeNull();
    expect(sentTo()).toEqual(emailsOf(r).sort());

    // Round 2 opens on its own stamp and leaves round 1's alone.
    const r1 = (await stampRows(r.stageId, 1))[0]!;
    expect(await open(r, 2)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect((await stampRows(r.stageId, 2))).toHaveLength(1);
    expect((await stampRows(r.stageId, 1))[0]!.opened_at.getTime()).toBe(r1.opened_at.getTime());
  });

  // Rebase ruling D2 (W2c): an OPENED round locks its stage. rule-locks-opened-round.test.ts proves the predicate against a
  // `stage_round_opens` row the SEED writes; this is the other end of the same seam, the row the REAL open writes (its stamp is
  // now written beside the outbox rows), read by the real lock.
  it("D2: the row this open writes is what locks the stage - open before, locked after, and only that stage", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const other = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });

    // The empty case first: nothing opened, nothing locked, the save goes through (an unlocked save is not itself a refusal).
    expect(await stampRows(r.stageId), "premise: the round is not opened").toHaveLength(0);
    expect(await formatLockedStageIds(r.owner, r.divisionId)).toEqual([]);
    expect(await divisionLockedFields(r.owner, r.divisionId)).toEqual([]);
    await putStageRules(r.owner, r.stageId, { rules: {} });

    expect(await open(r)).toMatchObject({ opened: true });
    expect(await stampRows(r.stageId), "the real open wrote the stamp").toHaveLength(1);
    expect(await formatLockedStageIds(r.owner, r.divisionId)).toEqual([r.stageId]);
    for (const call of ["first", "second"]) {
      await expect(putStageRules(r.owner, r.stageId, { rules: {} }), call).rejects.toMatchObject({
        status: 409,
        code: "STAGE_FORMAT_LOCKED",
      });
    }

    // Another division's unopened stage is untouched by this open.
    expect(await formatLockedStageIds(other.owner, other.divisionId)).toEqual([]);
    await putStageRules(other.owner, other.stageId, { rules: {} });
  });
});

describe.skipIf(!HAS_DB)("openRound — idempotent per seat, in BOTH directions", () => {
  it("re-opening sends nothing, but a board added after the open still gets invited", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });

    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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
    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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

  // Review I1 (fix round 1, ruling 2026-10-10): "nobody invited" counts the
  // stamps on EVERY bridge row bound to this open, whatever became of its
  // board — a game, a result, a hold. Before the fix the neighbour dropped
  // out of the count, the late board read "zero invited", and the WHOLE
  // round's window was re-stamped past the deadline.
  const neighbour: [string, (fixtureId: string, t0: Date) => Promise<void>][] = [
    [
      "holds a game (real T9 create)",
      async (f, t0) => {
        const out = await createGameIfReady(f, { publish: async () => undefined, now: new Date(t0.getTime() + MIN) });
        expect(out.created, "premise: the game was made").toBe(true);
      },
    ],
    [
      "had a game that then finished (result forced by SQL: T12 is not built)",
      async (f, t0) => {
        const out = await createGameIfReady(f, { publish: async () => undefined, now: new Date(t0.getTime() + MIN) });
        expect(out.created, "premise: the game was made").toBe(true);
        await sql`update fixture_external_play set status = 'finished' where fixture_id = ${f}`;
        await sql`update fixtures set status = 'finalized' where id = ${f}`;
      },
    ],
    [
      "is held for the organiser (real T9 create, outcome unknown)",
      async (f, t0) => {
        board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "timeout" });
        const out = await createGameIfReady(f, { publish: async () => undefined, now: new Date(t0.getTime() + MIN) });
        expect(out).toEqual({ created: false, reason: "provider_error" });
        expect((await bridgeOf(f))!.status, "premise: held").toBe("needs_organiser");
      },
    ],
  ];
  it.each(neighbour)(
    "a late board after the window, while the round's only invited board %s ⇒ window_closed, opened_at UNCHANGED, nobody mailed",
    async (_name, become) => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
      const t0 = new Date(Date.now() - DEADLINE_AFTER_MS - 10 * MIN);
      expect(await open(r, 1, t0)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
      await become(r.boards[0]!.fixtureId, t0);
      const { fixtureId } = await lateBoard(r);
      mail.sent.length = 0;

      expect(await open(r, 1, new Date())).toEqual({
        opened: false,
        reason: "already_open",
        skipped: [{ fixtureId, reason: "window_closed" }],
      });
      expect(mail.sent).toHaveLength(0);
      expect((await stampRows(r.stageId))[0]!.opened_at.getTime(), "the round's window did not move").toBe(
        t0.getTime(),
      );
      expect(await bridgeOf(fixtureId)).toBeNull();
    },
  );

  it("a round whose only board was invited and then RESCHEDULED: after the deadline its re-invite is window_closed and opened_at does not move", async () => {
    // The reschedule's reset (T7) clears the board's stamps so its players
    // are re-mailed with the new time — inside the round's window. It must not
    // read as "nobody was ever invited" and re-stamp the round.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const t0 = new Date(Date.now() - DEADLINE_AFTER_MS - 10 * MIN);
    expect(await open(r, 1, t0)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const fixtureId = r.boards[0]!.fixtureId;
    await moveFixture(r.owner, fixtureId, { scheduled_at: "2026-10-01T16:00:00.000Z" });
    mail.sent.length = 0;

    expect(await open(r, 1, new Date())).toEqual({
      opened: false,
      reason: "already_open",
      skipped: [{ fixtureId, reason: "window_closed" }],
    });
    expect(mail.sent).toHaveLength(0);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(t0.getTime());
    // positive pair: the same reschedule INSIDE the window re-invites that
    // board, and the window still does not move.
    const r2 = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const t1 = new Date(Date.now() - 5 * MIN);
    await open(r2, 1, t1);
    await moveFixture(r2.owner, r2.boards[0]!.fixtureId, { scheduled_at: "2026-10-01T16:00:00.000Z" });
    mail.sent.length = 0;
    expect(await open(r2, 1, new Date())).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect((await stampRows(r2.stageId))[0]!.opened_at.getTime()).toBe(t1.getTime());
  });

  it("positive pair: the same late board inside the window IS invited, and the window does not move", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, spares: 1 });
    const now = new Date();
    const openedAt = new Date(now.getTime() - DEADLINE_AFTER_MS + MIN);
    await open(r, 1, openedAt);
    const { late } = await lateBoard(r);
    mail.sent.length = 0;

    expect(await open(r, 1, now)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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
      retrying: 0,
      skipped: [{ fixtureId: b0.fixtureId, reason: "send_failed" }],
    });
    const row = (await bridgeOf(b0.fixtureId))!;
    const stamped = [row.white_emailed_at, row.black_emailed_at].filter((x) => x !== null);
    expect(stamped, "only the seat whose mail went out is stamped").toHaveLength(1);
    const first = (await stampRows(r.stageId))[0]!;

    mail.fail.clear();
    expect(await open(r)).toEqual({ opened: true, invited: 1, retrying: 0, skipped: [] });
    expect(mail.sent.filter((m) => m.to === b0.home.email)).toHaveLength(1);
    expect(new Set(mail.sent.map((m) => m.to)).size).toBe(4);
    expect(mail.sent).toHaveLength(4); // each player exactly once
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(first.opened_at.getTime());
    // The retry kept the board's OTHER seat's record: a third open has nobody
    // left to invite.
    expect(await open(r)).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(mail.sent).toHaveLength(4);
  });

  // Review M1: one seat's send throwing must not strand the seats after it.
  // Staged in the order claims are sent: the FIRST board's white seat.
  it("a send that THROWS fails that seat alone: every other seat is still mailed, it is un-stamped and reported, the audit is written", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [b0, b1] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    race.sendThrows.add(`${b0.fixtureId}|white`);
    expect(await open(r)).toEqual({ opened: true, invited: 3, retrying: 0, skipped: [{ fixtureId: b0.fixtureId, reason: "send_failed" }] });
    expect(mail.sent).toHaveLength(3);
    expect(mail.sent.filter((m) => m.fixtureUrl.includes(b1.fixtureId))).toHaveLength(2);
    const row = (await bridgeOf(b0.fixtureId))!;
    expect(row.white_emailed_at, "the thrown seat is un-stamped, so the next open retries it").toBeNull();
    expect(row.black_emailed_at).not.toBeNull();
    expect(await auditTypes(r.competitionId)).toEqual(["external_play.round_opened"]);
    // ...and the retry is that seat alone.
    race.sendThrows.clear();
    mail.sent.length = 0;
    expect(await open(r)).toEqual({ opened: true, invited: 1, retrying: 0, skipped: [] });
    expect(mail.sent).toHaveLength(1);
  });

  it("an un-stamp that THROWS leaves that seat stamped but REPORTED, and still mails every other seat and writes the audit", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [b0, b1] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    // A claimed seat that reached nobody is un-stamped after the commit: staged here as a seat whose mail queued no row.
    race.noRows.add(`${b0.fixtureId}|white`);
    race.releaseThrows.add(`${b0.fixtureId}|white`);
    expect(await open(r)).toEqual({ opened: true, invited: 3, retrying: 0, skipped: [{ fixtureId: b0.fixtureId, reason: "send_failed" }] });
    expect(mail.sent.filter((m) => m.fixtureUrl.includes(b1.fixtureId))).toHaveLength(2);
    expect((await bridgeOf(b0.fixtureId))!.white_emailed_at, "the seat whose un-stamp threw stays stamped (reported, not hidden)").not.toBeNull();
    expect(await auditTypes(r.competitionId)).toEqual(["external_play.round_opened"]);
  });

  it("when EVERY send failed, the round holds no invited seat, so the re-open starts a fresh window", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    for (const e of emailsOf(r)) mail.fail.add(e);
    const t0 = new Date(Date.now() - 30 * MIN);
    expect(await open(r, 1, t0)).toEqual({
      opened: true,
      invited: 0,
      retrying: 0,
      skipped: [{ fixtureId: r.boards[0]!.fixtureId, reason: "send_failed" }],
    });
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(t0.getTime());

    mail.fail.clear();
    const t1 = new Date();
    expect(await open(r, 1, t1)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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
    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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
      expect(await open(r), tc.key).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
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
    expect(await open(r, 1, t0)).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });
    expect(sentTo()).toEqual(emailsOf(r).sort());
    // The mail's one time is the deadline — the OPEN's the deadline (T14, review
    // M2), never a start time and never the epoch a NULL formats as. A
    // locale may print a 12- or a 24-hour clock ("07:09 PM" / "19:09"), so
    // either form is accepted — a fixed one went red every afternoon UTC.
    const pad = (n: number) => String(n).padStart(2, "0");
    const deadline = new Date(t0.getTime() + DEADLINE_AFTER_MS);
    const h = deadline.getUTCHours();
    const mm = pad(deadline.getUTCMinutes());
    const clocks = [`${pad(h)}:${mm}`, `${pad(((h + 11) % 12) + 1)}:${mm}`];
    const day = String(deadline.getUTCDate());
    const named = mail.sent
      .map((m) => m.deadlineLabel)
      .filter((l) => clocks.some((c) => l.includes(c)) && new RegExp(`\\b${day}\\b`).test(l));
    expect(named).toHaveLength(4);
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

  // Review M3 (fix round 1): the pre-open video override reached
  // bridgeBasis's "no basis" assertion on a NULL-time board — a 500. It must
  // answer exactly what a timed board answers: the override is recorded, and
  // the seat is still round_not_open.
  it.each([
    ["a timed board", new Date("2026-10-01T12:10:00.000Z")],
    ["a board with no start time", null],
  ] as const)("the pre-open video override answers the same on %s: recorded, and the seat stays round_not_open", async (_n, at) => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: at, cameraPolicy: "required" });
    const b = r.boards[0]!;
    await organiserOverrideVideo({ fixtureId: b.fixtureId, actorUserId: r.ownerUserId, note: "vendor outage" });
    const [row] = await sql<{ video_override_at: Date | null }[]>`
      select video_override_at from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(row?.video_override_at, "the override is recorded").not.toBeNull();
    const kinds = await sql<{ kind: string }[]>`select kind from online_chess_audit where fixture_id = ${b.fixtureId}`;
    expect(kinds.map((k) => k.kind)).toEqual(["video_override"]);
    expect(await seatPlayer({ fixtureId: b.fixtureId, personId: b.home.personId })).toEqual({
      seated: false,
      reason: "round_not_open",
    });
  });

  it("a NULL-time board's row minted pre-open (by the override) is rebased onto opened_at when the round opens", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null, cameraPolicy: "required" });
    const b = r.boards[0]!;
    await organiserOverrideVideo({ fixtureId: b.fixtureId, actorUserId: r.ownerUserId, note: "vendor outage" });
    const t0 = new Date(Date.now() - 2 * MIN);
    expect(await open(r, 1, t0)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const [row] = await sql<{ basis: Date; override: Date | null }[]>`
      select scheduled_at_basis as basis, video_override_at as override
        from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(row!.basis.getTime()).toBe(t0.getTime());
    expect(row!.override, "the override survives the open").not.toBeNull();
  });

  it("the override locks the fixture BEFORE the bridge row (the seat clear's order), so a clear holding the fixture cannot deadlock it", async () => {
    // Staged: the override has minted its row; then a seat clear takes the
    // fixture lock (here: another session). The override's transaction must
    // wait on the FIXTURE, holding nothing — so that session can still lock
    // the bridge row, as the clear's next step does.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, cameraPolicy: "required" });
    const fixtureId = r.boards[0]!.fixtureId;
    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    try {
      race.afterEnsure = async () => {
        await holder`begin`;
        await holder`select id from fixtures where id = ${fixtureId} for update`;
      };
      let done = false;
      const p = organiserOverrideVideo({ fixtureId, actorUserId: r.ownerUserId, note: "vendor outage" }).finally(
        () => (done = true),
      );
      // I-3: only a session blocked by OUR holder counts — another suite's lock waiter never does.
      const waited = (await pollWaitersBehind(holderPid, { queryLike: "%from fixtures%for share%", finished: () => done })) > 0;
      expect(waited, "the override never waited on the fixture first").toBe(true);
      // The clear's next lock: the bridge row. Free, because the override
      // took nothing before the fixture.
      await holder`select fixture_id from fixture_external_play where fixture_id = ${fixtureId} for update nowait`;
      await holder`commit`;
      await p;
      expect((await bridgeOf(fixtureId)) !== null).toBe(true);
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
  });

  it("assumption guard: a NULL-time board in an UNOPENED round has no basis, and minting its row says so", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const f = await loadOnlinePlayFixture(r.boards[0]!.fixtureId);
    expect(f?.scheduledAt).toBeNull();
    await expect(ensureBridgeRow(f!)).rejects.toThrow(/no start time and its round is not open/);
    expect(await bridgeOf(r.boards[0]!.fixtureId)).toBeNull();
  });

  it("M4 (T14): a match-room token bound to the round's OPEN resolves a NULL-time board; a token for another open does not", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const b = r.boards[0]!;
    await open(r);
    const [row] = await sql<{ id: string; opened_at: Date }[]>`
      select sro.id, sro.opened_at from stage_round_opens sro
        join fixtures f on f.stage_id = sro.stage_id and f.round_no = sro.round_no
       where f.id = ${b.fixtureId}`;
    const token = await mintMatchRoomToken({
      fixtureId: b.fixtureId,
      personId: b.home.personId,
      roundOpenId: row!.id,
      roundOpenedAt: row!.opened_at.toISOString(),
    });
    const v = await readRoom({ kind: "token", token }, b.fixtureId);
    expect(v.phase).toBe("open");
    expect(v.scheduledAt, "premise: the board has no start time").toBeNull();
    // Negative pair: the same fixture and person, another open's id.
    const stale = await mintMatchRoomToken({
      fixtureId: b.fixtureId,
      personId: b.home.personId,
      roundOpenId: randomUUID(),
      roundOpenedAt: row!.opened_at.toISOString(),
    });
    await expect(readRoom({ kind: "token", token: stale }, b.fixtureId)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("the match room shows no window for a NULL-time board until the open, then the open's window", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, scheduledAt: null });
    const b = r.boards[0]!;
    const before = await readRoom({ kind: "session", userId: b.home.userId }, b.fixtureId);
    expect(before).toMatchObject({ phase: "not_opened", opensAt: null, deadline: null });
    const t0 = new Date(Date.now() - MIN);
    await open(r, 1, t0);
    const after = await readRoom({ kind: "session", userId: b.home.userId }, b.fixtureId);
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
    // reset onto the new time (its invite with it) and re-invited INSIDE the
    // round's own window; the game board's row is untouched, and its stamps
    // still count as invited, so the round is NOT re-stamped (review I1).
    const [before] = await stampRows(r.stageId);
    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime(), "opened_at did not move").toBe(
      before!.opened_at.getTime(),
    );
    expect(await auditTypes(r.competitionId)).toEqual(["external_play.round_opened", "external_play.round_reinvited"]);
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
      retrying: 0,
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

  it("review M9: an upgrade racing an open is judged AFTER the open commits — staged on the division lock, both real calls", async () => {
    // Another session holds the division lock. The REAL open queues on it
    // first, then the REAL upgrade. Released, the open runs and commits; the
    // upgrade's gate must be read after that (inside its own transaction,
    // under the same lock) and refuse. Read before its transaction, it would
    // have seen no open and committed the tightening behind a live round.
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    // I-3: only sessions blocked by OUR holder count — another suite's lock waiter never does.
    const until = async (holderPid: number, n: number, what: string) => {
      expect(await pollWaitersBehind(holderPid, { atLeast: n, queryLike: "%pg_advisory_xact_lock%" }), what).toBeGreaterThanOrEqual(n);
    };
    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      const opening = open(r).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      await until(holderPid, 1, "the open never queued on the division lock");
      const upgrading = refusal(patchDivision(r.owner, r.divisionId, { camera_policy: "required" })).catch(
        (e: unknown) => ({ status: -1, code: String(e) }),
      );
      await until(holderPid, 2, "the upgrade never queued on the division lock (its gate was read outside it)");
      await holder`commit`;
      const o = await opening;
      expect(o.ok && o.v).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
      expect(await upgrading).toEqual({ status: 409, code: "POLICY_LOCKED" });
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
    const [d] = await sql<{ camera_policy: string | null }[]>`select camera_policy from divisions where id = ${r.divisionId}`;
    expect(d!.camera_policy, "the tightening never committed").toBeNull();
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
    const holderPid = await backendPid(holder);
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      const pending = open(r).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      // I-3: only a session blocked by OUR holder counts — another suite's lock waiter never does.
      const waited = (await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%" })) > 0;
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
    expect(await open(s, 1, t0)).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });

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
    expect(await open(s, 1, t1)).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });
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
    // board A's row so the unpair is seen PAUSED mid-clear (locking the
    // bridge rows, its fixture locks already held); T9's mint for B
    // must then wait behind the clear and, once it commits, insert nothing —
    // the clear's check never saw a row, so no row may appear after it.
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const [a, b] = (await swissRound1(s.stageId)).map((x) => x.fixtureId) as [string, string];
    await open(s);
    await sql`delete from fixture_external_play where fixture_id = ${b}`;
    const seenByT9 = (await loadOnlinePlayFixture(b))!;
    expect(seenByT9.bridge, "premise: B has no row").toBeNull();

    // I-3: only sessions blocked by OUR holder count, directly or down the chain (the mint waits on the unpair, which
    // waits on the holder) — another suite's lock waiter never does.
    const waiting = async (holderPid: number, pattern: string) => (await waitersBehind(holderPid, pattern)) > 0;
    const settle = <T,>(p: Promise<T>) => {
      const box = { done: false, out: undefined as unknown as { ok: true; v: T } | { ok: false; e: unknown } };
      const done = p.then(
        (v) => (box.out = { ok: true, v }),
        (e: unknown) => (box.out = { ok: false, e }),
      ).finally(() => (box.done = true));
      return { box, done };
    };

    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    try {
      await holder`begin`;
      await holder`select 1 from fixture_external_play where fixture_id = ${a} for update`;
      const unpair = settle(unpairSwissRound(s.owner, s.stageId));
      let paused = false;
      for (let i = 0; i < 100 && !paused; i++) {
        // Paused locking the round's bridge rows — after the fixtures.
        paused = await waiting(holderPid, "%from fixture_external_play%for update%");
        if (!paused) await new Promise((res) => setTimeout(res, 50));
      }
      expect(paused, "the unpair never paused mid-clear").toBe(true);

      const mint = settle(ensureBridgeRow(seenByT9));
      let mintWaited = false;
      for (let i = 0; i < 60 && !mintWaited && !mint.box.done; i++) {
        mintWaited = await waiting(holderPid, "%insert into fixture_external_play%");
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

  // Review M8 (fix round 1): Rebuild deletes the stage's fixtures, and the
  // bridge FK CASCADEs — a live game's only record would go with them.
  const gameKinds: [string, (fixtureId: string) => Promise<void>][] = [
    [
      "a recorded game",
      async (f) => {
        expect((await createGameIfReady(f, { publish: async () => undefined })).created).toBe(true);
      },
    ],
    [
      "a create of unknown outcome",
      async (f) => {
        board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "timeout" });
        await createGameIfReady(f, { publish: async () => undefined });
        expect((await bridgeOf(f))!.create_sent_at, "premise: the T9 marker").not.toBeNull();
      },
    ],
  ];
  it.each(gameKinds)("rebuild REFUSES a stage with %s on a board — 409 ONLINE_GAME_EXISTS, nothing deleted", async (_n, make) => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    await make(before[0]!.fixtureId);
    const ids = before.map((b) => b.fixtureId);
    const snapshot = await roundState(s.stageId, ids);

    expect(await refusal(rebuildStageFixtures(s.owner, s.stageId))).toEqual({ status: 409, code: "ONLINE_GAME_EXISTS" });
    expect(await roundState(s.stageId, ids)).toEqual(snapshot);
  });

  it("positive pair: rebuild of an opened stage with NO game goes through (its game-less rows go with the fixtures)", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    await rebuildStageFixtures(s.owner, s.stageId);
    for (const b of before) expect(await bridgeOf(b.fixtureId)).toBeNull();
    const [gone] = await sql`select 1 from fixtures where id in ${sql(before.map((b) => b.fixtureId))}`;
    expect(gone, "the old fixtures were replaced").toBeUndefined();
  });

  // Final review M-10 (brief ruling): the lock blocks only while a game is LIVE or mid-create — never once the game is
  // over or our side closed the board. Before, a recorded challenge blocked forever: a board whose game Lichess
  // aborted (held `aborted`, nothing on the ledger) could never be re-paired, settled or not.
  /** A recorded game that Lichess then ABORTED, through T12's real writer, with the game-over stamp reconcile's read
   *  writes before it (reconcile.ts `settle`). Nothing reaches the ledger. */
  async function abortedGame(fixtureId: string): Promise<void> {
    expect((await createGameIfReady(fixtureId, { publish: async () => undefined })).created).toBe(true);
    const gameId = (await bridgeOf(fixtureId))!.challenge_id!;
    await sql`update fixture_external_play set game_over_at = now() where fixture_id = ${fixtureId}`;
    const snapshot = { gameId, status: "aborted", winner: null, movesSan: [], whiteMs: 1, blackMs: 1, increment: 0 } as unknown as GameSnapshot;
    await writeResultFrom(snapshot, fixtureId);
    const [ledger] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(ledger!.n, "premise: an aborted game writes nothing to the ledger").toBe(0);
    expect(await bridgeOf(fixtureId), "premise: held aborted, the game id kept").toMatchObject({ status: "needs_organiser", challenge_id: gameId });
  }

  it("M-10: a board whose game Lichess ABORTED is re-paired — unpair goes through, its bridge row goes with the seats, and the re-paired round opens afresh", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    expect(await open(s)).toMatchObject({ opened: true });
    await abortedGame(before[0]!.fixtureId);

    await unpairSwissRound(s.owner, s.stageId);
    let checked = 0;
    for (const b of before) {
      expect(await bridgeOf(b.fixtureId), `${b.fixtureId}: the bridge went with the seats`).toBeNull();
      const [seats] = await sql`select home_entrant_id, away_entrant_id from fixtures where id = ${b.fixtureId}`;
      expect(seats).toEqual({ home_entrant_id: null, away_entrant_id: null });
      checked += 1;
    }
    expect(checked).toBe(2);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    expect(await swissRound1(s.stageId), "re-paired").toHaveLength(2);
    mail.sent.length = 0;
    expect(await open(s, 1, new Date())).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });
  });

  it("M-10: rebuild of a stage whose one game Lichess aborted goes through too", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    await abortedGame(before[0]!.fixtureId);
    await rebuildStageFixtures(s.owner, s.stageId);
    const [gone] = await sql`select 1 from fixtures where id in ${sql(before.map((b) => b.fixtureId))}`;
    expect(gone, "the old fixtures were replaced").toBeUndefined();
  });

  it("M-10: a board OUR side closed (finished) with nothing on its ledger is not locked; a held board whose game has not been seen to end still is", async () => {
    // The finished row stands for one reconcile or a settle closed (reconcile.ts: "the bridge closes with no read and
    // no result") — by SQL, since every product path that closes a bridge also leaves ledger evidence, which the
    // unpair's own played-result guards refuse first (the next test).
    {
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
      const before = await swissRound1(s.stageId);
      await open(s);
      expect((await createGameIfReady(before[0]!.fixtureId, { publish: async () => undefined })).created).toBe(true);
      await sql`update fixture_external_play set status = 'finished', finished_at = now() where fixture_id = ${before[0]!.fixtureId}`;
      await unpairSwissRound(s.owner, s.stageId);
      expect(await bridgeOf(before[0]!.fixtureId)).toBeNull();
    }
    // A token_revoked hold mid-game: the game may still be running at Lichess — the round is not re-paired under it.
    {
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
      const before = await swissRound1(s.stageId);
      await open(s);
      const f = before[0]!.fixtureId;
      expect((await createGameIfReady(f, { publish: async () => undefined })).created).toBe(true);
      await holdForOrganiser({ fixtureId: f, reason: "token_revoked", detail: "TEST", seat: "white" });
      expect(await bridgeOf(f), "premise: held, the game on file, no end seen").toMatchObject({ status: "needs_organiser" });
      const snapshot = await roundState(s.stageId, before.map((b) => b.fixtureId));
      expect(await refusal(unpairSwissRound(s.owner, s.stageId))).toEqual({ status: 409, code: "ONLINE_GAME_EXISTS" });
      expect(await roundState(s.stageId, before.map((b) => b.fixtureId))).toEqual(snapshot);
    }
  });

  it("M-10 premise, pinned: a board whose online RESULT was voided on the pad is held by the unpair's played-result guard (any sport's rule), never by the online lock", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold" });
    const before = await swissRound1(s.stageId);
    await open(s);
    const f = before[0]!.fixtureId;
    expect((await createGameIfReady(f, { publish: async () => undefined })).created).toBe(true);
    expect(await resolveExternalPlay(s.owner, f, "home_wins", { defer: () => undefined })).toEqual({ status: "finished" });
    const [result] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${f} and type = 'boardgame.result'`;
    const fs = await getFixtureState(s.owner, f);
    await scoreEvent(s.owner, f, { expected_seq: fs.last_seq, type: "core.void", payload: { event_id: result!.id } });
    expect(await bridgeOf(f), "premise: our side closed it").toMatchObject({ status: "finished" });
    const err = await unpairSwissRound(s.owner, s.stageId).then(() => null, (e: unknown) => e);
    expect(err && typeof err === "object" && "code" in err ? (err as { code: string }).code : err).toBe("STAGE_NOT_READY");
    expect(String((err as Error).message), "the round's own played-result guard").toContain("swiss round has played results");
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

// Final re-review N-2 (Important): one meeting per fixture, for life, meant a board re-paired after its round opened
// could not seat its NEW players once the sweep had ended the old pairing's meeting — ensureMeeting answers
// VIDEO_MEETING_ENDED under optional as well as required — and until then the new pairing joined the old players'
// meeting. A fresh window is a fresh pairing: the re-open that re-stamps the window deletes the meetings of the round's
// game-less boards (participants cascade) and ends any still active at RealtimeKit after its commit. Driven through
// the reviewer's path: the real unpair → sweep → generate → re-open → seat, RealtimeKit faked at its HTTP boundary.
describe.skipIf(!HAS_DB)("openRound — a re-paired board gets a FRESH meeting (N-2)", () => {
  const RTK_ENV = {
    CLOUDFLARE_ACCOUNT_ID: "acct-n2",
    REALTIMEKIT_API_TOKEN: "rtk-n2",
    REALTIMEKIT_APP_ID: "app-n2",
    REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
    REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
  };
  beforeEach(() => {
    for (const [k, v] of Object.entries(RTK_ENV)) vi.stubEnv(k, v);
    return () => vi.unstubAllEnvs();
  });

  /** RealtimeKit at its HTTP boundary; the adapter functions are the real ones, so the meeting rows are real. The
   *  camera is reported live, so a required seat seats on its first claim. */
  function fakeRtk(hooks: { onCreate?: () => Promise<unknown>; onEnd?: (meetingId: string) => Promise<unknown> } = {}) {
    const http: string[] = [];
    const tag = randomUUID().slice(0, 8);
    let seq = 0;
    const reply = (status: number, data: unknown) =>
      new Response(JSON.stringify({ success: true, data }), { status, headers: { "content-type": "application/json" } });
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(url)).pathname.replace(/^.*\/realtime\/kit\/app-n2/, "");
      http.push(`${method} ${path}`);
      let m: RegExpMatchArray | null;
      if (method === "POST" && path === "/meetings") {
        await hooks.onCreate?.();
        return reply(201, { id: `n2-${tag}-${++seq}` });
      }
      if (method === "POST" && /^\/meetings\/[^/]+\/participants$/.test(path)) {
        const id = `n2p-${tag}-${++seq}`;
        return reply(201, { id, token: `jwt-${id}` });
      }
      if (method === "POST" && (m = path.match(/^\/meetings\/[^/]+\/participants\/([^/]+)\/token$/))) {
        return reply(200, { token: `jwt-regen-${m[1]}-${++seq}` });
      }
      if (method === "POST" && /^\/meetings\/[^/]+\/active-session\/kick-all$/.test(path)) return reply(200, {});
      if (method === "PATCH" && (m = path.match(/^\/meetings\/([^/]+)$/))) {
        await hooks.onEnd?.(m[1]!);
        return reply(200, { id: m[1], status: "INACTIVE" });
      }
      throw new Error(`fake RealtimeKit: unrouted ${method} ${path}`);
    }) as typeof globalThis.fetch;
    const video: NonNullable<PreflightDeps["video"]> = {
      ensureMeeting: (fixtureId, side) => ensureMeeting(fixtureId, side, { fetch }),
      addParticipant: (a) => addParticipant(a, { fetch }),
      seatCameraEvidence: async () => ({ state: "on" as const, since: new Date() }),
      refreshParticipantToken: (a) => refreshParticipantToken(a, { fetch }),
    };
    return { http, video, end: (meetingId: string) => endMeeting(meetingId, { fetch }) };
  }

  /** D21-fix-3 (F1): under a REQUIRED camera a player's FIRST claim makes the participant and reads nothing (it cannot have
   *  been joined yet), so it answers camera_required with the way in; the next claim reads the camera - this file's fake
   *  vendor says ON - and seats. Under an optional camera the first claim seats. Either way: seated, in at most two. */
  async function seatThrough(a: Parameters<typeof seatPlayer>[0], deps: PreflightDeps) {
    const first = await seatPlayer(a, deps);
    return !first.seated && first.reason === "camera_required" ? seatPlayer(a, deps) : first;
  }

  const meetingsOf = (fixtureId: string) =>
    sql<{ meeting_id: string; ended_at: Date | null }[]>`
      select meeting_id, ended_at from fixture_video_meetings where fixture_id = ${fixtureId} order by side`;
  /** Whether each row of the board still names the board's CURRENT pairing (a row marked for retirement, D16 review G1, does not). */
  const samePairOf = async (fixtureId: string) =>
    (
      await sql<{ same: boolean }[]>`
        select (m.home_entrant_id, m.away_entrant_id) is not distinct from (f.home_entrant_id, f.away_entrant_id) as same
          from fixture_video_meetings m join fixtures f on f.id = m.fixture_id
         where m.fixture_id = ${fixtureId} order by m.side`
    ).map((r) => r.same);
  /** A meeting on file for the board's CURRENT pairing (R2-2: a meeting records the pair it was made for). */
  const insertMeeting = (fixtureId: string, meetingId: string, side: "home" | "away" = "home") =>
    sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      select f.id, ${side}, f.org_id, ${meetingId}, f.home_entrant_id, f.away_entrant_id from fixtures f where f.id = ${fixtureId}`;
  /** D16: a player's meeting is their side's. */
  const meetingOfSide = async (fixtureId: string, side: "home" | "away") =>
    (await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${fixtureId} and side = ${side}`)[0]?.meeting_id ?? null;
  const sideOnBoard = (round: BoardSeat[], entrantId: string): "home" | "away" => (round.find((b) => b.home === entrantId) ? "home" : "away");
  const participantsOf = async (fixtureId: string) =>
    (await sql<{ person_id: string | null }[]>`
      select person_id from fixture_video_participants where fixture_id = ${fixtureId} order by created_at, id`).map((r) => r.person_id);
  const reopen = (s: { stageId: string; ownerUserId: string }, now: Date, end: (id: string) => Promise<void>) =>
    openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }, { now, endMeeting: end });

  it("unpair → (sweep) → re-pair → re-open → seat: seated with a participant in a NEW meeting, the old one gone — both camera policies × the old meeting ended by the sweep or still active — counted", async () => {
    let checked = 0;
    for (const policy of ["optional", "required"] as const) {
      for (const ended of [true, false]) {
        const label = `${policy}, old meeting ${ended ? "ended by the sweep" : "still active"}`;
        const rtk = fakeRtk();
        const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: policy });
        const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
        const t0 = new Date();
        expect(await open(s, 1, t0), label).toMatchObject({ opened: true });
        const [b] = await swissRound1(s.stageId);
        const fixtureId = b!.fixtureId;
        // The first pairing: both players check in, so each has a meeting of their own (D16) and a participant in it.
        for (const entrant of [b!.home, b!.away]) {
          const got = await seatThrough({ fixtureId, personId: personOf.get(entrant!)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video });
          expect(got.seated, `${label}: premise — the first pairing seats`).toBe(true);
        }
        const olds = await meetingsOf(fixtureId);
        expect(olds, `${label}: premise — the first pairing's two meetings, one per player`).toHaveLength(2);
        expect(await participantsOf(fixtureId), `${label}: premise — both old players, each in their own`).toHaveLength(2);

        await unpairSwissRound(s.owner, s.stageId);
        let later = new Date(t0.getTime() + 2 * MIN);
        if (ended) {
          later = new Date(t0.getTime() + DEADLINE_AFTER_MS + 2 * MIN);
          // `serialise: false`: an org-scoped pass that must not take the one-pass lock — another file's pass holding
          // it (external-play-sweep.test.ts, in a parallel run) would skip this one, and this one would skip theirs.
          const report = await sweepExternalPlay({ now: later, orgIds: [s.orgId], endMeeting: rtk.end, serialise: false });
          expect(report.meetingsEnded, `${label}: premise — the sweep ended each of the unpaired board's two meetings`).toBe(2);
          expect((await meetingsOf(fixtureId)).map((m) => m.ended_at === null), `${label}: premise — both ended`).toEqual([false, false]);
        }
        await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
        const reopenAt = new Date(later.getTime() + MIN);
        const mark = rtk.http.length;
        expect(await reopen(s, reopenAt, rtk.end), label).toMatchObject({ opened: true });
        // RealtimeKit: an active old meeting is ended at the re-open (kick-all, then INACTIVE); one already ended is
        // not asked again. Both of the board's meetings, each its own two calls.
        for (const old of olds) {
          const atReopen = rtk.http.slice(mark).filter((c) => c.includes(old.meeting_id));
          expect(atReopen, `${label}: the old meeting ${old.meeting_id} at RealtimeKit`).toEqual(
            ended ? [] : [`POST /meetings/${old.meeting_id}/active-session/kick-all`, `PATCH /meetings/${old.meeting_id}`],
          );
        }
        expect(await meetingsOf(fixtureId), `${label}: the old meeting's row went with the re-open`).toEqual([]);

        const re = (await swissRound1(s.stageId)).find((r) => r.fixtureId === fixtureId);
        expect(re, `${label}: premise — the board is re-paired`).toBeDefined();
        const newHome = personOf.get(re!.home!)!;
        const seat = await seatThrough({ fixtureId, personId: newHome }, { now: new Date(reopenAt.getTime() + MIN), video: rtk.video });
        expect(seat, `${label}: the new pairing seats, with a participant`).toMatchObject({
          seated: true,
          participant: { participantId: expect.any(String), authToken: expect.any(String) },
        });
        const fresh = await meetingsOf(fixtureId);
        expect(fresh, `${label}: only the seated player's meeting exists yet - the other side's is made when THEY seat`).toHaveLength(1);
        expect(olds.map((o) => o.meeting_id), `${label}: a fresh meeting, never an old one`).not.toContain(fresh[0]!.meeting_id);
        expect(fresh[0]!.ended_at, label).toBeNull();
        expect(await participantsOf(fixtureId), `${label}: only the new pairing's player — the old participants went with their meeting`).toEqual([newHome]);
        checked += 1;
      }
    }
    expect(checked, "2 policies × 2 states of the old meeting").toBe(4);
  });

  it("m3: the re-open is the R3-1 trigger's second producer — a player who STAYED on a re-paired board reads no participant on file once the re-open retires the old pairing's meeting (so their open room re-claims, ownMeetingRetired), and that re-claim seats them in the NEW meeting under a new id; counted", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "required" });
    const t0 = new Date();
    expect(await open(s, 1, t0)).toMatchObject({ opened: true });
    const boardOf = (round: BoardSeat[], entrantId: string) => round.find((b) => b.home === entrantId || b.away === entrantId)?.fixtureId ?? null;
    const ownOnFile = async (fixtureId: string, userId: string, at: Date) =>
      (await readRoom({ kind: "session", userId }, fixtureId, { now: at, mintRealtime: async () => "rt-token" })).ownParticipantId;

    // The first pairing: every player seated, so every room holds a participant.
    const first = await swissRound1(s.stageId);
    const atSeat = new Date(t0.getTime() + MIN);
    const held = new Map<string, { fixtureId: string; participantId: string; meetingId: string }>();
    for (const p of s.players) {
      const fixtureId = boardOf(first, p.entrantId)!;
      const seat = await seatThrough({ fixtureId, personId: p.personId }, { now: atSeat, video: rtk.video });
      expect(seat, "premise — the first pairing seats, with a participant").toMatchObject({ seated: true, participant: { participantId: expect.any(String) } });
      const participantId = (seat as { participant: { participantId: string } }).participant.participantId;
      expect(await ownOnFile(fixtureId, p.userId, atSeat), "premise — the room reads its own participant").toBe(participantId);
      held.set(p.entrantId, { fixtureId, participantId, meetingId: (await meetingOfSide(fixtureId, sideOnBoard(first, p.entrantId)))! });
    }

    // Unpair → re-pair → the re-open that re-stamps the window (N-2: the game-less boards' meetings go).
    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const reopenAt = new Date(t0.getTime() + 3 * MIN);
    expect(await reopen(s, reopenAt, rtk.end)).toMatchObject({ opened: true });
    const after = await swissRound1(s.stageId);
    const stayers = s.players.filter((p) => boardOf(after, p.entrantId) === held.get(p.entrantId)!.fixtureId);
    expect(stayers.length, "anti-vacuity: the re-pair leaves a player on their board").toBeGreaterThan(0);

    let checked = 0;
    const atRoom = new Date(reopenAt.getTime() + MIN);
    for (const p of stayers) {
      const was = held.get(p.entrantId)!;
      // The R3-1 trigger: the room holds `was.participantId`, the server names none.
      expect(await ownOnFile(was.fixtureId, p.userId, atRoom), "the re-open retired the stayer's participant with its meeting").toBeNull();
      // The room's re-claim (room-shell: once per change, as the re-entry claim does).
      const seat = await seatThrough({ fixtureId: was.fixtureId, personId: p.personId }, { now: atRoom, video: rtk.video });
      expect(seat).toMatchObject({ seated: true, participant: { participantId: expect.any(String) } });
      const now1 = (seat as { participant: { participantId: string } }).participant.participantId;
      expect(now1, "a NEW participant").not.toBe(was.participantId);
      expect(await ownOnFile(was.fixtureId, p.userId, atRoom), "the room reads it back").toBe(now1);
      const nowIn = await meetingOfSide(was.fixtureId, sideOnBoard(after, p.entrantId));
      expect(nowIn, "in a meeting of their (new) side").not.toBeNull();
      expect(nowIn, "in the NEW meeting").not.toBe(was.meetingId);
      checked += 1;
    }
    expect(checked, "anti-vacuity: stayers re-claimed").toBe(stayers.length);
  });

  // D16 review G1: the re-open used to DELETE the old pairing's rows in its transaction and end the rooms after the commit, so a
  // refused end left an ACTIVE vendor room that no row tracked. The rows are now MARKED as belonging to no pairing in the
  // transaction (so no claim reuses the room) and each room is ended after the commit with its row deleted only once the end
  // succeeded; a refusal keeps the row for the next claim or the sweep.
  it("never silent, never blocking, never orphaning: RealtimeKit refusing the old meeting's end is logged by meeting, the re-open and its invites stand, the row stays - and the next claim ends the room and seats the player in a fresh one", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
    const t0 = new Date();
    expect(await open(s, 1, t0)).toMatchObject({ opened: true });
    const [b] = await swissRound1(s.stageId);
    expect(await seatPlayer({ fixtureId: b!.fixtureId, personId: personOf.get(b!.home!)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video }))
      .toMatchObject({ seated: true });
    const [old, ...others] = await meetingsOf(b!.fixtureId);
    expect(others, "premise: one player seated, so one meeting of their own").toEqual([]);
    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      mail.sent.length = 0;
      const refuse = vi.fn(async () => {
        throw new Error("staged: RealtimeKit down");
      });
      expect(await reopen(s, new Date(t0.getTime() + 2 * MIN), refuse)).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });
      expect(refuse.mock.calls).toEqual([[old!.meeting_id]]);
      expect(mail.sent, "every invite went out").toHaveLength(4);
      expect(await meetingsOf(b!.fixtureId), "the row is KEPT, unended: the room is still active upstream and still tracked").toEqual([{ meeting_id: old!.meeting_id, ended_at: null }]);
      const logged = errorSpy.mock.calls.filter((c) => /could not end an earlier pairing's meeting/.test(String(c[1])));
      expect(logged).toHaveLength(1);
      expect(logged[0]![0]).toMatchObject({ meetingId: old!.meeting_id, fixtureId: b!.fixtureId });
    } finally {
      errorSpy.mockRestore();
    }
    // The heal: the player's next claim finds a room made for no pairing, ends it at the vendor, and seats them in a fresh one.
    const mark = rtk.http.length;
    const side = sideOnBoard(await swissRound1(s.stageId), b!.home!);
    const healed = await rtk.video.ensureMeeting(b!.fixtureId, side);
    expect(healed.meetingId, "a fresh room, not the old one").not.toBe(old!.meeting_id);
    expect(rtk.http.slice(mark).filter((c) => c.startsWith("PATCH") && c.includes(old!.meeting_id)), "the old room was ended at the vendor").toHaveLength(1);
    expect(await meetingsOf(b!.fixtureId)).toEqual([{ meeting_id: healed.meetingId, ended_at: null }]);
  });

  // D16 fix-2 R1: the helper ran two statements under READ COMMITTED - delete the ended rows, then mark the active ones - so a room
  // ended BETWEEN them was missed by both (not deleted, not marked), and the same-pair claim that followed was refused
  // VIDEO_MEETING_ENDED by a row nothing would ever heal. The mark now comes first and takes every unspared row, ended or not.
  // Staged without timing: a holder transaction row-locks the meeting, the open's statement on that row parks behind it
  // (pollWaitersBehind), and the holder ends the room and commits - the ending lands inside the open's own two statements.
  it("D16 fix-2 R1: a room that is ENDED while the re-open is working through its statements is still retired - its row is gone, and nobody is asked to end it again", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    const t0 = new Date();
    expect(await open(s, 1, t0)).toMatchObject({ opened: true });
    const [b] = await swissRound1(s.stageId);
    const roomId = `r1-${randomUUID().slice(0, 8)}`;
    await insertMeeting(b!.fixtureId, roomId);
    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const holder = await sql.reserve();
    let outcome: Awaited<ReturnType<typeof reopen>>;
    try {
      await holder`begin`;
      await holder`select meeting_id from fixture_video_meetings where meeting_id = ${roomId} for update`;
      const pid = await backendPid(holder);
      let done = false;
      const racing = reopen(s, new Date(t0.getTime() + 2 * MIN), rtk.end).finally(() => {
        done = true;
      });
      const parked = await pollWaitersBehind(pid, { queryLike: "%update fixture_video_meetings%", finished: () => done });
      expect(parked, "premise: the open's statement on the room is parked behind the holder's row lock").toBeGreaterThanOrEqual(1);
      await holder`update fixture_video_meetings set ended_at = now() where meeting_id = ${roomId}`;
      await holder`commit`;
      outcome = await racing;
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
    expect(outcome).toMatchObject({ opened: true });
    expect(await meetingsOf(b!.fixtureId), "the ended room's row went with the re-open, not left on the old pairing").toEqual([]);
    expect(rtk.http.filter((c) => c.includes(roomId)), "an already-ended room is not asked to end again").toEqual([]);
  });

  it("a re-open ends the room at the vendor BEFORE its row goes, and a room the re-open could not end is ended - and its row deleted - by the sweep's next pass", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
    const t0 = new Date();
    expect(await open(s, 1, t0)).toMatchObject({ opened: true });
    const first = await swissRound1(s.stageId);
    const fixtureId = first[0]!.fixtureId;
    for (const entrant of [first[0]!.home, first[0]!.away]) {
      expect((await seatThrough({ fixtureId, personId: personOf.get(entrant!)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video })).seated).toBe(true);
    }
    const olds = await meetingsOf(fixtureId);
    expect(olds, "premise: a meeting per player").toHaveLength(2);
    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    // The order: when the vendor is asked to end a room, its row is still on file (the one thing that tracks the active room).
    const atEnd: { id: string; onFile: boolean }[] = [];
    expect(
      await reopen(s, new Date(t0.getTime() + 2 * MIN), async (id) => {
        atEnd.push({ id, onFile: (await meetingsOf(fixtureId)).some((m) => m.meeting_id === id) });
        await rtk.end(id);
      }),
    ).toMatchObject({ opened: true });
    expect(atEnd.map((e) => e.id).sort(), "both players' rooms were ended").toEqual(olds.map((m) => m.meeting_id).sort());
    expect(atEnd.map((e) => e.onFile), "each row was still on file when its room was ended").toEqual([true, true]);
    expect(await meetingsOf(fixtureId), "and gone after").toEqual([]);

    // The sweep: a second round of the same shape, the re-open's end refused, then a sweep pass with a working vendor.
    const rtk2 = fakeRtk();
    const s2 = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    const person2 = new Map(s2.players.map((p) => [p.entrantId, p.personId]));
    const u0 = new Date();
    expect(await open(s2, 1, u0)).toMatchObject({ opened: true });
    const [b2] = await swissRound1(s2.stageId);
    expect((await seatThrough({ fixtureId: b2!.fixtureId, personId: person2.get(b2!.home!)! }, { now: new Date(u0.getTime() + MIN), video: rtk2.video })).seated).toBe(true);
    const [kept] = await meetingsOf(b2!.fixtureId);
    await unpairSwissRound(s2.owner, s2.stageId);
    await generateStageFixtures(s2.owner, s2.stageId, { pairing: "rank_adjacent" });
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      expect(await reopen(s2, new Date(u0.getTime() + 2 * MIN), async () => { throw new Error("staged: RealtimeKit down"); })).toMatchObject({ opened: true });
    } finally {
      errorSpy.mockRestore();
    }
    expect(await meetingsOf(b2!.fixtureId), "premise: the refused end kept the row").toEqual([{ meeting_id: kept!.meeting_id, ended_at: null }]);
    const report = await sweepExternalPlay({ now: new Date(u0.getTime() + 3 * MIN), orgIds: [s2.orgId], endMeeting: rtk2.end, serialise: false });
    expect(report.meetingsEnded, "the sweep ended the room the re-open could not").toBe(1);
    expect(rtk2.http.filter((c) => c.startsWith("PATCH") && c.includes(kept!.meeting_id))).toHaveLength(1);
    expect(await meetingsOf(b2!.fixtureId), "and deleted its row").toEqual([]);
  });

  it("the positive pair: a re-open that KEEPS the window (a re-invite) deletes no meeting and ends nothing", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
    const emailOf = new Map(s.players.map((p) => [p.entrantId, p.email]));
    const [b, b2] = await swissRound1(s.stageId);
    // One seat's invite fails, so a later open has a seat left to invite — and the round has invited seats.
    mail.fail.add(emailOf.get(b2!.away!)!);
    const t0 = new Date();
    expect(await open(s, 1, t0)).toMatchObject({ opened: true });
    expect(await seatPlayer({ fixtureId: b!.fixtureId, personId: personOf.get(b!.home!)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video }))
      .toMatchObject({ seated: true });
    const before = await meetingsOf(b!.fixtureId);
    expect(before, "premise: a meeting").toHaveLength(1);
    mail.fail.clear();
    const mark = rtk.http.length;
    expect(await reopen(s, new Date(t0.getTime() + 2 * MIN), rtk.end)).toEqual({ opened: true, invited: 1, retrying: 0, skipped: [] });
    expect(await auditTypes(s.competitionId), "premise: a re-invite, the window kept").toEqual(["external_play.round_opened", "external_play.round_reinvited"]);
    expect(await meetingsOf(b!.fixtureId)).toEqual(before);
    expect(rtk.http.slice(mark), "nothing ended at RealtimeKit").toEqual([]);
  });

  it("the guard: at a re-stamp, a board a game stands behind keeps its meeting; the game-less board's goes", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
    const t0 = new Date();
    expect(await open(s, 1, t0)).toMatchObject({ opened: true });
    const [b] = await swissRound1(s.stageId);
    expect(await seatPlayer({ fixtureId: b!.fixtureId, personId: personOf.get(b!.home!)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video }))
      .toMatchObject({ seated: true });
    await unpairSwissRound(s.owner, s.stageId);
    await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
    const [x, y] = await swissRound1(s.stageId);
    const gameBoard = x!.fixtureId === b!.fixtureId ? y! : x!;
    // A game on file that no open bound (so the round still reads "nobody invited", and the window re-stamps): its
    // meeting is the game's, and must outlive the re-stamp.
    const gameMeeting = `n2-game-${randomUUID().slice(0, 8)}`;
    await sql`
      insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id)
      values (${gameBoard.fixtureId}, ${s.orgId}, 'live', now(), ${`g${randomUUID().slice(0, 7)}`}, 'home', 'w-n2', 'b-n2')`;
    await insertMeeting(gameBoard.fixtureId, gameMeeting);
    const mark = rtk.http.length;
    expect(await reopen(s, new Date(t0.getTime() + 2 * MIN), rtk.end)).toMatchObject({ opened: true });
    expect(await auditTypes(s.competitionId), "premise: the window re-stamped").toEqual(["external_play.round_opened", "external_play.round_reopened"]);
    expect(await meetingsOf(gameBoard.fixtureId), "the game's meeting stands").toEqual([{ meeting_id: gameMeeting, ended_at: null }]);
    expect(await samePairOf(gameBoard.fixtureId), "and is NOT marked for retirement: it still names the board's pairing").toEqual([true]);
    expect(await meetingsOf(b!.fixtureId), "the game-less board's meeting went").toEqual([]);
    expect(rtk.http.slice(mark).some((c) => c.includes(gameMeeting)), "the game's meeting is not ended").toBe(false);
  });

  it("final re-review 2, R2-3: at a re-stamp, every board a game IS or MAY BE on file keeps its meeting — a recorded challenge, a sent create, a LIVE mint claim — and a stale claim or a bare row does not — counted", async () => {
    // Typed from the states T9 leaves (create-game.ts): it claims (mint_claimed_at), marks the send (create_sent_at),
    // then records the challenge. Between the claim and the marker only the live claim says a create is in flight —
    // the sweep's own authority counts it (sweep.ts gameMayBeOnFile); a claim older than MINT_CLAIM_STALE_MS is nobody's.
    type Row = { status: "pending" | "live"; challenge: boolean; sentAgoMs: number | null; claimAgoMs: number | null };
    const CASES: { label: string; row: Row; kept: boolean }[] = [
      { label: "a recorded challenge", row: { status: "live", challenge: true, sentAgoMs: null, claimAgoMs: null }, kept: true },
      { label: "a create sent, no challenge yet", row: { status: "pending", challenge: false, sentAgoMs: 5_000, claimAgoMs: null }, kept: true },
      { label: "a LIVE mint claim, nothing sent yet", row: { status: "pending", challenge: false, sentAgoMs: null, claimAgoMs: MINT_CLAIM_STALE_MS / 3 }, kept: true },
      { label: "a STALE mint claim", row: { status: "pending", challenge: false, sentAgoMs: null, claimAgoMs: MINT_CLAIM_STALE_MS + MIN }, kept: false },
      { label: "a bare pending row", row: { status: "pending", challenge: false, sentAgoMs: null, claimAgoMs: null }, kept: false },
    ];
    let checked = 0;
    for (const c of CASES) {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      const t0 = new Date();
      expect(await open(s, 1, t0), c.label).toMatchObject({ opened: true });
      await unpairSwissRound(s.owner, s.stageId);
      await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
      const [board] = await swissRound1(s.stageId);
      const reopenAt = new Date(t0.getTime() + 2 * MIN);
      const ago = (ms: number | null) => (ms === null ? null : new Date(reopenAt.getTime() - ms));
      const meeting = `r23-${randomUUID().slice(0, 8)}`;
      await sql`
        insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id,
                                           create_sent_at, mint_claimed_at)
        values (${board!.fixtureId}, ${s.orgId}, ${c.row.status}, now(), ${c.row.challenge ? `g${randomUUID().slice(0, 7)}` : null},
                ${c.row.challenge ? "home" : null}, ${c.row.challenge ? "w-r23" : null}, ${c.row.challenge ? "b-r23" : null},
                ${ago(c.row.sentAgoMs)}, ${ago(c.row.claimAgoMs)})`;
      await insertMeeting(board!.fixtureId, meeting);
      const mark = rtk.http.length;
      expect(await reopen(s, reopenAt, rtk.end), c.label).toMatchObject({ opened: true });
      expect(await auditTypes(s.competitionId), `${c.label}: premise — the window re-stamped`).toEqual([
        "external_play.round_opened",
        "external_play.round_reopened",
      ]);
      expect(await meetingsOf(board!.fixtureId), c.label).toEqual(c.kept ? [{ meeting_id: meeting, ended_at: null }] : []);
      expect(await samePairOf(board!.fixtureId), `${c.label}: a spared meeting is not marked for retirement`).toEqual(c.kept ? [true] : []);
      expect(rtk.http.slice(mark).some((h) => h.includes(meeting)), `${c.label}: ended at RealtimeKit`).toBe(!c.kept);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });
  // ── Final re-review 2, R2-2: the meeting is keyed to its PAIRING, not the fixture ───────────────────────────────
  // A re-pair keeps the fixture row, and T16's lobby (lobby.ts, the "Your board" door) seats a newcomer inside the
  // OLD window with no re-open — so a fixture-keyed meeting put the newcomer in the previous pairing's room, with the
  // player who moved away still holding a participant in it. ensureMeeting is the one door every path takes (the
  // lobby, a re-open, a direct link, the arbiter): a meeting made for another pair is replaced, and a new pairing
  // never joins it.
  const paired = async (stageId: string, fixtureId: string) => (await swissRound1(stageId)).find((b) => b.fixtureId === fixtureId)!;
  const vendorCreates = (http: string[]) => http.filter((c) => c === "POST /meetings").length;

  it("R2-2 (a)(b), the lobby path: re-paired with NO re-open, the newcomer seats into a FRESH meeting; neither the player who moved nor the one who stayed is left in a live old room; the stayer re-seats into the same fresh one — both camera policies, counted", async () => {
    let checked = 0;
    for (const policy of ["optional", "required"] as const) {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: policy });
      const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
      const t0 = new Date();
      expect(await open(s, 1, t0), policy).toMatchObject({ opened: true });
      const [b1] = await swissRound1(s.stageId);
      const fixtureId = b1!.fixtureId;
      for (const entrant of [b1!.home, b1!.away]) {
        const got = await seatThrough({ fixtureId, personId: personOf.get(entrant)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video });
        expect(got.seated, `${policy}: premise — the first pairing seats`).toBe(true);
      }
      const olds = await meetingsOf(fixtureId);
      expect(olds, `${policy}: premise — the old pairing's two meetings, one per player`).toHaveLength(2);
      expect(await participantsOf(fixtureId), `${policy}: premise — both old players, each in their own meeting`).toHaveLength(2);

      await unpairSwissRound(s.owner, s.stageId);
      await generateStageFixtures(s.owner, s.stageId, { pairing: "rank_adjacent" });
      const now1 = await paired(s.stageId, fixtureId);
      const before = new Set([b1!.home, b1!.away]);
      const newcomer = [now1.home, now1.away].find((e) => !before.has(e))!;
      const stayer = [now1.home, now1.away].find((e) => before.has(e))!;
      const mover = [b1!.home, b1!.away].find((e) => e !== stayer)!;
      expect([newcomer, stayer, mover].every(Boolean), `${policy}: premise — a newcomer, a stayer, a mover`).toBe(true);
      expect(await auditTypes(s.competitionId), `${policy}: premise — NO re-open: the old window stands`).toEqual(["external_play.round_opened"]);

      // The newcomer comes in through the lobby: the room's seat call, three minutes into the OLD window.
      const mark = rtk.http.length;
      const seat = await seatThrough({ fixtureId, personId: personOf.get(newcomer)! }, { now: new Date(t0.getTime() + 3 * MIN), video: rtk.video });
      expect(seat, `${policy}: the newcomer seats, with a participant`).toMatchObject({ seated: true, participant: { participantId: expect.any(String) } });
      const fresh = await meetingsOf(fixtureId);
      expect(fresh, `${policy}: only the newcomer's own meeting - the stayer's is made when they re-seat`).toHaveLength(1);
      expect(olds.map((o) => o.meeting_id), `${policy}: (a) a fresh meeting, never an old one`).not.toContain(fresh[0]!.meeting_id);
      expect(fresh[0]!.ended_at, policy).toBeNull();
      expect(await participantsOf(fixtureId), `${policy}: (b) only the newcomer — the mover and the stayer went with the old meeting`).toEqual([
        personOf.get(newcomer),
      ]);
      // (b) at RealtimeKit: BOTH old rooms are ended - kick-all, then INACTIVE - so no old participant's token is live in
      // either (D16: the retire ends every stale room of the board, not the one the newcomer asked for).
      for (const old of olds) {
        expect(rtk.http.slice(mark).filter((c) => c.includes(old.meeting_id)), `${policy}: the old meeting ${old.meeting_id} ended at RealtimeKit`).toEqual([
          `POST /meetings/${old.meeting_id}/active-session/kick-all`,
          `PATCH /meetings/${old.meeting_id}`,
        ]);
      }
      expect(vendorCreates(rtk.http.slice(mark)), `${policy}: one meeting created`).toBe(1);

      // The sequence: the stayer re-seats into a meeting of their OWN (one create); a second call of the newcomer creates nothing.
      const mark2 = rtk.http.length;
      expect((await seatThrough({ fixtureId, personId: personOf.get(stayer)! }, { now: new Date(t0.getTime() + 4 * MIN), video: rtk.video })).seated).toBe(true);
      expect((await seatThrough({ fixtureId, personId: personOf.get(newcomer)! }, { now: new Date(t0.getTime() + 4 * MIN), video: rtk.video })).seated).toBe(true);
      const both = await meetingsOf(fixtureId);
      expect(both, `${policy}: the newcomer's meeting stands, and the stayer has their own`).toHaveLength(2);
      expect(both.map((m) => m.meeting_id), `${policy}: the newcomer's meeting is still the fresh one`).toContain(fresh[0]!.meeting_id);
      expect(both.every((m) => m.ended_at === null && !olds.some((o) => o.meeting_id === m.meeting_id)), `${policy}: both live, neither an old one`).toBe(true);
      expect(vendorCreates(rtk.http.slice(mark2)), `${policy}: exactly the stayer's own meeting was created`).toBe(1);
      expect(new Set(await participantsOf(fixtureId)), policy).toEqual(new Set([personOf.get(newcomer), personOf.get(stayer)]));
      expect(await participantsOf(fixtureId), `${policy}: the mover is never in it`).not.toContain(personOf.get(mover));
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("R2-2 (c): a board's own pairing keeps its meeting across reloads — with a game on file and without; nothing is created or ended again — counted", async () => {
    let checked = 0;
    for (const game of [false, true]) {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 2, pairing: "fold", cameraPolicy: "required" });
      const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
      const t0 = new Date();
      expect(await open(s, 1, t0)).toMatchObject({ opened: true });
      const [b] = await swissRound1(s.stageId);
      for (const e of [b!.home, b!.away]) await seatPlayer({ fixtureId: b!.fixtureId, personId: personOf.get(e)! }, { now: new Date(t0.getTime() + MIN), video: rtk.video });
      const onFile = await meetingsOf(b!.fixtureId);
      expect(onFile, `game ${game}: premise - a meeting each`).toHaveLength(2);
      if (game) {
        await sql`
          update fixture_external_play set status = 'live', challenge_id = ${`g${randomUUID().slice(0, 7)}`}, white_side = 'home',
                 white_lichess_id = 'w-r22', black_lichess_id = 'b-r22'
           where fixture_id = ${b!.fixtureId}`;
      }
      const mark = rtk.http.length;
      for (let reload = 0; reload < 3; reload++) {
        for (const e of [b!.home, b!.away]) {
          const got = await seatPlayer({ fixtureId: b!.fixtureId, personId: personOf.get(e)! }, { now: new Date(t0.getTime() + 2 * MIN), video: rtk.video });
          expect(got.seated, `game ${game}, reload ${reload}`).toBe(true);
        }
      }
      expect(await meetingsOf(b!.fixtureId), `game ${game}`).toEqual(onFile);
      expect(vendorCreates(rtk.http.slice(mark)), `game ${game}: no meeting created`).toBe(0);
      expect(rtk.http.slice(mark).filter((c) => c.startsWith("PATCH") || c.includes("kick-all")), `game ${game}: nothing ended`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("R2-2, the guard: a meeting made for ANOTHER pairing that a game IS or MAY BE on file behind is never replaced and never joined — refused by name, each evidence arm; a stale claim is no game, and is replaced — counted", async () => {
    // Cannot happen through the product: M-10's lock (stages.ts lockBoardsRefusingOnlineGames) refuses a re-pair
    // over a game. The stamp is moved by hand to reach the refusal.
    type Arm = { label: string; set: (fixtureId: string) => Promise<unknown>; refused: boolean };
    const ARMS: Arm[] = [
      { label: "a recorded challenge", refused: true, set: (id) => sql`update fixture_external_play set status = 'live', challenge_id = ${`g${randomUUID().slice(0, 7)}`}, white_side = 'home', white_lichess_id = 'w', black_lichess_id = 'b' where fixture_id = ${id}` },
      { label: "a sent create", refused: true, set: (id) => sql`update fixture_external_play set create_sent_at = now() where fixture_id = ${id}` },
      { label: "a live mint claim", refused: true, set: (id) => sql`update fixture_external_play set mint_claimed_at = now() where fixture_id = ${id}` },
      { label: "a stale mint claim", refused: false, set: (id) => sql`update fixture_external_play set mint_claimed_at = now() - interval '1 hour' where fixture_id = ${id}` },
    ];
    let checked = 0;
    for (const arm of ARMS) {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      const t0 = new Date();
      expect(await open(s, 1, t0)).toMatchObject({ opened: true });
      const [b1, b2] = await swissRound1(s.stageId);
      const meetingId = `r22g-${randomUUID().slice(0, 8)}`;
      await insertMeeting(b1!.fixtureId, meetingId);
      // The stamp names another pair (board 2's home in place of board 1's).
      await sql`update fixture_video_meetings set away_entrant_id = ${b2!.home} where fixture_id = ${b1!.fixtureId}`;
      await arm.set(b1!.fixtureId);
      const mark = rtk.http.length;
      if (arm.refused) {
        await expect(rtk.video.ensureMeeting(b1!.fixtureId, "home"), arm.label).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_PAIRING_CHANGED" });
        expect(await meetingsOf(b1!.fixtureId), `${arm.label}: kept`).toEqual([{ meeting_id: meetingId, ended_at: null }]);
        expect(rtk.http.slice(mark), `${arm.label}: RealtimeKit never asked`).toEqual([]);
      } else {
        const got = await rtk.video.ensureMeeting(b1!.fixtureId, "home");
        expect(got.meetingId, arm.label).not.toBe(meetingId);
        expect(await meetingsOf(b1!.fixtureId), arm.label).toEqual([{ meeting_id: got.meetingId, ended_at: null }]);
      }
      checked += 1;
    }
    expect(checked).toBe(ARMS.length);
  });

  it("R2-2, the empty case: a board with no pairing (unpaired) gets no meeting — refused by name, RealtimeKit never asked", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    expect(await open(s, 1, new Date())).toMatchObject({ opened: true });
    const [b1] = await swissRound1(s.stageId);
    await unpairSwissRound(s.owner, s.stageId);
    await expect(rtk.video.ensureMeeting(b1!.fixtureId, "home")).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_UNPAIRED" });
    expect(rtk.http).toEqual([]);
    expect(await meetingsOf(b1!.fixtureId)).toEqual([]);
  });

  it("R2-2, the race: a board changed while a player's participant is being minted stores nothing — each arm alone: its meeting replaced, the board re-paired under its meeting, the player moved off it — refused by name; the retry decides — counted", async () => {
    type Arm = { label: string; change: (b1: BoardSeat, b2: BoardSeat, replacement: string) => Promise<unknown>; retrySeats: boolean };
    const ARMS: Arm[] = [
      {
        // The meeting id moved (another seat retired the stale room and made the pairing's own); the pair and the
        // player stand.
        label: "its meeting replaced",
        retrySeats: true,
        change: async (b1, _b2, replacement) => {
          await sql`delete from fixture_video_meetings where fixture_id = ${b1.fixtureId}`;
          await insertMeeting(b1.fixtureId, replacement);
        },
      },
      {
        // The same meeting row, the player still on the board — but the board's OTHER seat changed: the meeting
        // is an earlier pairing's now.
        label: "the board re-paired under its meeting",
        retrySeats: true,
        change: (b1, b2) => sql`update fixtures set away_entrant_id = ${b2.away} where id = ${b1.fixtureId}`,
      },
      {
        // The same meeting row, and its stamp follows the board — but the player is no longer on it.
        label: "the player moved off the board",
        retrySeats: false,
        change: async (b1, b2) => {
          await sql`update fixtures set home_entrant_id = ${b2.home} where id = ${b1.fixtureId}`;
          await sql`update fixture_video_meetings set home_entrant_id = ${b2.home} where fixture_id = ${b1.fixtureId}`;
        },
      },
    ];
    let checked = 0;
    for (const arm of ARMS) {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
      const t0 = new Date();
      expect(await open(s, 1, t0), arm.label).toMatchObject({ opened: true });
      const [b1, b2] = await swissRound1(s.stageId);
      const personId = personOf.get(b1!.home)!;
      const replacement = `r22r-${randomUUID().slice(0, 8)}`;
      let changed = 0;
      // Staged in the dependency: the mint returns only after the board has changed.
      const video = {
        ...rtk.video,
        addParticipant: async (a: Parameters<typeof rtk.video.addParticipant>[0]) => {
          const minted = await rtk.video.addParticipant(a);
          if (changed === 0) {
            changed += 1;
            await arm.change(b1!, b2!, replacement);
          }
          return minted;
        },
      };
      await expect(seatPlayer({ fixtureId: b1!.fixtureId, personId }, { now: new Date(t0.getTime() + MIN), video }), arm.label).rejects.toMatchObject({
        status: 409,
        code: "VIDEO_MEETING_REPLACED",
      });
      expect(changed, `${arm.label}: premise — the change ran mid-mint`).toBe(1);
      expect(await participantsOf(b1!.fixtureId), `${arm.label}: nothing stored`).toEqual([]);
      const retry = await seatPlayer({ fixtureId: b1!.fixtureId, personId }, { now: new Date(t0.getTime() + MIN), video });
      if (arm.retrySeats) {
        expect(retry.seated, `${arm.label}: the retry seats`).toBe(true);
        const [m] = await meetingsOf(b1!.fixtureId);
        expect(await participantsOf(b1!.fixtureId), `${arm.label}: into the pairing's own meeting`).toEqual([personId]);
        if (arm.label === "its meeting replaced") expect(m!.meeting_id).toBe(replacement);
      } else {
        expect(retry, `${arm.label}: the retry is refused as no player of this board`).toEqual({ seated: false, reason: "not_a_player" });
        expect(await participantsOf(b1!.fixtureId), arm.label).toEqual([]);
      }
      checked += 1;
    }
    expect(checked).toBe(ARMS.length);
  });
  // D16 (§5.6.5, the review's I3): the mint's lock checks TWO inputs, and they refuse different races. Each arm below changes the
  // board during the mint so that exactly ONE input fails and the OTHER would have passed, and asserts that, in SQL, at the moment
  // of the edit - so a pass here cannot be the other guard's refusal. The swapped re-pair fails both and earns no kill credit.
  describe("I3 - the mint lock's two inputs (samePair: the stamp equals the board's entrants; onBoard: the claimant is on the entrant of THEIR side)", () => {
    type Facts = { samePair: boolean; onBoard: boolean };
    type Arm = {
      label: string;
      /** What the board looks like to each input at the moment of the edit, written from the rulebook (§5.6.5), not read off the mint. */
      want: Facts;
      change: (b1: BoardSeat, b2: BoardSeat, personId: string) => Promise<unknown>;
    };
    const ARMS: Arm[] = [
      {
        label: "a re-pair that replaces the OTHER side's entrant while the claimant stays on their own side",
        want: { samePair: false, onBoard: true },
        change: (b1, b2) => sql`update fixtures set away_entrant_id = ${b2.away} where id = ${b1.fixtureId}`,
      },
      {
        label: "a roster edit that moves the claimant to the OTHER side's entrant, the pairing untouched",
        want: { samePair: true, onBoard: false },
        change: (b1, _b2, personId) => sql`update entrant_members set entrant_id = ${b1.away} where entrant_id = ${b1.home} and person_id = ${personId}`,
      },
      {
        // The extra: the same two entrants with the SIDES SWAPPED. Both inputs refuse it, so it proves neither guard alone.
        label: "a re-pair with the same two entrants and the sides swapped",
        want: { samePair: false, onBoard: false },
        change: (b1) => sql`update fixtures set home_entrant_id = away_entrant_id, away_entrant_id = home_entrant_id where id = ${b1.fixtureId}`,
      },
    ];

    /** The two inputs as the spec states them, in plain SQL and TS - NOT the mint's own query. The claimant is the HOME side's. */
    async function inputsNow(fixtureId: string, personId: string): Promise<Facts> {
      const [m] = await sql<{ home: string | null; away: string | null }[]>`
        select home_entrant_id as home, away_entrant_id as away from fixture_video_meetings where fixture_id = ${fixtureId} and side = 'home'`;
      const [f] = await sql<{ home: string | null; away: string | null }[]>`
        select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
      const members = (
        await sql<{ entrant_id: string }[]>`select entrant_id from entrant_members where person_id = ${personId}`
      ).map((x) => x.entrant_id);
      return {
        samePair: m!.home === f!.home && m!.away === f!.away,
        // The claimant plays the HOME side: they must be a member of the entrant on the home side NOW.
        onBoard: f!.home !== null && members.includes(f!.home),
      };
    }

    async function raceOf(arm: Arm) {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
      const t0 = new Date();
      expect(await open(s, 1, t0), arm.label).toMatchObject({ opened: true });
      const [b1, b2] = await swissRound1(s.stageId);
      const personId = personOf.get(b1!.home)!;
      const seen: Facts[] = [];
      let minted = 0;
      const video = {
        ...rtk.video,
        addParticipant: async (a: Parameters<typeof rtk.video.addParticipant>[0]) => {
          minted += 1;
          const out = await rtk.video.addParticipant(a);
          // Before the edit: the control - both inputs hold, so the lock would have stored it.
          seen.push(await inputsNow(b1!.fixtureId, personId));
          await arm.change(b1!, b2!, personId);
          seen.push(await inputsNow(b1!.fixtureId, personId));
          return out;
        },
      };
      const result = await seatPlayer({ fixtureId: b1!.fixtureId, personId }, { now: new Date(t0.getTime() + MIN), video }).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      return { b1: b1!, personId, seen, minted, result };
    }

    it("each arm is refused by the lock (VIDEO_MEETING_REPLACED) and stores nothing, with exactly the inputs the arm names failing - and the control before the edit holding both - counted", async () => {
      let checked = 0;
      for (const arm of ARMS) {
        const r = await raceOf(arm);
        expect(r.minted, `${arm.label}: the mint was reached once - the refusal is the lock's`).toBe(1);
        expect(r.seen[0], `${arm.label}: before the edit both inputs hold`).toEqual({ samePair: true, onBoard: true });
        expect(r.seen[1], `${arm.label}: at the moment of the edit`).toEqual(arm.want);
        expect(r.result.ok, arm.label).toBe(false);
        expect((r.result as { err: { status?: number; code?: string } }).err, arm.label).toMatchObject({ status: 409, code: "VIDEO_MEETING_REPLACED" });
        expect(await participantsOf(r.b1.fixtureId), `${arm.label}: nothing stored`).toEqual([]);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every arm").toBe(ARMS.length);
      // Each of the first two fails exactly one input; the third fails both - so only the first two can kill a mutant.
      expect(ARMS.map((a) => Number(!a.want.samePair) + Number(!a.want.onBoard))).toEqual([1, 1, 2]);
    });

    it("the positive pair: an edit that touches neither input (the OTHER board) stores the participant", async () => {
      const rtk = fakeRtk();
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      const personOf = new Map(s.players.map((p) => [p.entrantId, p.personId]));
      const t0 = new Date();
      expect(await open(s, 1, t0)).toMatchObject({ opened: true });
      const [b1, b2] = await swissRound1(s.stageId);
      const personId = personOf.get(b1!.home)!;
      const video = {
        ...rtk.video,
        addParticipant: async (a: Parameters<typeof rtk.video.addParticipant>[0]) => {
          const out = await rtk.video.addParticipant(a);
          await sql`update fixtures set status = status where id = ${b2!.fixtureId}`; // a write to another board
          return out;
        },
      };
      await seatPlayer({ fixtureId: b1!.fixtureId, personId }, { now: new Date(t0.getTime() + MIN), video });
      expect(await participantsOf(b1!.fixtureId)).toEqual([personId]);
    });
  });

  // D16 review G1 changed the retire's shape: it ENDS a stale room first and deletes the row only after the end succeeded, so the
  // old "judge and delete in one statement" staging (a SHARE lock parking the delete) no longer describes it. The race that is
  // left is the vendor round trip itself, and the test stages it there: the world changes while the stale room's end is in flight.
  it("R2-2, the retire's delete is judged by the row's own id and the pairing: a stale meeting that the pairing's own seat has just replaced, or that a game has just appeared behind, is not deleted - staged at the stale room's end, each arm, counted", async () => {
    type Arm = { label: string; land: (fixtureId: string, fresh: string) => Promise<unknown>; fresh: boolean };
    const ARMS: Arm[] = [
      {
        label: "a concurrent seat made the pairing's own meeting",
        fresh: true,
        land: async (fixtureId, fresh) => {
          await sql`delete from fixture_video_meetings where fixture_id = ${fixtureId}`;
          await sql`
            insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
            select f.id, 'home', f.org_id, ${fresh}, f.home_entrant_id, f.away_entrant_id from fixtures f where f.id = ${fixtureId}`;
        },
      },
      {
        label: "a game appeared behind the stale meeting",
        fresh: false,
        land: (fixtureId) => sql`update fixture_external_play set create_sent_at = now() where fixture_id = ${fixtureId}`,
      },
    ];
    let checked = 0;
    for (const arm of ARMS) {
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      expect(await open(s, 1, new Date()), arm.label).toMatchObject({ opened: true });
      const [b1, b2] = await swissRound1(s.stageId);
      const stale = `r22s-${randomUUID().slice(0, 8)}`;
      const fresh = `r22f-${randomUUID().slice(0, 8)}`;
      await insertMeeting(b1!.fixtureId, stale);
      await sql`update fixture_video_meetings set away_entrant_id = ${b2!.home} where fixture_id = ${b1!.fixtureId}`;
      let landed = 0;
      const rtk = fakeRtk({
        onEnd: async (id) => {
          if (id !== stale) return;
          landed += 1;
          await arm.land(b1!.fixtureId, fresh);
        },
      });
      const outcome = await rtk.video.ensureMeeting(b1!.fixtureId, "home").then(
        (ok) => ({ ok }),
        (err: unknown) => ({ err }),
      );
      expect(landed, `${arm.label}: premise - the world changed while the stale room's end was in flight`).toBe(1);
      expect(rtk.http.filter((c) => c.includes(`/meetings/${stale}`) && c.startsWith("PATCH")), `${arm.label}: the stale room was asked to end`).toHaveLength(1);
      if (arm.fresh) {
        expect(outcome, `${arm.label}: the pairing's own meeting is handed out`).toEqual({ ok: { meetingId: fresh } });
        expect(await meetingsOf(b1!.fixtureId), `${arm.label}: and kept, unended`).toEqual([{ meeting_id: fresh, ended_at: null }]);
        expect(rtk.http.filter((c) => c.includes(fresh)), `${arm.label}: and never touched at the vendor`).toEqual([]);
      } else {
        expect(outcome, arm.label).toMatchObject({ err: { status: 409, code: "VIDEO_MEETING_PAIRING_CHANGED" } });
        // The row of a board with a game behind it is never deleted. Its room WAS ended: the guard and the vendor call are not
        // one atomic step, and a game appearing inside that round trip is the residual window (it cannot arise in play: a game
        // needs both players seated in their own side's CURRENT meeting, and a stale row on a side means that side was not).
        expect(await meetingsOf(b1!.fixtureId), `${arm.label}: the game's row is kept`).toEqual([{ meeting_id: stale, ended_at: expect.any(Date) }]);
      }
      checked += 1;
    }
    expect(checked).toBe(ARMS.length);
  });

  it("R2-2, a lost create race to a meeting made for ANOTHER pairing is never handed out — no game behind it: unavailable (a retry heals); a game: refused by name — counted", async () => {
    let checked = 0;
    for (const game of [false, true]) {
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
      expect(await open(s, 1, new Date())).toMatchObject({ opened: true });
      const [b1, b2] = await swissRound1(s.stageId);
      const other = `r22o-${randomUUID().slice(0, 8)}`;
      let landed = 0;
      // Staged at the create's own round trip: another pairing's meeting lands on the board while ours is made.
      const rtk = fakeRtk({
        onCreate: async () => {
          if (landed++ > 0) return;
          await insertMeeting(b1!.fixtureId, other);
          await sql`update fixture_video_meetings set away_entrant_id = ${b2!.home} where fixture_id = ${b1!.fixtureId}`;
          if (game) await sql`update fixture_external_play set create_sent_at = now() where fixture_id = ${b1!.fixtureId}`;
        },
      });
      const got = rtk.video.ensureMeeting(b1!.fixtureId, "home");
      if (game) await expect(got, "a game").rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_PAIRING_CHANGED" });
      else await expect(got, "no game").rejects.toMatchObject({ name: "RealtimeKitError", status: 503, code: "unavailable" });
      expect(landed, "premise — the other meeting landed mid-create").toBe(1);
      expect(await meetingsOf(b1!.fixtureId), `game ${game}: the other meeting stands`).toEqual([{ meeting_id: other, ended_at: null }]);
      if (!game) {
        // The retry retires it and makes the pairing's own.
        const retry = await rtk.video.ensureMeeting(b1!.fixtureId, "home");
        expect(retry.meetingId).not.toBe(other);
        expect(await meetingsOf(b1!.fixtureId)).toEqual([{ meeting_id: retry.meetingId, ended_at: null }]);
      }
      checked += 1;
    }
    expect(checked).toBe(2);
  });
  it("R2-2: an ENDED meeting of another pairing (no game) is retired without asking RealtimeKit again, and the pairing gets its own — never VIDEO_MEETING_ENDED", async () => {
    const rtk = fakeRtk();
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional" });
    expect(await open(s, 1, new Date())).toMatchObject({ opened: true });
    const [b1, b2] = await swissRound1(s.stageId);
    const ended = `r22e-${randomUUID().slice(0, 8)}`;
    await insertMeeting(b1!.fixtureId, ended);
    await sql`update fixture_video_meetings set away_entrant_id = ${b2!.home}, ended_at = now() where fixture_id = ${b1!.fixtureId}`;
    const got = await rtk.video.ensureMeeting(b1!.fixtureId, "home");
    expect(got.meetingId).not.toBe(ended);
    expect(await meetingsOf(b1!.fixtureId)).toEqual([{ meeting_id: got.meetingId, ended_at: null }]);
    expect(rtk.http.filter((c) => c.includes(ended)), "an ended meeting is not asked again").toEqual([]);
    expect(rtk.http.filter((c) => c === "POST /meetings")).toHaveLength(1);
  });
});

// T17B fix 2, D17 (owner ruling 2026-10-14 "re-arm"; controller ruling option 1). A league board the organiser
// closed with No result (core.abandon; the bridge `finished`, no game) and then VOIDED is playable again, and its
// room says "If it's replayed, it opens here again" (D10). The void leaves the row: deleting it there handed the
// board to the sweep, whose no-show then wrote a double walkover over it at once (measured). The re-arm is the
// organiser's re-open: under the division lock, in the open's transaction, a playable board's finished, GAME-LESS
// row (no recorded challenge, no create marker, no move on file) is reset, and the board invited afresh. The window:
// the narrow exception to review I1 — the round is re-stamped only when every OTHER bound board is decided; with a
// neighbour still playable the board is `window_closed` exactly as today, and its row is left alone.
describe.skipIf(!HAS_DB)("openRound — a board voided after No result is re-armed by the RE-OPEN, never by the void (T17B fix 2, D17)", () => {
  const lastEvent = async (fixtureId: string) =>
    (await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${fixtureId} order by seq desc limit 1`)[0]!;
  /** The arbiter's No result (the real resolve), then the organiser's undo on the match page (the real void). */
  async function noResultThenVoid(r: SeedOnlineChessRoundResult, fixtureId: string) {
    expect(await resolveExternalPlay(r.owner, fixtureId, "no_result")).toEqual({ status: "finished" });
    const last = await lastEvent(fixtureId);
    await scoreEvent(r.owner, fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
    expect(["scheduled", "in_play"], "premise: the void made the board playable again").toContain(fx!.status);
    const b = await bridgeOf(fixtureId);
    expect([b?.status, b?.challenge_id, b?.create_sent_at], "premise: closed, no game").toEqual(["finished", null, null]);
  }
  /** The neighbour DECIDED on the pad (the real scoring usecase): a Start, then a result. */
  async function decide(r: SeedOnlineChessRoundResult, b: SeedOnlineChessRoundResult["boards"][number]) {
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: b.home.entrantId, method: "resign" } });
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${b.fixtureId}`;
    expect(["scheduled", "in_play"], "premise: the neighbour is decided").not.toContain(fx!.status);
  }
  const sweep = (r: SeedOnlineChessRoundResult) =>
    sweepExternalPlay({ orgIds: [r.orgId], serialise: false, endMeeting: async () => undefined });
  const noShowEvents = async (fixtureId: string) =>
    (await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId} and idempotency_key like 'extplay-noshow:%'`)[0]!.n;
  /** A round of two boards opened long enough ago that its window has closed. */
  async function closedRound() {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const t0 = new Date(Date.now() - DEADLINE_AFTER_MS - 10 * MIN);
    expect(await open(r, 1, t0)).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });
    const [a, b] = r.boards as [SeedOnlineChessRoundResult["boards"][number], SeedOnlineChessRoundResult["boards"][number]];
    return { r, t0, a, b };
  }

  it("the measured sequence: No result → void → a sweep pass forfeits NOTHING — the closed row keeps the board out of the no-show", async () => {
    const { r, a, b } = await closedRound();
    await decide(r, b);
    await noResultThenVoid(r, a.fixtureId);
    const report = await sweep(r);
    expect(report.noShows, "no walkover over a voided No result").toBe(0);
    expect(await noShowEvents(a.fixtureId)).toBe(0);
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${a.fixtureId}`;
    expect(["scheduled", "in_play"]).toContain(fx!.status);
    expect((await bridgeOf(a.fixtureId))?.status, "the void left the row").toBe("finished");
  });

  it("void → re-open, every neighbour decided: the round is re-stamped, the board reset and invited, and a NEW game is made", async () => {
    const { r, t0, a, b } = await closedRound();
    await decide(r, b);
    await noResultThenVoid(r, a.fixtureId);
    mail.sent.length = 0;
    const now = new Date();

    expect(await open(r, 1, now)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect(sentTo(), "only the re-armed board's players").toEqual([a.home.email, a.away.email].sort());
    const [stamp] = await stampRows(r.stageId);
    expect(stamp!.opened_at.getTime(), "a fresh window").toBe(now.getTime());
    expect(stamp!.opened_at.getTime()).not.toBe(t0.getTime());
    expect(await auditTypes(r.competitionId)).toEqual(["external_play.round_opened", "external_play.round_reopened"]);
    const fresh = await bridgeOf(a.fixtureId);
    expect(fresh).toMatchObject({ status: "pending", challenge_id: null, create_sent_at: null, round_open_id: stamp!.id });
    expect(fresh!.white_emailed_at !== null && fresh!.black_emailed_at !== null, "both seats invited").toBe(true);
    // The room follows the new bridge: not closed any more, and open in the new window.
    const room = await readRoom({ kind: "session", userId: a.home.userId }, a.fixtureId);
    expect([room.boardClosed, room.phase, room.deadline]).toEqual([false, "open", new Date(now.getTime() + DEADLINE_AFTER_MS).toISOString()]);
    // The real T9 create makes the replay's game.
    const made = await createGameIfReady(a.fixtureId, { publish: async () => undefined, now: new Date(now.getTime() + MIN) });
    expect(made.created, "a new game for the replay").toBe(true);
    expect((await bridgeOf(a.fixtureId))!.challenge_id).not.toBeNull();
    // ONCE: the next open finds nothing to re-arm, mails nobody, moves no window.
    mail.sent.length = 0;
    expect(await open(r, 1, new Date(now.getTime() + 2 * MIN))).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(mail.sent).toHaveLength(0);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(now.getTime());
  });

  it("I1's direction: a neighbour still PLAYABLE ⇒ window_closed, the window does not move, the closed row is left alone, and the sweep forfeits only the real no-show", async () => {
    const { r, t0, a, b } = await closedRound();
    await noResultThenVoid(r, a.fixtureId);
    const before = await sql`select * from fixture_external_play where fixture_id = ${a.fixtureId}`;
    mail.sent.length = 0;

    expect(await open(r, 1, new Date())).toEqual({
      opened: false,
      reason: "already_open",
      skipped: [{ fixtureId: a.fixtureId, reason: "window_closed" }],
    });
    expect(mail.sent).toHaveLength(0);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(t0.getTime());
    expect(await sql`select * from fixture_external_play where fixture_id = ${a.fixtureId}`, "not reset: it would be forfeited").toEqual(before);
    // The pass reaches this round: the neighbour, invited and absent past the deadline, IS the no-show it walks over.
    expect((await sweep(r)).noShows, "the neighbour only").toBe(1);
    expect(await noShowEvents(b.fixtureId), "anti-vacuity: the no-show job ran here").toBe(1);
    expect(await noShowEvents(a.fixtureId), "never the closed board").toBe(0);
  });

  it("the positive pair inside the window: a neighbour still playable, the window still open ⇒ the board is reset and re-invited, and the window does not move", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const t0 = new Date(Date.now() - 5 * MIN);
    await open(r, 1, t0);
    const a = r.boards[0]!;
    await noResultThenVoid(r, a.fixtureId);
    mail.sent.length = 0;

    expect(await open(r, 1, new Date())).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    expect(sentTo()).toEqual([a.home.email, a.away.email].sort());
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime(), "the window did not move").toBe(t0.getTime());
    expect(await auditTypes(r.competitionId)).toEqual(["external_play.round_opened", "external_play.round_reinvited"]);
    expect((await bridgeOf(a.fixtureId))?.status).toBe("pending");
  });

  it("a board whose game IS or MAY BE on file is never reset by a re-open — a recorded challenge, a create marker, a move (counted)", async () => {
    const played: [string, (r: SeedOnlineChessRoundResult, fixtureId: string) => Promise<void>][] = [
      [
        "a recorded challenge (the real T9 create, then the arbiter's No result)",
        async (r, f) => {
          const made = await createGameIfReady(f, { publish: async () => undefined, now: new Date(Date.now() - DEADLINE_AFTER_MS - 9 * MIN) });
          expect(made.created, "premise: the game was made").toBe(true);
          expect(await resolveExternalPlay(r.owner, f, "no_result")).toEqual({ status: "finished" });
        },
      ],
      [
        "a create marker with no challenge (an outcome unknown, closed by the arbiter)",
        async (r, f) => {
          expect(await resolveExternalPlay(r.owner, f, "no_result")).toEqual({ status: "finished" });
          await sql`update fixture_external_play set create_sent_at = now() - interval '30 minutes' where fixture_id = ${f}`;
        },
      ],
      [
        "a move on file with no challenge (the guard's own case: a row no writer leaves, refused all the same)",
        async (r, f) => {
          expect(await resolveExternalPlay(r.owner, f, "no_result")).toEqual({ status: "finished" });
          await sql`update fixture_external_play set moves_uci = '["e2e4"]'::jsonb, move_count = 1 where fixture_id = ${f}`;
        },
      ],
    ];
    let checked = 0;
    for (const [why, become] of played) {
      const { r, t0, a, b } = await closedRound();
      await decide(r, b);
      await become(r, a.fixtureId);
      const last = await lastEvent(a.fixtureId);
      await scoreEvent(r.owner, a.fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
      const before = await sql`select * from fixture_external_play where fixture_id = ${a.fixtureId}`;
      expect(before[0]!.status, `${why}: premise — closed`).toBe("finished");
      mail.sent.length = 0;
      expect(await open(r, 1, new Date()), why).toEqual({ opened: false, reason: "already_open", skipped: [] });
      expect(await sql`select * from fixture_external_play where fixture_id = ${a.fixtureId}`, `${why}: untouched`).toEqual(before);
      expect(mail.sent, why).toHaveLength(0);
      expect((await stampRows(r.stageId))[0]!.opened_at.getTime(), `${why}: no window moved`).toBe(t0.getTime());
      checked += 1;
    }
    expect(checked, "anti-vacuity: every kind of game evidence").toBe(played.length);
  });

  it("a decided neighbour's player link still resolves after the re-stamp — and still shows its result", async () => {
    const { r, t0, a, b } = await closedRound();
    await decide(r, b);
    const [row] = await stampRows(r.stageId);
    const token = await mintMatchRoomToken({ fixtureId: b.fixtureId, personId: b.away.personId, roundOpenId: row!.id, roundOpenedAt: t0.toISOString() });
    const shown = await readRoom({ kind: "token", token }, b.fixtureId);
    expect(shown.result, "premise: the neighbour's room shows its result").not.toBeNull();
    await noResultThenVoid(r, a.fixtureId);
    expect((await open(r, 1, new Date())).opened, "premise: re-stamped").toBe(true);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).not.toBe(t0.getTime());

    const after = await readRoom({ kind: "token", token }, b.fixtureId);
    expect(after.result, "the link minted for the first window still opens the decided room").toEqual(shown.result);
  });

  it("a board HELD for the organiser is never re-armed — the hold is theirs to settle", async () => {
    const { r, t0, a, b } = await closedRound();
    await decide(r, b);
    const held = await holdForOrganiser({ fixtureId: a.fixtureId, reason: "not_started" });
    expect(held.wrote, "premise: held").toBe("needs_organiser");
    const before = await sql`select * from fixture_external_play where fixture_id = ${a.fixtureId}`;
    mail.sent.length = 0;
    expect(await open(r, 1, new Date())).toEqual({ opened: false, reason: "already_open", skipped: [] });
    expect(await sql`select * from fixture_external_play where fixture_id = ${a.fixtureId}`).toEqual(before);
    expect(mail.sent).toHaveLength(0);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime()).toBe(t0.getTime());
  });

  it("the re-arm is decided UNDER the division lock: a re-open committed while this one waited is seen, and nobody is mailed twice", async () => {
    // Staged, not raced: another session holds the division lock FIRST and commits what a first re-open writes — the
    // board's row reset onto the open with both seats stamped, the window re-stamped. This open must be seen WAITING
    // on the lock, and then find nothing to re-arm.
    const { r, a, b } = await closedRound();
    await decide(r, b);
    await noResultThenVoid(r, a.fixtureId);
    const [stamp] = await stampRows(r.stageId);
    const holder = await sql.reserve();
    const holderPid = await backendPid(holder);
    const firstAt = new Date();
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + r.divisionId}))`;
      await holder`delete from fixture_external_play where fixture_id = ${a.fixtureId}`;
      await holder`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, round_open_id, white_emailed_at, black_emailed_at)
        select id, org_id, scheduled_at, ${stamp!.id}, ${firstAt}, ${firstAt} from fixtures where id = ${a.fixtureId}`;
      await holder`update stage_round_opens set opened_at = ${firstAt} where id = ${stamp!.id}`;
      mail.sent.length = 0;
      const pending = open(r, 1, new Date(firstAt.getTime() + MIN)).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      const waited = (await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%" })) > 0;
      expect(waited, "the re-open never waited on the division lock").toBe(true);
      await holder`commit`;
      const out = await pending;
      expect(out).toEqual({ ok: true, v: { opened: false, reason: "already_open", skipped: [] } });
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
    expect(mail.sent, "nobody mailed twice").toHaveLength(0);
    const row = await bridgeOf(a.fixtureId);
    expect([row?.status, row?.white_emailed_at?.getTime(), row?.black_emailed_at?.getTime()], "the first re-open's row stands").toEqual([
      "pending",
      firstAt.getTime(),
      firstAt.getTime(),
    ]);
    expect((await stampRows(r.stageId))[0]!.opened_at.getTime(), "the first re-open's window stands").toBe(firstAt.getTime());
  });

  it("the re-armed board's meeting from the closed pairing goes — one still active is ended at RealtimeKit after the commit, an ended one is not asked again (counted)", async () => {
    let checked = 0;
    for (const endedAt of [null, new Date(Date.now() - MIN)] as const) {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
      const t0 = new Date(Date.now() - 5 * MIN);
      await open(r, 1, t0);
      const a = r.boards[0]!;
      const meetingId = `mtg-${randomUUID().slice(0, 12)}`;
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at)
        values (${a.fixtureId}, 'home', ${r.orgId}, ${meetingId}, ${a.home.entrantId}, ${a.away.entrantId}, ${endedAt})`;
      await noResultThenVoid(r, a.fixtureId);
      const ended: string[] = [];
      expect(
        await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: async (id) => void ended.push(id) }),
        "premise: re-invited inside the window",
      ).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
      const rows = await sql`select meeting_id from fixture_video_meetings where fixture_id = ${a.fixtureId}`;
      expect(rows, "the closed pairing's meeting is gone").toEqual([]);
      expect(ended, endedAt === null ? "active: ended at the vendor" : "already ended: not asked again").toEqual(endedAt === null ? [meetingId] : []);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the re-armed board's meeting whose end is REFUSED keeps its row (unended, marked for retirement): a re-arm never orphans an active room", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    await open(r, 1, new Date(Date.now() - 5 * MIN));
    const a = r.boards[0]!;
    const meetingId = `mtg-${randomUUID().slice(0, 12)}`;
    await sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
      values (${a.fixtureId}, 'home', ${r.orgId}, ${meetingId}, ${a.home.entrantId}, ${a.away.entrantId})`;
    await noResultThenVoid(r, a.fixtureId);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      expect(
        await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: async () => { throw new Error("test: down"); } }),
      ).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    } finally {
      error.mockRestore();
    }
    expect(await sql`select meeting_id, ended_at from fixture_video_meetings where fixture_id = ${a.fixtureId}`, "tracked, unended").toEqual([
      { meeting_id: meetingId, ended_at: null },
    ]);
    // The row names no pairing, so nothing reuses the room: the next retire (a claim, or the sweep) takes it.
    const ended: string[] = [];
    const report = await sweepExternalPlay({
      orgIds: [r.orgId],
      serialise: false,
      // The real endMeeting stamps the row after the vendor calls (a row stamped ended parks nothing when its delete follows - V460).
      endMeeting: async (id) => {
        ended.push(id);
        await sql`update fixture_video_meetings set ended_at = now() where meeting_id = ${id} and ended_at is null`;
      },
    });
    expect([ended, report.meetingsEnded]).toEqual([[meetingId], 1]);
    expect(await sql`select meeting_id from fixture_video_meetings where fixture_id = ${a.fixtureId}`).toEqual([]);
    expect(await sql`select meeting_id from video_rooms_to_end where org_id = ${r.orgId}`, "the retire's delete of an ended row parks nothing").toEqual([]);
  });

  // D16 review G1 (was D21-fix m3): a refused end KEEPS the row now, so the log is no longer the only trace - but it is still
  // how it is noticed. A refusal by the platform's call budget is not a fault (warn); anything else still is (error).
  it("a stale meeting's end the call budget DEFERS is logged as a warning, a real failure still as an error - and the open succeeds either way (counted)", async () => {
    const message = /could not end an earlier pairing's meeting/;
    let checked = 0;
    for (const failure of [new RealtimeKitDeferred("test: the call budget is spent"), new Error("test: the vendor fell over")]) {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
      try {
        const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
        await open(r, 1, new Date(Date.now() - 5 * MIN));
        const a = r.boards[0]!;
        const meetingId = `mtg-${randomUUID().slice(0, 12)}`;
        await sql`
          insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
          values (${a.fixtureId}, 'home', ${r.orgId}, ${meetingId}, ${a.home.entrantId}, ${a.away.entrantId})`;
        await noResultThenVoid(r, a.fixtureId);
        const out = await openRound(
          { stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId },
          { endMeeting: async () => { throw failure; } },
        );
        expect(out, "the open is never blocked by it").toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
        const logged = (spy: typeof warn) => spy.mock.calls.filter((c) => message.test(String(c[1]))).length;
        const deferred = failure instanceof RealtimeKitDeferred;
        expect([logged(warn), logged(error)], deferred ? "deferred: a warning" : "a failure: an error").toEqual(deferred ? [1, 0] : [0, 1]);
        checked += 1;
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    }
    expect(checked).toBe(2);
  });
});

// ─── Whether a round staggers is decided at the open and STORED (spec §3.2.1; the review's I4; capacity test 5) ────────────────
// Every instant is written from the constants (T + batch x CHECKIN_BATCH_GAP_MS), never read back from boardAnchor.
describe.skipIf(!HAS_DB)("openRound — the stored `staggered` flag decides the batches", () => {
  const S = CHECKIN_BATCH_SIZE;
  const T0 = new Date("2026-10-01T12:00:30.000Z");
  const seedRanked = (cameraPolicy?: "off" | "optional" | "required") =>
    seedOnlineChessRoundWithRankedBoard({ roundNo: 1, ...(cameraPolicy ? { cameraPolicy } : {}) }, 2 * S);
  const storedFlag = async (stageId: string) =>
    (await sql<{ staggered: boolean }[]>`select staggered from stage_round_opens where stage_id = ${stageId} and round_no = 1`)[0]!.staggered;
  const anchorOf = async (fixtureId: string) => (await boardOpenFor(sql, fixtureId))!.anchor;

  it("(a) an `off` round is ONE batch: nothing is staggered, and the board at rank 2S opens at T like board 1", async () => {
    const r = await seedRanked("off");
    await open(r, 1, T0);
    expect(await storedFlag(r.stageId)).toBe(false);
    const a = await anchorOf(r.ranked.fixtureId);
    expect([a.batch, a.at.getTime()]).toEqual([0, T0.getTime()]);
    expect(windowFor(a)).toEqual(windowFor(await anchorOf(r.boards[0]!.fixtureId)));
  });

  it("(a, pair) required and optional round ARE staggered: the same board sits in batch 2, 2 x gap after T", async () => {
    let checked = 0;
    for (const policy of ["required", "optional"] as const) {
      const r = await seedRanked(policy);
      await open(r, 1, T0);
      expect(await storedFlag(r.stageId), policy).toBe(true);
      const a = await anchorOf(r.ranked.fixtureId);
      expect([a.batch, a.at.getTime() - T0.getTime()], policy).toEqual([2, 2 * CHECKIN_BATCH_GAP_MS]);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("(b) a `required` round DOWNGRADED to off after the open keeps batch 2's open time and deadline - and they are not T's", async () => {
    const r = await seedRanked("required");
    await open(r, 1, T0);
    const before = windowFor(await anchorOf(r.ranked.fixtureId));
    await patchDivision(r.owner, r.divisionId, { camera_policy: "off" });
    const [d] = await sql<{ camera_policy: string | null }[]>`select camera_policy from divisions where id = ${r.divisionId}`;
    expect(d!.camera_policy, "premise: the downgrade landed").toBe("off");
    const after = windowFor(await anchorOf(r.ranked.fixtureId));
    expect(after, "the window of a board that was told its time does not move").toEqual(before);
    expect(after.opensAt.getTime(), "batch 2 opens 2 x gap after T").toBe(T0.getTime() + 2 * CHECKIN_BATCH_GAP_MS);
    expect(after.deadline.getTime()).toBe(T0.getTime() + 2 * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS);
    expect(after.opensAt.getTime(), "the case where the wrong answer is not the right one's constant").not.toBe(T0.getTime());
  });

  it("(c) a policy change BEFORE the open counts: required -> off before the first press stores false", async () => {
    const r = await seedRanked("required");
    await patchDivision(r.owner, r.divisionId, { camera_policy: "off" });
    await open(r, 1, T0);
    expect(await storedFlag(r.stageId)).toBe(false);
  });

  it("(c) a RE-OPEN decides afresh: a round nobody was invited into, re-stamped after a downgrade, stores the new answer", async () => {
    const r = await seedRanked("required");
    for (const b of [...r.boards, r.ranked]) mail.fail.add(b.home.email).add(b.away.email);
    await open(r, 1, T0);
    expect(await storedFlag(r.stageId), "premise: the first open staggered").toBe(true);
    expect((await bridgeOf(r.ranked.fixtureId))?.round_open_id, "premise: every send failed, nobody is bound").toBeNull();
    await patchDivision(r.owner, r.divisionId, { camera_policy: "off" });
    mail.fail.clear();
    const T1 = new Date(T0.getTime() + MIN);
    expect(await open(r, 1, T1)).toMatchObject({ opened: true });
    expect(await storedFlag(r.stageId), "the re-stamp decided afresh from the live policy").toBe(false);
    const a = await anchorOf(r.ranked.fixtureId);
    expect([a.batch, a.at.getTime()], "and the board is now an unbatched one, from the new T").toEqual([0, T1.getTime()]);
  });

  it("(d) a row from before the delta: the column defaults to false and not-null, so every board opens at T as it did", async () => {
    const [col] = await sql<{ column_default: string | null; is_nullable: string }[]>`
      select column_default, is_nullable from information_schema.columns
       where table_name = 'stage_round_opens' and column_name = 'staggered'`;
    expect([col?.column_default, col?.is_nullable]).toEqual(["false", "NO"]);
    const r = await seedRanked("required");
    // A pre-delta row: inserted WITHOUT naming the column (what the migration's default gave every existing row).
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      values (${r.stageId}, ${r.orgId}, 1, ${T0}, ${r.ownerUserId})`;
    expect(await storedFlag(r.stageId)).toBe(false);
    const a = await anchorOf(r.ranked.fixtureId);
    expect([a.batch, a.at.getTime()]).toEqual([0, T0.getTime()]);
  });

  it("[reader:reinvite] a re-invite after batch 0's window closed: the board whose own batch is still running IS invited, the one whose batch closed is reported window_closed", async () => {
    const r = await seedRanked("required");
    const first = r.boards[0]!;
    // Board 1's second player and the whole ranked board fail to receive the first mail - both have a seat still owed.
    mail.fail.add(first.away.email).add(r.ranked.home.email).add(r.ranked.away.email);
    await open(r, 1, T0);
    mail.fail.clear();
    mail.sent.length = 0;
    const afterBatch0 = new Date(T0.getTime() + DEADLINE_AFTER_MS + 1);
    expect(afterBatch0.getTime(), "premise: batch 2's window still runs").toBeLessThan(T0.getTime() + 2 * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS);
    const out = await open(r, 1, afterBatch0);
    expect(out).toEqual({
      opened: true,
      invited: 2,
      retrying: 0,
      skipped: [{ fixtureId: first.fixtureId, reason: "window_closed" }],
    });
    expect(sentTo(), "only the ranked board's players were mailed").toEqual([r.ranked.home.email, r.ranked.away.email].sort());
    // The pair: once batch 2's own deadline has passed too, nobody is left to invite.
    const afterAll = new Date(T0.getTime() + 2 * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS);
    mail.sent.length = 0;
    const none = await open(r, 1, afterAll);
    expect(none).toMatchObject({ opened: false, reason: "already_open" });
    expect(mail.sent).toHaveLength(0);
  });
});
