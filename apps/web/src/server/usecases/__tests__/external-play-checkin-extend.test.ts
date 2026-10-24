// The check-in extension (spec 2026-10-09 §3.2.2; owner-approved 2026-10-19): the arbiter adds CHECKIN_EXTEND_STEP_MS to a board's
// check-in while it is open - one board, or every open board of a round.
//
// Three families, all against a real database through the product's own producers (`openRound` opens and invites; the readers
// below are the real ones, driven at an injected clock):
//   1. THE RULE - the cap, what a board may be extended while, the audit row, the second call, another club, who may press.
//   2. THE RACE - the extension against the sweep's no-show, in both orders, with the window lock genuinely contended.
//   3. THE READERS - every reader of a board's window sees the extension (the inert-seam class: a deadline stored on the row that
//      one reader forgot to read is a deadline that reader still judges by the old time). One `[extend-reader:<id>]` test per reader
//      in batch-anchor-source-guard.test.ts's table; that file proves the table closed over this one and the create-side file
//      (external-play-checkin-extend-create.test.ts, which needs the Lichess Board API mocked).
//
// Every instant is written from the constants (the round's open + DEADLINE_AFTER_MS + k x CHECKIN_EXTEND_STEP_MS), never read back
// from window.ts. Each reader test asks ONE question at ONE instant that falls between the unextended deadline and the extended one,
// so the same question has two different right answers - the reader that did not read the extension gives the wrong one.
//
// Single-sport by construction: online play exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`); nothing here
// branches on sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { CHECKIN_EXTEND_STEP_MINUTES, liveExtendRefusal, liveExtendableCount, liveRoundRefusals, roundWhy } from "@/lib/checkin-extend";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MS,
  DEADLINE_AFTER_MS,
  LINE_DEADLINE_GRACE_MS,
  MINT_CLAIM_STALE_MS,
  WINDOW_OPEN_LEAD_MS,
} from "@/server/external-play/window";
import { boardOpenFor, lockCheckinWindow } from "@/server/external-play/round-open";
import { backendPid, pollWaitersBehind } from "../external-play/__tests__/_lock-waiters";
import { loadOnlinePlayFixture } from "../external-play/guard";

// The email seam (as open-round.test.ts): the invite goes through the email outbox and its replaced transport.
// `retryAll`: while set, the provider answers every send 503, so the invites stay `queued` for the worker (Task 8: the extension moves
// the expiry of a row that is still waiting to be retried).
const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>(), retryAll: false }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
// The invite is queued on the email outbox and sent after commit through its one network seam; the provider's answer is ours.
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return {
    deliver: (msg: DeliverMessage) =>
      mail.retryAll
        ? Promise.resolve({ ok: false as const, reason: "http" as const, status: 503, errorName: "service_unavailable", detail: "later" })
        : h.deliverForTest(mail, msg),
  };
});
// The outbox's expiry move, wrapped so a test can make it throw INSIDE the extension's transaction (the atomicity test). Every other
// export, and every other call, is the real module's.
const expiryFault = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/email-outbox/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox/enqueue")>();
  return {
    ...actual,
    extendEmailExpiry: async (...args: Parameters<typeof actual.extendEmailExpiry>) => {
      if (expiryFault.fail) throw new Error("the expiry move blew up");
      return actual.extendEmailExpiry(...args);
    },
  };
});
beforeEach(() => stubOutboxEnv());
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
// The gap between the extension's read of a board with NO bridge row and its making of one (race rule, checkin-extend.ts): the real
// `ensureBridgeRow` runs on its own connection, so a create that mints the row AND claims it can land in front of it. The seam lets a
// test put exactly that create there; every other call - and every other test - goes through the real function untouched.
const rowGap = vi.hoisted(() => ({ before: null as null | ((fixtureId: string) => Promise<void>), real: null as null | ((f: unknown) => Promise<void>) }));
vi.mock("../external-play/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-play/guard")>();
  rowGap.real = (f) => actual.ensureBridgeRow(f as Parameters<typeof actual.ensureBridgeRow>[0]);
  return {
    ...actual,
    ensureBridgeRow: async (f: Parameters<typeof actual.ensureBridgeRow>[0], o?: Parameters<typeof actual.ensureBridgeRow>[1]) => {
      await rowGap.before?.(f.fixtureId);
      return actual.ensureBridgeRow(f, o);
    },
  };
});
vi.mock("@/server/external-play/lichess/board-api", () => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));

import { openRound } from "../external-play/open-round";
import { resolveExternalPlay } from "../external-play/resolve";
import { scoreEvent } from "../scoring";
import { extendCheckin, extendRoundCheckin } from "../external-play/checkin-extend";
import { CHESS_SEAT_REF_TYPE, chessSeatRef } from "../external-play/seat-stamp";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { seatPlayer } from "../external-play/preflight";
import { claimRoomSeat, readRoom, type RoomDeps } from "../external-play/room";
import { resendExternalPlayNotice } from "../external-play/invite";
import { listOpenRounds } from "../external-play/open-round-view";
import { loadArbiterRound } from "../external-play/arbiter";
import { playableWindow, sweepExternalPlay, type SweepDeps } from "../external-play/sweep";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { stampFixtureCheckIn, checkInToFixture } from "../me";
import type { AuthCtx } from "@/server/api-v1/auth";
import { putVideoMeeting, seedOnlineChessRound, seedOwner, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const ORIGIN = "https://seazn.test";

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  mail.sent.length = 0;
  mail.retryAll = false;
  expiryFault.fail = false;
});

// ── the instants, from the constants ────────────────────────────────────────────────────────────────────────────────────────
/** The round's open. Batch 0 starts here; its window opens WINDOW_OPEN_LEAD_MS earlier and closes DEADLINE_AFTER_MS later. */
const O = new Date("2026-10-01T12:00:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
/** Batch 0's UNEXTENDED deadline, and the deadline after k presses. */
const OLD = at(O, DEADLINE_AFTER_MS);
const deadlineAfter = (k: number) => at(OLD, k * CHECKIN_EXTEND_STEP_MS);
/** The arbiter presses inside the window. */
const EXT_AT = at(O, MIN);
/** Strictly between the unextended deadline and the deadline after ONE press: the same question has two answers here. */
const P = at(OLD, MIN);
expect(P.getTime() < deadlineAfter(1).getTime() && P.getTime() > OLD.getTime()).toBe(true);

// ── the rig ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const quiet: RoomDeps["publish"] = async () => {};
const roomDeps = (now: Date): RoomDeps => ({
  now,
  publish: vi.fn(quiet),
  create: vi.fn(async () => ({ created: false as const, reason: "not_ready" as const })),
  offered: vi.fn(async () => true),
  mintRealtime: vi.fn(async () => "rt-token"),
});

type OpenedRound = SeedOnlineChessRoundResult & { ranked: SeedRoundBoard[] };
/** A round seeded, given one extra REAL board at each zero-based rank in `ranked` (abandoned filler rows between: they count in the
 *  rank and are never played, as seedOnlineChessRoundWithRankedBoard does for one), and then OPENED through the product's own
 *  `openRound` at `open`, so every board is invited, bound and stamped by the real producer. A round with `ranked` boards in
 *  later batches only staggers under a required camera. */
async function openedRound(
  fixtures: number,
  o: { camera?: "off" | "optional" | "required"; open?: Date; ranked?: number[] } = {},
): Promise<OpenedRound> {
  const ranks = o.ranked ?? [];
  const r = await seedOnlineChessRound({ fixtures, ...(o.camera ? { cameraPolicy: o.camera } : {}), spares: ranks.length });
  const ranked: SeedRoundBoard[] = [];
  let seq = fixtures;
  for (const [i, rank] of ranks.entries()) {
    if (rank < seq) throw new Error(`rank ${rank} is already taken (${seq} rows so far)`);
    const pair = r.spares[i]!;
    for (seq += 1; seq <= rank; seq++) {
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, scheduled_at)
        values (${r.stageId}, ${r.divisionId}, ${r.orgId}, ${r.roundNo}, ${seq}, ${`cx-shell-${seq}-${randomUUID().slice(0, 6)}`}, 'abandoned', ${O})`;
    }
    const [row] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${r.stageId}, ${r.divisionId}, ${r.orgId}, ${r.roundNo}, ${rank + 1}, ${`cx-ranked-${randomUUID().slice(0, 6)}`}, 'scheduled',
              ${pair.home.entrantId}, ${pair.away.entrantId}, ${O})
      returning id`;
    ranked.push({ fixtureId: row!.id, home: pair.home, away: pair.away });
    seq = rank + 1;
  }
  const out = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: o.open ?? O });
  expect(out, "premise: the real open stamped the round and invited it").toMatchObject({ opened: true });
  return { ...r, ranked };
}

/** One press on one board, at `now`. */
const press = (auth: AuthCtx, fixtureId: string, now: Date = EXT_AT) =>
  extendCheckin(auth, fixtureId, { now: () => now, publish: async () => {} });
const pressRound = (auth: AuthCtx, r: SeedOnlineChessRoundResult, now: Date = EXT_AT) =>
  extendRoundCheckin(auth, { stageId: r.stageId, roundNo: r.roundNo }, { now: () => now, publish: async () => {} });

type BridgeFacts = {
  checkin_extra_ms: number;
  checkin_extensions: number;
  status: string;
  challenge_id: string | null;
  expires_at: Date | null;
};
async function rowOf(fixtureId: string): Promise<BridgeFacts | null> {
  const [r] = await sql<BridgeFacts[]>`
    select checkin_extra_ms, checkin_extensions, status, challenge_id, expires_at from fixture_external_play where fixture_id = ${fixtureId}`;
  return r ?? null;
}
const auditOf = (fixtureId: string) =>
  sql<{ kind: string; actor_user_id: string; org_id: string; note: string }[]>`
    select kind, actor_user_id, org_id, note from online_chess_audit where fixture_id = ${fixtureId} and kind = 'checkin_extend' order by created_at, id`;
const deadlineOf = async (fixtureId: string): Promise<number> => {
  const b = await boardOpenFor(sql, fixtureId);
  // The board's deadline through the choke point every reader uses: batch start + DEADLINE_AFTER_MS + the extension.
  return b!.anchor.at.getTime() + DEADLINE_AFTER_MS + b!.anchor.extraMs;
};

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string | undefined }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected a refusal, got an answer");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE RULE
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("extendCheckin - the rule", () => {
  it("each press adds one step to the board's deadline, up to CHECKIN_EXTEND_MAX; the next is CHECKIN_EXTEND_CAP and writes nothing; one audit row per press", async () => {
    const r = await openedRound(1);
    const fixtureId = r.boards[0]!.fixtureId;
    expect(await rowOf(fixtureId), "premise: the open's invite made the row, nothing extended").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    let checked = 0;
    for (let k = 1; k <= CHECKIN_EXTEND_MAX; k++) {
      const out = await press(r.owner, fixtureId);
      expect(out, `press ${k}`).toEqual({
        fixtureId,
        extensions: k,
        extensionsLeft: CHECKIN_EXTEND_MAX - k,
        addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
        deadlineAt: deadlineAfter(k).toISOString(),
      });
      expect(await rowOf(fixtureId), `press ${k}: the row`).toMatchObject({ checkin_extra_ms: k * CHECKIN_EXTEND_STEP_MS, checkin_extensions: k });
      expect(await deadlineOf(fixtureId), `press ${k}: the deadline every reader reads`).toBe(deadlineAfter(k).getTime());
      checked += 1;
    }
    // The (CAP+1)th press: refused by its own code, and nothing moves.
    expect(await refusal(press(r.owner, fixtureId))).toEqual({ status: 409, code: "CHECKIN_EXTEND_CAP" });
    expect(await rowOf(fixtureId)).toMatchObject({ checkin_extra_ms: CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS, checkin_extensions: CHECKIN_EXTEND_MAX });
    const audit = await auditOf(fixtureId);
    expect(audit.length, "one audit row per press that went through, none for the refused one").toBe(CHECKIN_EXTEND_MAX);
    expect(audit.every((a) => a.actor_user_id === r.ownerUserId && a.org_id === r.orgId), "who and for which club").toBe(true);
    expect(audit.map((a) => JSON.parse(a.note)), "the board's press count and its new deadline, per press").toEqual(
      Array.from({ length: CHECKIN_EXTEND_MAX }, (_, i) => ({
        scope: "board",
        extensions: i + 1,
        addedMs: CHECKIN_EXTEND_STEP_MS,
        deadlineAt: deadlineAfter(i + 1).toISOString(),
      })),
    );
    expect(checked, "anti-vacuity: presses made").toBe(CHECKIN_EXTEND_MAX);
  });

  it("is allowed one ms before the (extended) deadline and refused CHECKIN_CLOSED at it - plain and after a press; a refusal writes nothing", async () => {
    const r = await openedRound(3);
    const [plain, edge, extended] = r.boards.map((b) => b.fixtureId) as [string, string, string];
    expect(await press(r.owner, plain, at(OLD, -1)), "1 ms before the unextended deadline").toMatchObject({ extensions: 1 });
    expect(await refusal(press(r.owner, edge, OLD)), "at the unextended deadline").toEqual({ status: 409, code: "CHECKIN_CLOSED" });
    expect(await rowOf(edge), "nothing written by the refusal").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    expect((await auditOf(edge)).length).toBe(0);
    // After one press the deadline is a step later: the old deadline is no longer the edge.
    await press(r.owner, extended, EXT_AT);
    expect(await press(r.owner, extended, OLD), "at the OLD deadline, after a press: still open").toMatchObject({ extensions: 2 });
    expect(await press(r.owner, extended, at(deadlineAfter(2), -1)), "1 ms before the twice-extended deadline").toMatchObject({ extensions: 3 });
    expect(await refusal(press(r.owner, extended, deadlineAfter(3))), "at the thrice-extended deadline: the window is closed (before the cap is looked at)").toEqual({
      status: 409,
      code: "CHECKIN_CLOSED",
    });
  });

  it("is refused CHECKIN_GAME_STARTED once a game is - or may be - on file: a challenge, a sent create or a LIVE mint claim; a STALE claim is no game", async () => {
    const r = await openedRound(5);
    const [challenge, marker, claim, stale, none] = r.boards.map((b) => b.fixtureId) as [string, string, string, string, string];
    await sql`update fixture_external_play set challenge_id = ${`gm-${randomUUID().slice(0, 8)}`}, status = 'ready', white_side = 'home' where fixture_id = ${challenge}`;
    await sql`update fixture_external_play set create_sent_at = ${EXT_AT} where fixture_id = ${marker}`;
    await sql`update fixture_external_play set mint_claimed_at = ${EXT_AT} where fixture_id = ${claim}`;
    await sql`update fixture_external_play set mint_claimed_at = ${at(EXT_AT, -MINT_CLAIM_STALE_MS - 1)} where fixture_id = ${stale}`;
    let checked = 0;
    for (const id of [challenge, marker, claim]) {
      expect(await refusal(press(r.owner, id)), id).toEqual({ status: 409, code: "CHECKIN_GAME_STARTED" });
      expect(await rowOf(id), "nothing written").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
      checked += 1;
    }
    expect(await press(r.owner, stale), "a claim older than MINT_CLAIM_STALE_MS is T9's own takeover, not a game").toMatchObject({ extensions: 1 });
    expect(await press(r.owner, none), "the control: no game, extended").toMatchObject({ extensions: 1 });
    expect(checked, "anti-vacuity").toBe(3);
  });

  it("is refused on every fixture status but the two a board is played in (FIXTURE_NOT_PLAYABLE; a locked board is not an online board at all: 404), and on a board whose bridge row is finished", async () => {
    // The owner's ruling Q2 (preflight.ts isPlayableFixtureStatus): a board is playable only while `scheduled` or `in_play`. A
    // finalized or cancelled fixture never loads as an online board (guard.ts onlinePlayBoardWhere), the same 404 as a foreign one.
    const PLAYABLE = ["scheduled", "in_play"];
    const r = await openedRound(FIXTURE_STATUSES.length + 1);
    const outcomes: Record<string, string> = {};
    for (const [i, status] of FIXTURE_STATUSES.entries()) {
      const id = r.boards[i]!.fixtureId;
      await sql`update fixtures set status = ${status} where id = ${id}`;
      const want = PLAYABLE.includes(status) ? "extended" : LOCKED_FIXTURE_STATUSES.has(status) ? "404 NOT_FOUND" : "409 FIXTURE_NOT_PLAYABLE";
      try {
        await press(r.owner, id);
        outcomes[status] = "extended";
      } catch (err) {
        expect(err, status).toBeInstanceOf(HttpError);
        outcomes[status] = `${(err as HttpError).status} ${(err as HttpError).code}`;
        expect(await rowOf(id), `${status}: nothing written`).toMatchObject({ checkin_extensions: 0 });
      }
      expect(outcomes[status], status).toBe(want);
    }
    expect(Object.keys(outcomes).sort(), "anti-vacuity: every status in the registry was judged").toEqual([...FIXTURE_STATUSES].sort());
    expect(Object.values(outcomes).filter((v) => v === "extended").length, "exactly the two playable statuses extend").toBe(PLAYABLE.length);
    // A bridge row our side closed (the arbiter's No result, then the organiser's void): the fixture reads playable again, the row is `finished`.
    const voided = r.boards[FIXTURE_STATUSES.length]!.fixtureId;
    await sql`update fixture_external_play set status = 'finished' where fixture_id = ${voided}`;
    expect(await refusal(press(r.owner, voided))).toEqual({ status: 409, code: "FIXTURE_NOT_PLAYABLE" });
  });

  it("a board whose batch has not opened is CHECKIN_NOT_OPEN; a round never opened is ROUND_NOT_OPEN; both write nothing", async () => {
    // Required camera ⇒ the open staggers; the second board is at rank 2 x batch size: batch 2, which opens 2 gaps after the open.
    const r = await openedRound(1, { camera: "required", ranked: [2 * CHECKIN_BATCH_SIZE] });
    const ranked = r.ranked[0]!;
    const batch2Opens = at(O, 2 * CHECKIN_BATCH_GAP_MS);
    expect(await refusal(press(r.owner, ranked.fixtureId, at(batch2Opens, -1))), "1 ms before its batch opens").toEqual({ status: 409, code: "CHECKIN_NOT_OPEN" });
    expect(await press(r.owner, ranked.fixtureId, batch2Opens), "at the opening").toMatchObject({ extensions: 1 });
    expect(await deadlineOf(ranked.fixtureId), "the later batch's deadline is its OWN start + the window + the step").toBe(
      at(batch2Opens, DEADLINE_AFTER_MS + CHECKIN_EXTEND_STEP_MS).getTime(),
    );
    // A round nobody opened.
    const never = await seedOnlineChessRound({ fixtures: 1 });
    expect(await refusal(press(never.owner, never.boards[0]!.fixtureId))).toEqual({ status: 409, code: "ROUND_NOT_OPEN" });
    expect(await rowOf(never.boards[0]!.fixtureId), "no bridge row was made for a round that is not open").toBeNull();
  });

  it("a board nobody touched has no bridge row yet: the press makes it (the empty case) and the board then reads the extension", async () => {
    const r = await openedRound(1);
    const id = r.boards[0]!.fixtureId;
    await sql`delete from fixture_external_play where fixture_id = ${id}`;
    expect(await rowOf(id), "premise: no row").toBeNull();
    expect(await press(r.owner, id)).toMatchObject({ extensions: 1, deadlineAt: deadlineAfter(1).toISOString() });
    expect(await rowOf(id)).toMatchObject({ checkin_extra_ms: CHECKIN_EXTEND_STEP_MS, checkin_extensions: 1 });
    expect(await deadlineOf(id)).toBe(deadlineAfter(1).getTime());
  });

  it("a board with no bridge row whose create mints the row AND claims it in the gap before the press makes one: the press is refused game_started and extends nothing (the rowless race)", async () => {
    const r = await openedRound(1);
    const id = r.boards[0]!.fixtureId;
    await sql`delete from fixture_external_play where fixture_id = ${id}`;
    expect(await rowOf(id), "premise: no row, so the first read finds nothing to lock").toBeNull();
    const f = await loadOnlinePlayFixture(id);
    let landed = 0;
    // The create's own two steps (guard.ts ensureBridgeRow, then create-game.ts's claim: a conditional UPDATE of `mint_claimed_at`),
    // landing between the press's read of the missing row and its own make of one.
    rowGap.before = async () => {
      landed += 1;
      await rowGap.real!(f!);
      await sql`update fixture_external_play set mint_claimed_at = ${EXT_AT}, updated_at = now() where fixture_id = ${id} and status = 'pending' and challenge_id is null`;
    };
    try {
      expect(await refusal(press(r.owner, id)), "a live mint claim is a game on file").toEqual({ status: 409, code: "CHECKIN_GAME_STARTED" });
    } finally {
      rowGap.before = null;
    }
    expect(landed, "anti-vacuity: the create did land in the gap").toBe(1);
    expect(await rowOf(id), "the create's row stands, and nothing was extended on it").toMatchObject({ status: "pending", checkin_extra_ms: 0, checkin_extensions: 0 });
    expect((await auditOf(id)).length, "and nothing was audited").toBe(0);
    expect(await deadlineOf(id), "the board's deadline is the unextended one").toBe(OLD.getTime());
  });

  it("who: only a signed-in owner or admin who does not play on the board; another club's board is a 404; every refusal writes nothing", async () => {
    const r = await openedRound(2);
    const [a, b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    const base = r.owner;
    const attempts: [string, AuthCtx, string, { status: number; code: string | undefined }][] = [
      ["a member who is not an organiser", { ...base, role: "viewer" } as AuthCtx, a.fixtureId, { status: 403, code: "ARBITER_NOT_ORGANISER" }],
      ["an API key", { ...base, via: "api_key", userId: null, role: null, keyId: "k" } as AuthCtx, a.fixtureId, { status: 403, code: "ARBITER_NEEDS_SESSION" }],
      ["an organiser who plays on this board (C1)", { ...base, userId: a.home.userId } as AuthCtx, a.fixtureId, { status: 403, code: "ARBITER_PLAYS_THIS_BOARD" }],
      ["another club's owner", await seedOwner(), a.fixtureId, { status: 404, code: "NOT_FOUND" }],
    ];
    for (const [who, auth, fixtureId, want] of attempts) {
      expect(await refusal(press(auth, fixtureId)), who).toEqual(want);
    }
    for (const id of [a.fixtureId, b.fixtureId]) {
      expect(await rowOf(id), "nothing moved").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
      expect((await auditOf(id)).length).toBe(0);
    }
    // The same organiser, who plays on board A, may extend board B: C1 is per board.
    expect(await press({ ...base, userId: a.home.userId } as AuthCtx, b.fixtureId)).toMatchObject({ extensions: 1 });
    expect(attempts.length, "anti-vacuity: who was tried").toBe(4);
  });

  it("another board of the round, another round of the stage and another division are untouched by a press", async () => {
    const r = await openedRound(2);
    const other = await openedRound(1);
    await press(r.owner, r.boards[0]!.fixtureId);
    expect(await rowOf(r.boards[1]!.fixtureId), "the neighbour on the same round").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    expect(await rowOf(other.boards[0]!.fixtureId), "another division, another club").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    expect(await deadlineOf(r.boards[1]!.fixtureId), "the neighbour's deadline").toBe(OLD.getTime());
  });

  it("a re-open that restarts the window starts the boards without the last window's time - but a board with a game on file keeps its row as it was", async () => {
    // Nobody this round was invited (every send of the first open failed), so a second open re-stamps: spec §3.2.2.
    const r = await seedOnlineChessRound({ fixtures: 3 });
    const [a, b, played] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    const opened = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: O });
    expect(opened).toMatchObject({ opened: true });
    for (const x of [a, b, played]) await press(r.owner, x.fixtureId);
    // The third board's create was sent: a game may be on file behind it.
    await sql`update fixture_external_play set create_sent_at = ${EXT_AT} where fixture_id = ${played.fixtureId}`;
    // Unbind every row from the open: the shape a round whose every send failed leaves (round_open_id null).
    await sql`update fixture_external_play set round_open_id = null, white_emailed_at = null, black_emailed_at = null
               where fixture_id in (${a.fixtureId}, ${b.fixtureId}, ${played.fixtureId})`;
    const later = at(O, 3 * MIN);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: later })).toMatchObject({ opened: true });
    for (const x of [a, b]) {
      expect(await rowOf(x.fixtureId), "the extension of the last window is gone").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
      expect(await deadlineOf(x.fixtureId), "the new window's own deadline").toBe(at(later, DEADLINE_AFTER_MS).getTime());
    }
    expect(await rowOf(played.fixtureId), "a board with a game on file is left as it was").toMatchObject({ checkin_extra_ms: CHECKIN_EXTEND_STEP_MS, checkin_extensions: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The round-wide press
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("extendRoundCheckin - one action, the same rule on every board", () => {
  it("a mixed round, with exact counts: open, closed, game started, capped, withdrawn, and a later batch that has not opened", async () => {
    // Required camera ⇒ the round STAGGERS (the open stores it). Batch k opens at O + k gaps and closes DEADLINE_AFTER_MS later. `now` is
    // O + 11 min: batch 0 (ranks 0-9) closed at O + 10; batch 1 (ranks 10-19, opened at O + 1 gap) is open until O + 1 gap + 10; and
    // batch 6 (rank 60) opens at O + 6 gaps, after `now`.
    const NOW = at(O, 11 * MIN);
    expect(6 * CHECKIN_BATCH_GAP_MS, "premise: batch 6 opens after NOW").toBeGreaterThan(11 * MIN);
    expect(DEADLINE_AFTER_MS, "premise: batch 0 has closed by NOW").toBeLessThan(11 * MIN);
    expect(CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS, "premise: batch 1 is still open at NOW").toBeGreaterThan(11 * MIN);
    const r = await openedRound(6, { camera: "required", ranked: [CHECKIN_BATCH_SIZE, 6 * CHECKIN_BATCH_SIZE] });
    const [extendedOnce, capped, gameStarted, closedA, closedB, withdrawn] = r.boards.map((b) => b.fixtureId) as [string, string, string, string, string, string];
    const [batch1, batch6] = r.ranked as [SeedRoundBoard, SeedRoundBoard];
    // Pre-states, by the product's own columns.
    await sql`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_STEP_MS}, checkin_extensions = 1 where fixture_id = ${extendedOnce}`;
    await sql`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS}, checkin_extensions = ${CHECKIN_EXTEND_MAX} where fixture_id = ${capped}`;
    await sql`update fixture_external_play set create_sent_at = ${at(O, MIN)} where fixture_id = ${gameStarted}`;
    await sql`update fixtures set status = 'abandoned' where id = ${withdrawn}`;
    const before = new Map<string, number>();
    const all = [extendedOnce, capped, gameStarted, closedA, closedB, withdrawn, batch1.fixtureId, batch6.fixtureId];
    for (const id of all) before.set(id, await deadlineOf(id));

    const out = await pressRound(r.owner, r, NOW);
    expect(out).toEqual({
      extended: 2, // the once-extended batch-0 board (open until O + 20 min), and the plain batch-1 board
      skipped: { closed: 2, gameStarted: 1, capReached: 1 },
      notOpenYet: 1,
      ownBoards: 0,
      failed: 0,
      addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
    });
    // Each board's deadline: only the two extended moved, each by exactly one step.
    const moved = new Set([extendedOnce, batch1.fixtureId]);
    for (const id of all) {
      expect(await deadlineOf(id), id).toBe(before.get(id)! + (moved.has(id) ? CHECKIN_EXTEND_STEP_MS : 0));
    }
    // The audit trail: one row per board extended, scope `round`, none for the rest.
    expect((await Promise.all(all.map(async (id) => [id, (await auditOf(id)).length] as const))).filter(([, n]) => n > 0).map(([id]) => id).sort()).toEqual([...moved].sort());
    expect(JSON.parse((await auditOf(extendedOnce))[0]!.note)).toMatchObject({ scope: "round", extensions: 2 });
  });

  it("[opens-at:open-round-view] a mixed round's windows are the boards the CLOCK alone stands in the way of - a capped one included, with none left - and every other board is counted by its reason; the windows' count at NOW is the extendable count", async () => {
    // The same round as above, read through the organiser's Open round view at NOW = O + 11 min.
    const NOW = at(O, 11 * MIN);
    const r = await openedRound(6, { camera: "required", ranked: [CHECKIN_BATCH_SIZE, 6 * CHECKIN_BATCH_SIZE] });
    const [extendedOnce, capped, gameStarted, , , withdrawn] = r.boards.map((b) => b.fixtureId) as [string, string, string, string, string, string];
    await sql`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_STEP_MS}, checkin_extensions = 1 where fixture_id = ${extendedOnce}`;
    await sql`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS}, checkin_extensions = ${CHECKIN_EXTEND_MAX} where fixture_id = ${capped}`;
    await sql`update fixture_external_play set create_sent_at = ${at(O, MIN)} where fixture_id = ${gameStarted}`;
    await sql`update fixtures set status = 'abandoned' where id = ${withdrawn}`;
    const auth = await mintOrgOwnerAuth(r.orgId);
    const view = (await listOpenRounds(auth, r.divisionId, { now: NOW })).find((v) => v.roundNo === 1)!;
    // Expected from the rule, per board: the once-extended batch-0 board (opens O - lead, now closes one step later), the capped batch-0
    // board (three steps later, none left), the plain batch-1 board (opens O + 1 gap), the batch-6 board (opens O + 6 gaps) - and none of:
    // batch-0's two closed boards and the started one, which the tally counts by their reason (the withdrawn board is not listed).
    const win = (batch: number, extra: number, left: number) => ({
      opensAt: at(O, batch === 0 ? -WINDOW_OPEN_LEAD_MS : batch * CHECKIN_BATCH_GAP_MS).toISOString(),
      deadlineAt: at(O, batch * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS + extra).toISOString(),
      extensionsLeft: left,
    });
    const expected = [win(0, CHECKIN_EXTEND_STEP_MS, CHECKIN_EXTEND_MAX - 1), win(0, CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS, 0), win(1, 0, CHECKIN_EXTEND_MAX), win(6, 0, CHECKIN_EXTEND_MAX)];
    const byDeadline = (a: { deadlineAt: string }, b: { deadlineAt: string }) => a.deadlineAt.localeCompare(b.deadlineAt);
    expect([...view.extendWindows].sort(byDeadline), "4 windows of 8 boards").toEqual(expected.sort(byDeadline));
    // The withdrawn board is not one of the round's boards at all (an abandoned fixture is not listed by the view): 7 boards, not 8.
    expect(view.extendRefusals, "the other three, by their reason").toEqual({ not_playable: 0, game_started: 1, closed: 2, not_open: 0, cap_reached: 0 });
    const listed = view.extendWindows.length + Object.values(view.extendRefusals).reduce((a, n) => a + n, 0);
    expect(listed, "every board is in the windows or the tally, once").toBe(7);
    expect(view.extendableBoards, "two of them hold NOW and have a press left").toBe(2);
    expect(liveExtendableCount(view.extendWindows, NOW.getTime()), "the capped board's window holds NOW and is not counted").toBe(view.extendableBoards);

    // The round's sentence, from this view on a clock and from the arbiter panel's own board list on the same clock, against the SERVER's
    // reading of the round re-loaded at that instant: the two screens never say what the server would not.
    const arbiter = (await loadArbiterRound(auth, r.divisionId, { now: NOW }))!;
    expect(arbiter.boards.length, "premise: the arbiter lists the view's boards and the withdrawn one besides (silent: not_playable)").toBe(listed + 1);
    expect(arbiter.boards.filter((b) => b.checkin?.refusal === "not_playable").length, "and that one is the withdrawn board").toBe(1);
    const grid = new Set<number>([NOW.getTime()]);
    for (const w of view.extendWindows) for (const edge of [w.opensAt, w.deadlineAt]) for (const d of [-1, 0]) if (Date.parse(edge) + d >= NOW.getTime()) grid.add(Date.parse(edge) + d);
    const seen = new Set<string>();
    for (const t of [...grid].sort((a, b) => a - b)) {
      const served = (await loadArbiterRound(auth, r.divisionId, { now: new Date(t) }))!;
      const want = roundWhy(served.boards.flatMap((b) => (b.checkin === null ? [] : [b.checkin.refusal])));
      expect(roundWhy(arbiter.boards.flatMap((b) => (b.checkin === null ? [] : [liveExtendRefusal(b.checkin, t)]))), `the arbiter panel at +${t - NOW.getTime()} ms`).toEqual(want);
      expect(roundWhy(liveRoundRefusals(view.extendRefusals, view.extendWindows, t)), `the Open round control at +${t - NOW.getTime()} ms`).toEqual(want);
      seen.add(want === null ? "none" : want.code);
    }
    expect(grid.size, "anti-vacuity: instants walked").toBeGreaterThan(8);
    expect([...seen].sort(), "both a round with a button and a round with a reason were met").toEqual(["mixed", "none"]);
  });

  it("a second press is the same rule again: an already-extended round extends again until the cap, then reports every board capped", async () => {
    const r = await openedRound(3);
    const counts: number[] = [];
    for (let k = 1; k <= CHECKIN_EXTEND_MAX; k++) counts.push((await pressRound(r.owner, r)).extended);
    expect(counts, "each of the CAP presses extended all three boards").toEqual(Array(CHECKIN_EXTEND_MAX).fill(3));
    expect(await pressRound(r.owner, r), "the next press: all three at the cap").toMatchObject({ extended: 0, skipped: { capReached: 3, closed: 0, gameStarted: 0 } });
  });

  it("a round with nothing to extend (the empty case): all closed, or no board of it online - counts zero, nothing written", async () => {
    const r = await openedRound(2);
    expect(await pressRound(r.owner, r, at(OLD, 1))).toMatchObject({ extended: 0, skipped: { closed: 2, gameStarted: 0, capReached: 0 }, notOpenYet: 0 });
    for (const b of r.boards) expect((await auditOf(b.fixtureId)).length).toBe(0);
  });

  it("an unopened round is ROUND_NOT_OPEN, another club's stage is a 404, a non-organiser is refused", async () => {
    const never = await seedOnlineChessRound({ fixtures: 1 });
    expect(await refusal(pressRound(never.owner, never))).toEqual({ status: 409, code: "ROUND_NOT_OPEN" });
    const r = await openedRound(1);
    expect(await refusal(pressRound(await seedOwner(), r))).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(await refusal(pressRound({ ...r.owner, role: "viewer" } as AuthCtx, r))).toEqual({ status: 403, code: "ARBITER_NOT_ORGANISER" });
    expect(await rowOf(r.boards[0]!.fixtureId)).toMatchObject({ checkin_extensions: 0 });
  });

  it("a board the caller plays on is left alone and counted (C1); its neighbours are extended", async () => {
    const r = await openedRound(3);
    const me = { ...r.owner, userId: r.boards[0]!.home.userId } as AuthCtx;
    expect(await pressRound(me, r)).toMatchObject({ extended: 2, ownBoards: 1, failed: 0 });
    expect(await rowOf(r.boards[0]!.fixtureId), "the board they play on").toMatchObject({ checkin_extensions: 0 });
  });

  it("a board whose step throws is reported `failed` and rolled back; the others still go through (each board its own atomic step)", async () => {
    const r = await openedRound(3);
    let reads = 0;
    const out = await extendRoundCheckin(
      r.owner,
      { stageId: r.stageId, roundNo: 1 },
      {
        now: () => {
          reads += 1;
          if (reads === 2) throw new Error("boom: the second board's step");
          return EXT_AT;
        },
        publish: async () => {},
      },
    );
    expect(out).toMatchObject({ extended: 2, failed: 1 });
    const done = await Promise.all(r.boards.map(async (b) => (await rowOf(b.fixtureId))!.checkin_extensions));
    expect(done.sort(), "exactly one board untouched - the one whose step threw - and no audit row for it").toEqual([0, 1, 1]);
    expect((await Promise.all(r.boards.map(async (b) => (await auditOf(b.fixtureId)).length))).sort()).toEqual([0, 1, 1]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE RACE - the extension against the sweep's no-show, both orders, with the window lock really contended
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("the extension races the sweep's no-show", () => {
  const sweepAt = (r: SeedOnlineChessRoundResult, now: Date, over: SweepDeps = {}) => sweepExternalPlay({ ...over, now, orgIds: [r.orgId] });
  const status = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;

  it("order 1 - the extension lands AFTER the sweep read its candidates and BEFORE it acts: the no-show re-reads the deadline under the window lock and does not forfeit", async () => {
    const r = await openedRound(1);
    const id = r.boards[0]!.fixtureId;
    await stampFixtureCheckIn(r.boards[0]!.home.personId, id, r.orgId, { at: at(O, MIN) });
    // An extension IN FLIGHT: its transaction holds the board's window lock and has moved the deadline, uncommitted.
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await lockCheckinWindow(holder as never, id);
      const holderPid = await backendPid(holder);
      let done = false;
      // The sweep's candidate read sees the UNEXTENDED row (the update below is not committed), judges the deadline passed at P,
      // and stops at the window lock.
      const pass = sweepAt(r, P).finally(() => {
        done = true;
      });
      expect(
        await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%", finished: () => done }),
        "premise: the sweep's no-show is genuinely WAITING on the board's window lock",
      ).toBeGreaterThan(0);
      expect(done, "and it has not acted").toBe(false);
      await holder`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_STEP_MS}, checkin_extensions = 1 where fixture_id = ${id}`;
      await holder`commit`;
      const report = await pass;
      expect(report.noShows, "the sweep re-read the deadline under the lock: P is inside the extended window").toBe(0);
    } finally {
      holder.release();
    }
    expect(await status(id), "the board was NOT walked over").toBe("scheduled");
    expect(await sql`select 1 from score_events where fixture_id = ${id} and type = 'core.forfeit'`, "no forfeit on the ledger").toHaveLength(0);
  });

  it("order 1b (the control) - the same pass with NO extension in flight forfeits the absent player at P", async () => {
    const r = await openedRound(1);
    const id = r.boards[0]!.fixtureId;
    await stampFixtureCheckIn(r.boards[0]!.home.personId, id, r.orgId, { at: at(O, MIN) });
    const report = await sweepAt(r, P);
    expect(report.noShows).toBe(1);
    expect(await status(id)).toBe("forfeited");
  });

  it("order 1 (the teardown) - an extension that commits AFTER the teardown read its candidates and BEFORE it judges that board: the room is not ended (the judgement is re-read under the window lock)", async () => {
    // Two boards in two clubs, each with a room nobody is in. Board A is walked over by the no-show and its room is ended FIRST;
    // board B has online play switched off (the organiser took it back to the table), so the no-show leaves it alone and only the
    // teardown judges it - on a candidate row read before A's room ended. While A's room is being ended, B's extension commits.
    const run = async (extendDuring: boolean) => {
      const a = await openedRound(1);
      const b = await openedRound(1);
      const idA = a.boards[0]!.fixtureId;
      const idB = b.boards[0]!.fixtureId;
      await sql`update divisions set config = config - 'onlinePlay' where id = ${b.divisionId}`;
      const meetingA = await putVideoMeeting({ fixtureId: idA, orgId: a.orgId, side: "home" });
      const meetingB = await putVideoMeeting({ fixtureId: idB, orgId: b.orgId, side: "home" });
      const ended: string[] = [];
      const endMeeting: NonNullable<SweepDeps["endMeeting"]> = async (m) => {
        ended.push(m);
        if (m === meetingA && extendDuring) {
          // The extension's commit (its own path through the lock is order 1's; this is the teardown's re-read of what it left).
          await sql`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_STEP_MS}, checkin_extensions = 1 where fixture_id = ${idB}`;
        }
      };
      await sweepExternalPlay({ now: P, orgIds: [a.orgId, b.orgId], endMeeting });
      return { ended, meetingA, meetingB };
    };
    const control = await run(false);
    expect(control.ended, "the control: with no extension both rooms are ended at P, A first (the premise: B IS judged closed)").toEqual([control.meetingA, control.meetingB]);
    const raced = await run(true);
    expect(raced.ended, "the extension landed before B was judged: B's room stays up").toEqual([raced.meetingA]);
  });

  it("order 2 - the sweep judged first: the walkover stands and a later press is refused (the board is over); an extension that was WAITING for the lock re-reads the clock after it and is refused CHECKIN_CLOSED", async () => {
    // (a) the walkover is written, then a press.
    const r = await openedRound(1);
    const id = r.boards[0]!.fixtureId;
    await stampFixtureCheckIn(r.boards[0]!.home.personId, id, r.orgId, { at: at(O, MIN) });
    expect((await sweepAt(r, P)).noShows).toBe(1);
    expect(await refusal(press(r.owner, id, at(P, 1)))).toEqual({ status: 409, code: "FIXTURE_NOT_PLAYABLE" });
    expect(await rowOf(id), "nothing extended").toMatchObject({ checkin_extensions: 0 });

    // (b) an extension that began INSIDE the window but is waiting on the lock while the clock passes the deadline: the clock is
    // read after the lock, so the press finds the window closed - a check made before the lock would extend a closed board.
    const q = await openedRound(1);
    const qid = q.boards[0]!.fixtureId;
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await lockCheckinWindow(holder as never, qid);
      const holderPid = await backendPid(holder);
      let clock = at(OLD, -MIN); // inside the window when the press STARTS
      let settled = false;
      const pressed = refusal(extendCheckin(q.owner, qid, { now: () => clock, publish: async () => {} })).finally(() => {
        settled = true;
      });
      expect(await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%", finished: () => settled }), "premise: the press is WAITING on the lock").toBeGreaterThan(0);
      clock = at(OLD, MIN); // the world moves on while it waits
      await holder`commit`;
      expect(await pressed, "judged on the clock after the lock").toEqual({ status: 409, code: "CHECKIN_CLOSED" });
    } finally {
      holder.release();
    }
    expect(await rowOf(qid)).toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
  });

  it("two presses at once on one board are serialised by the window lock: each is counted once, the deadline is exactly two steps on, the cap holds", async () => {
    const r = await openedRound(1);
    const id = r.boards[0]!.fixtureId;
    const answers = await Promise.all([press(r.owner, id), press(r.owner, id)]);
    expect(answers.map((a) => a.extensions).sort(), "distinct counts, not two '1's").toEqual([1, 2]);
    expect(await rowOf(id)).toMatchObject({ checkin_extra_ms: 2 * CHECKIN_EXTEND_STEP_MS, checkin_extensions: 2 });
    // A burst at the cap: CAP + 3 concurrent presses, exactly CAP go through.
    const q = await openedRound(1);
    const qid = q.boards[0]!.fixtureId;
    const settled = await Promise.allSettled(Array.from({ length: CHECKIN_EXTEND_MAX + 3 }, () => press(q.owner, qid)));
    expect(settled.filter((s) => s.status === "fulfilled").length, "exactly the cap went through").toBe(CHECKIN_EXTEND_MAX);
    expect(await rowOf(qid)).toMatchObject({ checkin_extensions: CHECKIN_EXTEND_MAX, checkin_extra_ms: CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE READERS - every reader of a board's window sees the extension
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("every reader of a board's window sees the extension", () => {
  /** A one-board round, opened at O. */
  const oneBoard = async (o: Parameters<typeof openedRound>[1] = {}) => {
    const r = await openedRound(1, o);
    return { r, b: r.boards[0]!, id: r.boards[0]!.fixtureId };
  };
  const session = (b: SeedRoundBoard) => ({ kind: "session" as const, userId: b.home.userId });

  it("[extend-reader:seat] seatPlayer judges the extended deadline: a seat at P is window_closed before the press and seated after; at the extended deadline it is closed again", async () => {
    const { r, b, id } = await oneBoard();
    expect(await seatPlayer({ fixtureId: id, personId: b.home.personId }, { now: P }), "before the press").toMatchObject({ seated: false, reason: "window_closed" });
    await press(r.owner, id);
    expect(await seatPlayer({ fixtureId: id, personId: b.home.personId }, { now: P }), "after the press").toMatchObject({ seated: true });
    expect(await seatPlayer({ fixtureId: id, personId: b.away.personId }, { now: deadlineAfter(1) }), "at the extended deadline").toMatchObject({ seated: false, reason: "window_closed" });
  });

  it("[extend-reader:checkin-counts] a check-in stamped between the old and the new deadline counts only once the board is extended", async () => {
    const { r, b, id } = await oneBoard();
    await stampFixtureCheckIn(b.home.personId, id, r.orgId, { at: at(O, MIN) });
    await sql`update fixture_availability set checked_in_at = ${P} where fixture_id = ${id} and person_id = ${b.home.personId}`;
    expect((await readRoom(session(b), id, roomDeps(P))).you.checkedIn, "before the press: the stamp is past the deadline").toBe(false);
    await press(r.owner, id);
    expect((await readRoom(session(b), id, roomDeps(P))).you.checkedIn, "after the press: it counts").toBe(true);
    await sql`update fixture_availability set checked_in_at = ${deadlineAfter(1)} where fixture_id = ${id} and person_id = ${b.home.personId}`;
    expect((await readRoom(session(b), id, roomDeps(P))).you.checkedIn, "a stamp AT the extended deadline does not").toBe(false);
  });

  it("[extend-reader:compose] the room snapshot (the player's countdown) carries the extended deadline and phase on the next read", async () => {
    const { r, b, id } = await oneBoard();
    const before = await readRoom(session(b), id, roomDeps(P));
    expect([before.deadline, before.phase], "before").toEqual([OLD.toISOString(), "closed"]);
    await press(r.owner, id);
    const after = await readRoom(session(b), id, roomDeps(P));
    expect([after.deadline, after.phase], "after: the countdown re-reads a later deadline and the room is open again").toEqual([deadlineAfter(1).toISOString(), "open"]);
    expect((await readRoom(session(b), id, roomDeps(at(deadlineAfter(1), -1)))).phase, "1 ms before the extended deadline").toBe("open");
    expect((await readRoom(session(b), id, roomDeps(deadlineAfter(1)))).phase, "at it").toBe("closed");
  });

  it("[extend-reader:claim] a seat claim at P is window_closed before the press and seats after it", async () => {
    const { r, b, id } = await oneBoard();
    const closed = await claimRoomSeat(session(b), id, roomDeps(P));
    expect(closed.seat, "before").toEqual({ seated: false, reason: "window_closed", participant: null });
    await press(r.owner, id);
    const seated = await claimRoomSeat(session(b), id, roomDeps(P));
    expect(seated.seat?.seated, "after").toBe(true);
    expect(seated.snapshot.deadline, "and the answer's own snapshot carries the extended deadline").toBe(deadlineAfter(1).toISOString());
  });

  it("[extend-reader:sweep-window] the sweep's window function reads the board's extended deadline", async () => {
    const { r, id } = await oneBoard();
    const read = async () => playableWindow((await boardOpenFor(sql, id))!.anchor).deadline.getTime();
    expect(await read()).toBe(OLD.getTime());
    await press(r.owner, id);
    expect(await read()).toBe(deadlineAfter(1).getTime());
  });

  it("[extend-reader:no-show] a pass at P forfeits the absent player of an unextended board and leaves an extended board alone - until the extended deadline", async () => {
    const plain = await oneBoard();
    const ext = await oneBoard();
    for (const x of [plain, ext]) await stampFixtureCheckIn(x.b.home.personId, x.id, x.r.orgId, { at: at(O, MIN) });
    await press(ext.r.owner, ext.id);
    const status = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;
    expect((await sweepExternalPlay({ now: P, orgIds: [plain.r.orgId, ext.r.orgId] })).noShows, "at P: the unextended board only").toBe(1);
    expect([await status(plain.id), await status(ext.id)], "walked over / left alone").toEqual(["forfeited", "scheduled"]);
    expect((await sweepExternalPlay({ now: at(deadlineAfter(1), -1), orgIds: [ext.r.orgId] })).noShows, "1 ms before the extended deadline").toBe(0);
    expect((await sweepExternalPlay({ now: deadlineAfter(1), orgIds: [ext.r.orgId] })).noShows, "at the extended deadline").toBe(1);
    expect(await status(ext.id)).toBe("forfeited");
  });

  it("[extend-reader:teardown] a room with nobody in it stays up past the old deadline when the board is extended, and comes down at the extended one", async () => {
    const plain = await oneBoard();
    const ext = await oneBoard();
    const meetings = new Map<string, string>();
    for (const x of [plain, ext]) meetings.set(x.id, await putVideoMeeting({ fixtureId: x.id, orgId: x.r.orgId, side: "home" }));
    await press(ext.r.owner, ext.id);
    const ended: string[] = [];
    const endMeeting: NonNullable<SweepDeps["endMeeting"]> = async (m) => {
      ended.push(m);
    };
    await sweepExternalPlay({ now: P, orgIds: [plain.r.orgId, ext.r.orgId], endMeeting });
    expect(ended, "at P: the unextended board's room is ended, the extended one is not").toEqual([meetings.get(plain.id)]);
    await sweepExternalPlay({ now: at(deadlineAfter(1), -1), orgIds: [ext.r.orgId], endMeeting });
    expect(ended, "1 ms before the extended deadline").toEqual([meetings.get(plain.id)]);
    await sweepExternalPlay({ now: deadlineAfter(1), orgIds: [ext.r.orgId], endMeeting });
    expect(ended, "at the extended deadline").toEqual([meetings.get(plain.id), meetings.get(ext.id)]);
  });

  it("[extend-reader:invite] a mail sent after the press names the board's EXTENDED deadline (the same label function, one step later)", async () => {
    const { r, b, id } = await oneBoard();
    const send = async (now: Date) => {
      mail.sent.length = 0;
      expect(await resendExternalPlayNotice(r.owner, id, ORIGIN, { now })).toEqual({ emailed: 2, retrying: 0 });
      return mail.sent.filter((m) => [b.home.email, b.away.email].includes(m.to));
    };
    const fmt = (when: Date, locale: string) =>
      new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(when);
    const first = await send(EXT_AT);
    expect(first.map((m) => m.deadlineLabel), "before the press").toEqual(first.map((m) => fmt(OLD, m.locale)));
    await press(r.owner, id);
    const second = await send(EXT_AT);
    expect(second.length, "both players mailed").toBe(2);
    expect(second.map((m) => m.deadlineLabel), "after the press").toEqual(second.map((m) => fmt(deadlineAfter(1), m.locale)));
    expect(fmt(OLD, "en"), "premise: the two deadlines read differently").not.toBe(fmt(deadlineAfter(1), "en"));
  });

  it("[extend-reader:resend] the organiser's Resend is WINDOW_CLOSED at P before the press, sends after it, and is closed again at the extended deadline", async () => {
    const { r, id } = await oneBoard();
    expect(await refusal(resendExternalPlayNotice(r.owner, id, ORIGIN, { now: P }))).toEqual({ status: 409, code: "WINDOW_CLOSED" });
    await press(r.owner, id);
    expect(await resendExternalPlayNotice(r.owner, id, ORIGIN, { now: P })).toEqual({ emailed: 2, retrying: 0 });
    expect(await resendExternalPlayNotice(r.owner, id, ORIGIN, { now: at(deadlineAfter(1), -1) })).toEqual({ emailed: 2, retrying: 0 });
    expect(await refusal(resendExternalPlayNotice(r.owner, id, ORIGIN, { now: deadlineAfter(1) }))).toEqual({ status: 409, code: "WINDOW_CLOSED" });
  });

  it("[extend-reader:open-round-view] the organiser's Open round view: a round closed at P shows nothing, and after the press it is back with the new deadline on the round and on its batch", async () => {
    const { r } = await oneBoard();
    const auth = await mintOrgOwnerAuth(r.orgId);
    expect(await listOpenRounds(auth, r.divisionId, { now: P }), "before: closed and nobody owed, so the round is not shown").toEqual([]);
    await press(r.owner, r.boards[0]!.fixtureId);
    const [view] = await listOpenRounds(auth, r.divisionId, { now: P });
    expect(view, "after: the round is open again").toBeDefined();
    expect(view!.deadlineAt, "the round's deadline").toBe(deadlineAfter(1).toISOString());
    expect(view!.batches.map((x) => x.closesAt), "and its batch's").toEqual([deadlineAfter(1).toISOString()]);
    expect(view!.extendableBoards, "one board the round-wide press would reach").toBe(1);
    await press(r.owner, r.boards[0]!.fixtureId);
    const last = await press(r.owner, r.boards[0]!.fixtureId);
    expect(last.extensionsLeft, "premise: the third press used the last one").toBe(0);
    const [full] = await listOpenRounds(auth, r.divisionId, { now: P });
    expect(full!.extendableBoards, "capped: nothing left to extend").toBe(0);
    expect(full!.deadlineAt, "and the deadline is the thrice-extended one").toBe(deadlineAfter(CHECKIN_EXTEND_MAX).toISOString());
  });

  it("[extend-reader:reinvite] a re-open after the old deadline invites the EXTENDED board (not window_closed) and reports the unextended one window_closed", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [ext, plain] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: O })).toMatchObject({ opened: true });
    // Each board has a seat still owed (the first mail never reached the second player), as open-round.test.ts [reader:reinvite].
    await sql`update fixture_external_play set black_emailed_at = null where fixture_id in (${ext.fixtureId}, ${plain.fixtureId})`;
    await press(r.owner, ext.fixtureId);
    mail.sent.length = 0;
    const out = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: P });
    expect(out, "the extended board is invited; the plain one is window_closed").toMatchObject({
      opened: true,
      skipped: [{ fixtureId: plain.fixtureId, reason: "window_closed" }],
    });
    expect(mail.sent.map((m) => m.to), "and only the extended board's owed seat was mailed").toEqual([ext.away.email]);
  });

  it("[extend-reader:qr-checkin] a QR scan keeps a check-in stamped between the old and the new deadline once the board is extended, and re-stamps it before", async () => {
    // The scan runs on the real clock, long after this round's fixed open; the stamp it judges is the one already on file.
    const { r, b, id } = await oneBoard();
    await stampFixtureCheckIn(b.home.personId, id, r.orgId, { at: at(O, MIN) });
    const stampAt = async () => (await sql<{ at: Date }[]>`select checked_in_at as at from fixture_availability where fixture_id = ${id} and person_id = ${b.home.personId}`)[0]!.at;
    await sql`update fixture_availability set checked_in_at = ${P} where fixture_id = ${id} and person_id = ${b.home.personId}`;
    await checkInToFixture(b.home.userId, id);
    expect((await stampAt()).getTime(), "before the press: the stamp is outside the window, the scan re-stamped it to the real now").toBeGreaterThan(deadlineAfter(CHECKIN_EXTEND_MAX).getTime());
    await sql`update fixture_availability set checked_in_at = ${P} where fixture_id = ${id} and person_id = ${b.home.personId}`;
    await press(r.owner, id);
    await checkInToFixture(b.home.userId, id);
    expect((await stampAt()).getTime(), "after the press: inside the window, kept").toBe(P.getTime());
  });

  it("[extend-reader:arbiter-board] the arbiter's board list carries the deadline, the presses left and whether a press is offered - the panel never offers one the door refuses", async () => {
    const { r, id } = await oneBoard();
    const auth = r.owner;
    const read = async (now: Date) => {
      const round = await loadArbiterRound(auth, r.divisionId, { now });
      return { board: round!.boards.find((x) => x.fixtureId === id)!, round: round! };
    };
    const at0 = await read(EXT_AT);
    // Batch 0 opens WINDOW_OPEN_LEAD_MS before the round's open; the screen counts the +5 button against this instant.
    const OPENS = at(O, -WINDOW_OPEN_LEAD_MS).toISOString();
    expect(at0.board.checkin, "inside the window").toEqual({ canExtend: true, refusal: null, extensionsLeft: CHECKIN_EXTEND_MAX, opensAt: OPENS, deadlineAt: OLD.toISOString() });
    expect(at0.round.extendableBoards).toBe(1);
    const closed = await read(P);
    expect(closed.board.checkin, "past the deadline").toMatchObject({ canExtend: false, refusal: "closed", deadlineAt: OLD.toISOString() });
    expect(closed.round.extendableBoards).toBe(0);
    await press(auth, id);
    const after = await read(P);
    expect(after.board.checkin, "after a press, at P").toEqual({ canExtend: true, refusal: null, extensionsLeft: CHECKIN_EXTEND_MAX - 1, opensAt: OPENS, deadlineAt: deadlineAfter(1).toISOString() });
    // The offer agrees with the door: whatever the list says canExtend, a press is accepted - and conversely.
    for (let k = 2; k <= CHECKIN_EXTEND_MAX; k++) await press(auth, id);
    expect((await read(P)).board.checkin, "capped").toMatchObject({ canExtend: false, refusal: "cap_reached", extensionsLeft: 0 });
    expect(await refusal(press(auth, id))).toEqual({ status: 409, code: "CHECKIN_EXTEND_CAP" });
  });

  it("[extend-reader:extend-result] the press answers with the deadline from window.ts's own function, the same one the readers above judge by", async () => {
    const { r, id } = await oneBoard();
    const out = await press(r.owner, id);
    expect(out.deadlineAt).toBe(new Date(await deadlineOf(id)).toISOString());
    expect(out.deadlineAt).toBe(deadlineAfter(1).toISOString());
    expect(WINDOW_OPEN_LEAD_MS, "premise: the answer is the DEADLINE, not the opening").not.toBe(0);
  });
});


// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Review round (PR #992): where the button is DECIDED, on a round that staggers
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!HAS_DB)("the opening of a LATER batch, where the +5 button is decided (a staggered round)", () => {
  // Required camera => the round staggers (the open stores it). A board at rank 2 x CHECKIN_BATCH_SIZE is in batch 2: its check-in
  // opens AT its batch's start, O + 2 gaps (a later batch has no T-10 lead), and closes DEADLINE_AFTER_MS after it. The two plain
  // boards (ranks 0 and 1) are batch 0, open since O - WINDOW_OPEN_LEAD_MS: at the probe instants they are open, the late one is
  // not - so the count of boards a round press would reach is 2 before the late board's opening and 3 at it, by construction.
  const LATE_RANK = 2 * CHECKIN_BATCH_SIZE;
  const LATE_OPENS = at(O, 2 * CHECKIN_BATCH_GAP_MS);
  const BEFORE = at(LATE_OPENS, -1);
  async function staggered() {
    expect(2 * CHECKIN_BATCH_GAP_MS, "premise: the late batch opens inside batch 0's window, so the two plain boards are open at both probes").toBeLessThan(DEADLINE_AFTER_MS);
    const r = await openedRound(2, { camera: "required", ranked: [LATE_RANK] });
    const late = r.ranked[0]!;
    expect((await boardOpenFor(sql, late.fixtureId))!.staggered, "premise: the round staggers").toBe(true);
    return { r, late, auth: await mintOrgOwnerAuth(r.orgId) };
  }

  it("[opens-at:arbiter] the arbiter's board list: the late board is not_open (and not counted) one ms before its batch opens, and extendable AT it; the plain boards are open at both", async () => {
    const { r, late, auth } = await staggered();
    const read = async (now: Date) => {
      const round = (await loadArbiterRound(auth, r.divisionId, { now }))!;
      return { round, late: round.boards.find((b) => b.fixtureId === late.fixtureId)!, plain: round.boards.filter((b) => b.fixtureId !== late.fixtureId) };
    };
    const before = await read(BEFORE);
    expect(before.plain.map((b) => b.checkin?.canExtend), "premise: the two plain boards are open").toEqual([true, true]);
    expect(before.late.checkin, "one ms before the opening").toMatchObject({ canExtend: false, refusal: "not_open", opensAt: LATE_OPENS.toISOString() });
    expect(before.round.extendableBoards, "the late board is not counted").toBe(2);
    const atOpen = await read(LATE_OPENS);
    expect(atOpen.late.checkin, "AT the opening").toMatchObject({ canExtend: true, refusal: null, opensAt: LATE_OPENS.toISOString() });
    expect(atOpen.round.extendableBoards).toBe(3);
    // The door agrees on both sides: the same instant, the same answer.
    expect(await refusal(press(auth, late.fixtureId, BEFORE))).toEqual({ status: 409, code: "CHECKIN_NOT_OPEN" });
    expect(await press(auth, late.fixtureId, LATE_OPENS)).toMatchObject({ extensions: 1 });
  });

  it("[opens-at:open-round-view] the organiser's Open round view: the late board is not counted one ms before its batch opens and is AT it; the windows it hands the screen carry each board's own opening and deadline", async () => {
    const { r, late, auth } = await staggered();
    const view = async (now: Date) => (await listOpenRounds(auth, r.divisionId, { now })).find((v) => v.roundNo === 1)!;
    const before = await view(BEFORE);
    expect(before.extendableBoards, "one ms before").toBe(2);
    const atOpen = await view(LATE_OPENS);
    expect(atOpen.extendableBoards, "at the opening").toBe(3);
    // The windows: one per board that is still to be played with nothing on file and presses left, whatever the clock says.
    const lateWindow = { opensAt: LATE_OPENS.toISOString(), deadlineAt: at(LATE_OPENS, DEADLINE_AFTER_MS).toISOString(), extensionsLeft: CHECKIN_EXTEND_MAX };
    const plainWindow = { opensAt: at(O, -WINDOW_OPEN_LEAD_MS).toISOString(), deadlineAt: OLD.toISOString(), extensionsLeft: CHECKIN_EXTEND_MAX };
    expect([...before.extendWindows].sort((a, b) => a.opensAt.localeCompare(b.opensAt))).toEqual([plainWindow, plainWindow, lateWindow]);
    // The count is the windows' own count at the clock: one authority, read two ways.
    for (const v of [before, atOpen]) {
      const now = v === before ? BEFORE : LATE_OPENS;
      expect(liveExtendableCount(v.extendWindows, now.getTime())).toBe(v.extendableBoards);
    }
    expect(late.fixtureId, "anti-vacuity: the late board was part of this round").toBeTruthy();
  });
});


describe.skipIf(!HAS_DB)("a refusal writes nothing - not even a bridge row (review I-writes)", () => {
  /** A one-board-per-case round: board 0 withdrawn with no row, board 1 plain with no row, board 2 untouched with its row. */
  async function withoutRows() {
    const r = await openedRound(3);
    const [withdrawn, plain, kept] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await sql`update fixtures set status = 'abandoned' where id = ${withdrawn.fixtureId}`;
    await sql`delete from fixture_external_play where fixture_id in (${withdrawn.fixtureId}, ${plain.fixtureId})`;
    expect([await rowOf(withdrawn.fixtureId), await rowOf(plain.fixtureId)], "premise: neither board has a bridge row").toEqual([null, null]);
    return { r, withdrawn, plain, kept };
  }

  it("a round press mints no row for a withdrawn board, mints one only for a board it extends, and leaves the rest as they were", async () => {
    const { r, withdrawn, plain, kept } = await withoutRows();
    const out = await pressRound(r.owner, r);
    expect(out, "the withdrawn board is not counted anywhere").toMatchObject({ extended: 2, failed: 0, skipped: { closed: 0, gameStarted: 0, capReached: 0 } });
    expect(await rowOf(withdrawn.fixtureId), "withdrawn: refused, so nothing written").toBeNull();
    expect(await rowOf(plain.fixtureId), "extended: the press made its row").toMatchObject({ checkin_extensions: 1 });
    expect(await rowOf(kept.fixtureId)).toMatchObject({ checkin_extensions: 1 });
    expect((await auditOf(withdrawn.fixtureId)).length).toBe(0);
  });

  it("a round press that finds every board closed mints no row on a board without one", async () => {
    const { r, plain } = await withoutRows();
    expect(await pressRound(r.owner, r, P)).toMatchObject({ extended: 0, skipped: { closed: 2 } });
    expect(await rowOf(plain.fixtureId), "closed: refused, so nothing written").toBeNull();
  });

  it("a single press on a withdrawn board, or on a closed one, is refused and mints no row", async () => {
    const { r, withdrawn, plain } = await withoutRows();
    expect(await refusal(press(r.owner, withdrawn.fixtureId))).toEqual({ status: 409, code: "FIXTURE_NOT_PLAYABLE" });
    expect(await refusal(press(r.owner, plain.fixtureId, P))).toEqual({ status: 409, code: "CHECKIN_CLOSED" });
    expect([await rowOf(withdrawn.fixtureId), await rowOf(plain.fixtureId)], "nothing written by either refusal").toEqual([null, null]);
  });
});

describe.skipIf(!HAS_DB)("a re-arm inside a running window keeps the board's extension (review I-rearm)", () => {
  const lastEvent = async (fixtureId: string) =>
    (await sql<{ id: string; seq: number }[]>`select id, seq from score_events where fixture_id = ${fixtureId} order by seq desc limit 1`)[0]!;

  it("No result, void, then a re-open at an instant past the OLD deadline and inside the extended one: the re-armed board is invited again and keeps its time; an unextended one is window_closed", async () => {
    // Two boards, both extended or not as the cases below need; the neighbour stays playable so the window is NOT re-stamped (kind
    // `reinvited`: the window keeps running and the re-armed board is invited back into it).
    const r = await seedOnlineChessRound({ fixtures: 3 });
    const [ext, plain, neighbour] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: O })).toMatchObject({ opened: true });
    await press(r.owner, ext.fixtureId); // the arbiter granted this board five more minutes
    // The arbiter's No result on both boards, then the organiser's undo (the real producers); the neighbour is left playable.
    for (const b of [ext, plain]) {
      expect(await resolveExternalPlay(r.owner, b.fixtureId, "no_result")).toEqual({ status: "finished" });
      const last = await lastEvent(b.fixtureId);
      await scoreEvent(r.owner, b.fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
      expect(await rowOf(b.fixtureId), "premise: closed, no game on file").toMatchObject({ status: "finished", challenge_id: null });
    }
    expect(await rowOf(ext.fixtureId), "premise: the extension is still on the closed row").toMatchObject({ checkin_extensions: 1 });
    mail.sent.length = 0;

    const out = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: P });
    expect(out, "the extended board is invited back; the plain one is closed at P").toMatchObject({
      opened: true,
      skipped: [{ fixtureId: plain.fixtureId, reason: "window_closed" }],
    });
    expect(mail.sent.map((m) => m.to).sort(), "only the extended board's two players were mailed").toEqual([ext.home.email, ext.away.email].sort());
    // The re-armed row is a fresh one for the same open - and carries the time the arbiter granted.
    expect(await rowOf(ext.fixtureId)).toMatchObject({ status: "pending", checkin_extra_ms: CHECKIN_EXTEND_STEP_MS, checkin_extensions: 1 });
    expect(await deadlineOf(ext.fixtureId), "the board's deadline is still the extended one").toBe(deadlineAfter(1).getTime());
    expect(mail.sent.every((m) => m.deadlineLabel.length > 0), "anti-vacuity: the mail was written").toBe(true);
    expect(neighbour.fixtureId, "the neighbour was never touched").toBeTruthy();
  });

  it("a re-open that skips a CLOSED board keeps that board's row, and the sweep that follows does not forfeit it (the row it had is what keeps it out of the no-show)", async () => {
    // The same round as above, read for the board the open did NOT invite. `plain` was closed by the arbiter (No result, void) and its
    // own window has passed at P: the re-open answers it `window_closed` and invites nobody into it. Re-arming deletes a bridge row so
    // the invite can mint a fresh one; a board that is not invited has no fresh one coming, and a board with NO row is a no-show
    // candidate (sweep.ts noShowCandidates: `ep.fixture_id is null`) - so deleting it would hand the very board the open refused to
    // the sweep's walkover.
    const r = await seedOnlineChessRound({ fixtures: 3 });
    const [ext, plain, neighbour] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: O })).toMatchObject({ opened: true });
    await press(r.owner, ext.fixtureId);
    for (const b of [ext, plain]) {
      expect(await resolveExternalPlay(r.owner, b.fixtureId, "no_result")).toEqual({ status: "finished" });
      const last = await lastEvent(b.fixtureId);
      await scoreEvent(r.owner, b.fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
    }
    const before = await rowOf(plain.fixtureId);
    expect(before, "premise: the closed board has a row, finished, no game on file").toMatchObject({ status: "finished", challenge_id: null });
    const noShowKey = (id: string) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id} and idempotency_key = ${`extplay-noshow:${id}`}`;

    const out = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: P });
    expect(out, "premise: the plain board is the one the open refused").toMatchObject({ opened: true, skipped: [{ fixtureId: plain.fixtureId, reason: "window_closed" }] });
    expect(await rowOf(plain.fixtureId), "the refused board keeps the row it had").toEqual(before);

    const report = await sweepExternalPlay({ now: P, orgIds: [r.orgId] });
    expect(report.noShows, "the sweep forfeits the board nobody refused (the unextended neighbour, closed at P) and no other").toBe(1);
    expect((await noShowKey(neighbour.fixtureId))[0]!.n, "anti-vacuity: the sweep did act on a candidate").toBe(1);
    expect((await noShowKey(plain.fixtureId))[0]!.n, "the refused, closed board is not forfeited").toBe(0);
    expect(await rowOf(plain.fixtureId), "and its row is still the one it had").toEqual(before);
  });

  it("a re-open that restarts the window (every neighbour decided) still starts a re-armed board at zero: only a RUNNING window keeps the time", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [a, b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: O })).toMatchObject({ opened: true });
    await press(r.owner, a.fixtureId);
    // The neighbour is decided on the pad, so the only playable board is the re-armed one: the window starts again.
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.owner, b.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: b.home.entrantId, method: "resign" } });
    expect(await resolveExternalPlay(r.owner, a.fixtureId, "no_result")).toEqual({ status: "finished" });
    const last = await lastEvent(a.fixtureId);
    await scoreEvent(r.owner, a.fixtureId, { expected_seq: last.seq, type: "core.void", payload: { event_id: last.id } });
    const later = at(O, 3 * MIN);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: later })).toMatchObject({ opened: true });
    expect(await rowOf(a.fixtureId), "the new window's board starts without the last window's time").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    expect(await deadlineOf(a.fixtureId)).toBe(at(later, DEADLINE_AFTER_MS).getTime());
  });
});


describe.skipIf(!HAS_DB)("the database's clock decides, not this machine's (review I-clock)", () => {
  // The machine's clock is moved with fake timers (Date only: the driver's own timers stay real); the DATABASE's is not. No `now`
  // is injected anywhere below: this is the production path.
  const HOUR = 60 * MIN;
  const skewed = async <T>(by: number, run: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + by));
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
  };
  /** A one-board round opened `ago` ms before the DATABASE's real now (the stamp is in real time: the pass reads the machine's, skewed). */
  async function openedAgo(ago: number) {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: new Date(Date.now() - ago) })).toMatchObject({ opened: true });
    return { r, id: r.boards[0]!.fixtureId };
  }
  const noShowEvents = async (fixtureId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and idempotency_key like 'extplay-noshow:%'`)[0]!.n;
  const pass = (r: SeedOnlineChessRoundResult) => sweepExternalPlay({ orgIds: [r.orgId], serialise: false, endMeeting: async () => undefined });

  it("a machine clock an hour AHEAD does not refuse a press on a board whose window is open by the database's clock - and one an hour BEHIND does not accept a press on a closed one", async () => {
    const open = await openedAgo(5 * MIN); // open until ~5 minutes from now
    expect(await skewed(HOUR, () => extendCheckin(open.r.owner, open.id, { publish: async () => {} })), "fast machine, open board").toMatchObject({ extensions: 1 });
    const closed = await openedAgo(DEADLINE_AFTER_MS + 5 * MIN); // closed ~5 minutes ago
    expect(await skewed(-HOUR, () => refusal(extendCheckin(closed.r.owner, closed.id, { publish: async () => {} }))), "slow machine, closed board").toEqual({
      status: 409,
      code: "CHECKIN_CLOSED",
    });
    expect(await rowOf(closed.id), "and the refusal wrote nothing").toMatchObject({ checkin_extensions: 0 });
  });

  it("the round press reads the same clock", async () => {
    const open = await openedAgo(5 * MIN);
    expect(await skewed(HOUR, () => extendRoundCheckin(open.r.owner, { stageId: open.r.stageId, roundNo: 1 }, { publish: async () => {} }))).toMatchObject({ extended: 1, skipped: { closed: 0 } });
  });

  it("the sweep's no-show does not forfeit a board still open by the database's clock, whatever the machine's says - and still forfeits one that is closed by it (the control)", async () => {
    const open = await openedAgo(5 * MIN);
    const report = await skewed(HOUR, () => pass(open.r));
    expect(report.noShows, "a fast machine clock cannot close the window early").toBe(0);
    expect(await noShowEvents(open.id)).toBe(0);
    // The control: the same pass on a board that IS closed by the database's clock forfeits, so the zero above is not a dead sweep.
    const closed = await openedAgo(DEADLINE_AFTER_MS + 5 * MIN);
    const control = await pass(closed.r);
    expect(control.noShows, "premise: a closed board with nobody checked in is a no-show").toBeGreaterThan(0);
    expect(await noShowEvents(closed.id)).toBeGreaterThan(0);
  });

  it("the sweep's teardown does not end the room of a board still open by the database's clock, whatever the machine's says - and ends one that is closed by it (the control)", async () => {
    const open = await openedAgo(5 * MIN);
    const closed = await openedAgo(DEADLINE_AFTER_MS + 5 * MIN);
    const meetings = new Map<string, string>();
    for (const x of [open, closed]) meetings.set(x.id, await putVideoMeeting({ fixtureId: x.id, orgId: x.r.orgId, side: "home" }));
    const ended: string[] = [];
    const endMeeting: NonNullable<SweepDeps["endMeeting"]> = async (m) => void ended.push(m);
    await skewed(HOUR, () => sweepExternalPlay({ orgIds: [open.r.orgId], serialise: false, endMeeting }));
    expect(ended, "a fast machine clock cannot end the room of a board that is still open").toEqual([]);
    await sweepExternalPlay({ orgIds: [closed.r.orgId], serialise: false, endMeeting });
    expect(ended, "the control: a room on a board closed by the database's clock is ended").toEqual([meetings.get(closed.id)]);
  });
});



// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE INVITES - Task 8: the email outbox's queued invites follow the extension
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// An invite is queued with `expires_at` = the board's check-in deadline, and the worker ends a queued row past it `expired`, unsent. A
// press moves the deadline later, so the same press moves the expiry of every invite that can still be sent (`extendEmailExpiry`, in
// the extension's own transaction): a retry between the old deadline and the new one is delivered, not expired. Driven through the
// real producers (`openRound` writes the rows, `extendCheckin` / `extendRoundCheckin` move them, `runOutboxTick` retries them); only the
// provider's answer is ours.
/** The deadline of a board opened at `open` after `k` presses (the constants, not window.ts's function). */
const deadlineOfPress = (open: Date, k: number): Date => at(open, DEADLINE_AFTER_MS + k * CHECKIN_EXTEND_STEP_MS);

describe.skipIf(!HAS_DB)("extendCheckin - the queued invites' expiry follows the extension (Task 8)", () => {
  afterEach(() => {
    mail.retryAll = false;
  });
  /** The open's instant for which the REAL clock sits between the board's old deadline and the one after a press: the worker judges expiry
   *  on the database's clock, which no test can set, so the round is opened a deadline and half a step ago. */
  const openAround = (): Date => new Date(Date.now() - DEADLINE_AFTER_MS - CHECKIN_EXTEND_STEP_MS / 2);
  /** A round opened while the provider answers 503: every invite is left `queued` (attempt 1 spent) for the worker. */
  async function retryingRound(fixtures: number, open: Date): Promise<OpenedRound> {
    mail.retryAll = true;
    try {
      return await openedRound(fixtures, { open });
    } finally {
      mail.retryAll = false;
    }
  }
  type InviteRow = { id: string; status: string; expires_at: Date };
  /** Every invite of a board: both seats, every recipient. */
  const invitesOf = (fixtureId: string) =>
    sql<InviteRow[]>`
      select id, status, expires_at from email_outbox
       where kind = 'chess_invite' and ref_type = ${CHESS_SEAT_REF_TYPE}
         and ref_id in (${chessSeatRef(fixtureId, "white")}, ${chessSeatRef(fixtureId, "black")})
       order by ref_id, id`;
  const ids = (rows: InviteRow[]): string[] => rows.map((r) => r.id);
  const makeDue = (rows: InviteRow[]) =>
    sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = any(${ids(rows)}::uuid[])`;
  const tick = (rows: InviteRow[]) => runOutboxTick({ onlyIds: ids(rows), sleep: async () => undefined });
  const expiries = (rows: InviteRow[]): number[] => rows.map((r) => r.expires_at.getTime());

  it("an extension moves a queued invite's expires_at to the new deadline, so a retry between the old and the new deadline is delivered, not expired (Review Focus 1)", async () => {
    const open = openAround();
    const r = await retryingRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    const before = await invitesOf(fixtureId);
    expect(before.length, "premise: both seats were invited").toBeGreaterThanOrEqual(2);
    expect(before.map((x) => x.status), "premise: every invite is waiting for the worker").toEqual(before.map(() => "queued"));
    expect(expiries(before), "premise: each invite expires at the board's deadline").toEqual(before.map(() => oldDeadline.getTime()));
    expect(Date.now(), "premise: the real clock is past the old deadline ...").toBeGreaterThan(oldDeadline.getTime());
    expect(Date.now(), "... and before the new one").toBeLessThan(newDeadline.getTime());

    const out = await press(r.owner, fixtureId, at(open, MIN));
    expect(out.deadlineAt, "the deadline the press reports").toBe(newDeadline.toISOString());
    const after = await invitesOf(fixtureId);
    expect(ids(after), "the same rows").toEqual(ids(before));
    expect(expiries(after), "every invite now expires at the NEW deadline").toEqual(after.map(() => newDeadline.getTime()));

    await makeDue(after);
    mail.sent.length = 0;
    expect(await tick(after)).toMatchObject({ claimed: after.length, sent: after.length, expired: 0 });
    expect((await invitesOf(fixtureId)).map((x) => x.status), "delivered, not expired").toEqual(after.map(() => "sent"));
    expect(mail.sent.length, "the provider got every invite").toBe(after.length);
  });

  it("the control: the same retrying invites with NO press are expired by the worker at that same instant (so the delivery above is the extension's)", async () => {
    const r = await retryingRound(1, openAround());
    const fixtureId = r.boards[0]!.fixtureId;
    const rows = await invitesOf(fixtureId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    await makeDue(rows);
    mail.sent.length = 0;
    expect(await tick(rows)).toMatchObject({ claimed: 0, sent: 0, expired: rows.length });
    expect((await invitesOf(fixtureId)).map((x) => x.status)).toEqual(rows.map(() => "expired"));
    expect(mail.sent, "nothing was mailed after the deadline").toEqual([]);
  });

  it("moves only the extended board's invites - both seats, every recipient - and not the neighbour board's", async () => {
    const open = openAround();
    const r = await retryingRound(2, open);
    const [a, b] = r.boards.map((x) => x.fixtureId) as [string, string];
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const [aBefore, bBefore] = [await invitesOf(a), await invitesOf(b)];
    expect(aBefore.length + bBefore.length, "premise: both boards were invited").toBeGreaterThanOrEqual(4);
    await press(r.owner, a, at(open, MIN));
    expect(expiries(await invitesOf(a))).toEqual(aBefore.map(() => at(oldDeadline, CHECKIN_EXTEND_STEP_MS).getTime()));
    expect(expiries(await invitesOf(b)), "the neighbour's invites are not moved").toEqual(bBefore.map(() => oldDeadline.getTime()));
  });

  it("each press moves the expiry again (a second press: a second step), and a refused press moves nothing", async () => {
    const open = openAround();
    const r = await retryingRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    await press(r.owner, fixtureId, at(open, MIN));
    await press(r.owner, fixtureId, at(open, 2 * MIN));
    const moved = await invitesOf(fixtureId);
    expect(expiries(moved)).toEqual(moved.map(() => deadlineOfPress(open, 2).getTime()));
    // A press after the deadline the board is on is refused (CHECKIN_CLOSED) and writes nothing - not the board's, not the invites'.
    const before = await invitesOf(fixtureId);
    expect(await refusal(press(r.owner, fixtureId, deadlineOfPress(open, 2)))).toEqual({ status: 409, code: "CHECKIN_CLOSED" });
    expect(expiries(await invitesOf(fixtureId))).toEqual(expiries(before));
  });

  it("an invite the provider already took (`sent`) is not touched: the extension is for mail still waiting to go", async () => {
    const open = openAround();
    const r = await openedRound(1, { open }); // the provider answers 200: every invite is `sent`
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await invitesOf(fixtureId);
    expect(before.map((x) => x.status), "premise: the invites were sent").toEqual(before.map(() => "sent"));
    expect(before.length).toBeGreaterThanOrEqual(2);
    await press(r.owner, fixtureId, at(open, MIN));
    expect(expiries(await invitesOf(fixtureId))).toEqual(expiries(before));
  });

  it("the round-wide press moves the invites of the boards it extended and not those of a board it skipped", async () => {
    const open = openAround();
    const r = await retryingRound(2, open);
    const [moved, skipped] = r.boards.map((x) => x.fixtureId) as [string, string];
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    await sql`update fixture_external_play set challenge_id = ${`gm-${randomUUID().slice(0, 8)}`}, status = 'ready', white_side = 'home' where fixture_id = ${skipped}`;
    const out = await pressRound(r.owner, r, at(open, MIN));
    expect(out, "premise: one board extended, one skipped (a game is on it)").toMatchObject({ extended: 1, skipped: { gameStarted: 1 } });
    const movedRows = await invitesOf(moved);
    expect(movedRows.length).toBeGreaterThanOrEqual(2);
    expect(expiries(movedRows)).toEqual(movedRows.map(() => at(oldDeadline, CHECKIN_EXTEND_STEP_MS).getTime()));
    const skippedRows = await invitesOf(skipped);
    expect(expiries(skippedRows), "the skipped board's invites keep their deadline").toEqual(skippedRows.map(() => oldDeadline.getTime()));
  });

  it("the extension and the expiry move TOGETHER: when the expiry move fails, the deadline, the press count and the audit row roll back with it", async () => {
    const open = openAround();
    const r = await retryingRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const before = await invitesOf(fixtureId);

    expiryFault.fail = true;
    await expect(press(r.owner, fixtureId, at(open, MIN))).rejects.toThrow("the expiry move blew up");
    expect(await rowOf(fixtureId), "the board's deadline did not move").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    expect((await auditOf(fixtureId)).length, "no audit row was kept").toBe(0);
    expect(expiries(await invitesOf(fixtureId)), "the invites keep their deadline").toEqual(before.map(() => oldDeadline.getTime()));

    // The positive pair: with the fault gone the same press goes through, so the rollback above was the fault's.
    expiryFault.fail = false;
    expect(await press(r.owner, fixtureId, at(open, MIN))).toMatchObject({ extensions: 1 });
    expect(await rowOf(fixtureId)).toMatchObject({ checkin_extensions: 1 });
    expect(expiries(await invitesOf(fixtureId))).toEqual(before.map(() => at(oldDeadline, CHECKIN_EXTEND_STEP_MS).getTime()));
  });

  it("T8-R1: the extension's transaction is the pooled (privileged) connection, never a tenant one - V469 gives app_user INSERT only, so a tenant transaction could not move the expiry", () => {
    const src = readFileSync(new URL("../external-play/checkin-extend.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src, "the board's step opens its transaction on the pool").toMatch(/return sql\.begin\(async \(tx\)/);
    expect(src, "and never goes through withTenant (app_user)").not.toMatch(/withTenant/);
    expect(src, "and calls the outbox's expiry move on that transaction").toMatch(/extendEmailExpiry\(\s*tx,/);
  });
});

void LINE_DEADLINE_GRACE_MS;
