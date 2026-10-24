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
import { connectionOptions, sql } from "@/lib/db";
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
// `retry`: the addresses the provider answers 503 for (the rest are accepted), so one seat can hold a sent invite beside a queued one.
// `rateAll`: while set, the provider answers every send 429 (it refused before doing anything: an invite the extension may re-render).
// `networkAll`: while set, every send fails in the network (the request may have reached the provider: an invite it must not re-render).
const mail = vi.hoisted(() => ({
  sent: [] as SentInvite[],
  fail: new Set<string>(),
  retry: new Set<string>(),
  retryAll: false,
  rateAll: false,
  networkAll: false,
}));
// `renderFault`: while set, rendering an invite throws (the re-render's failure is logged and the extension goes through without it).
// `pass` is how many renders succeed first, so a fault can strike AFTER some of the board's fresh rows were already written: only a
// savepoint takes those back (a throw that precedes every write would leave the same rows with or without one).
const renderFault = vi.hoisted(() => ({ fail: false, pass: 0, seen: 0 }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return {
    ...actual,
    externalPlayInviteEmail: (...args: Parameters<typeof h.renderInviteForTest>) => {
      if (renderFault.fail && renderFault.seen++ >= renderFault.pass) throw new Error("the invite could not be rendered");
      return h.renderInviteForTest(...args);
    },
  };
});
// The invite is queued on the email outbox and sent after commit through its one network seam; the provider's answer is ours.
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return {
    deliver: (msg: DeliverMessage) =>
      mail.rateAll
        ? Promise.resolve({ ok: false as const, reason: "http" as const, status: 429, errorName: "rate_limit_exceeded", detail: "slow down" })
        : mail.networkAll
          ? Promise.resolve({ ok: false as const, reason: "network" as const, detail: "timeout" })
          : mail.retryAll
            ? Promise.resolve({ ok: false as const, reason: "http" as const, status: 503, errorName: "service_unavailable", detail: "later" })
            : h.deliverForTest(mail, msg),
  };
});
// The outbox's expiry move, wrapped so a test can make it throw INSIDE the extension's transaction (the atomicity test). Every other
// export, and every other call, is the real module's.
const expiryFault = vi.hoisted(() => ({ fail: false }));
// `carryFault.skip`: the retry-budget copy matches nothing (the check on its count is what a test of it needs to reach).
const carryFault = vi.hoisted(() => ({ skip: false }));
vi.mock("@/server/email-outbox/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox/enqueue")>();
  return {
    ...actual,
    extendEmailExpiry: async (...args: Parameters<typeof actual.extendEmailExpiry>) => {
      if (expiryFault.fail) throw new Error("the expiry move blew up");
      return actual.extendEmailExpiry(...args);
    },
    carryRetryBudget: async (...args: Parameters<typeof actual.carryRetryBudget>) => (carryFault.skip ? 0 : actual.carryRetryBudget(...args)),
  };
});
// How many times the extension read the board's seats (the pooled reads it must make OUTSIDE its transaction, and only when an invite is
// waiting): `boardSeats` as the extension imports it, counted; the real function answers.
const seatReads = vi.hoisted(() => ({ n: 0 }));
vi.mock("../external-play/invite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-play/invite")>();
  return {
    ...actual,
    boardSeats: (...args: Parameters<typeof actual.boardSeats>) => {
      seatReads.n += 1;
      return actual.boardSeats(...args);
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
import { extendCheckin, extendRoundCheckin, type ExtendDeps } from "../external-play/checkin-extend";
import { CHESS_SEAT_REF_TYPE, chessSeatRef } from "../external-play/seat-stamp";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { seatPlayer } from "../external-play/preflight";
import { claimRoomSeat, readRoom, type RoomDeps } from "../external-play/room";
import { resendExternalPlayNotice, seatOutcome } from "../external-play/invite";
import { chessInviteEndedBadly, findUnappliedChessEndings } from "../external-play/invite-outbox-hook";
import { dispatchNow, latestEmailStatus, latestStatusesOfRows } from "@/server/email-outbox";
import { OUTBOX_STATUSES, RETRYABLE_STATUSES } from "@/server/email-outbox/constants";
import { openBody } from "@/server/email-outbox/seal";
import { log } from "@/server/logger";
import { listOpenRounds } from "../external-play/open-round-view";
import { loadArbiterRound } from "../external-play/arbiter";
import { playableWindow, sweepExternalPlay, type SweepDeps } from "../external-play/sweep";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { stampFixtureCheckIn, checkInToFixture } from "../me";
import type { AuthCtx } from "@/server/api-v1/auth";
import { putVideoMeeting, seedOnlineChessRound, seedOwner, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
/** A sweep pass that does not take the sweep's global lock. Test files share one database, and the serialised pass takes ONE advisory lock
 *  (sweep.ts `SWEEP_LOCK`) and returns an empty, `skipped` report when another pass holds it - so two files sweeping at the same moment
 *  make each other's passes vanish (reproduced on a clean origin/main with external-play-sweep.test.ts: its own passes and this file's
 *  came back empty). Every pass here is scoped to the orgs of its own test (`orgIds`), so it needs no lock: it neither waits for it nor
 *  holds it. */
const sweepIsolated = (deps: SweepDeps) => sweepExternalPlay({ serialise: false, ...deps });
const MIN = 60_000;
const ORIGIN = "https://seazn.test";

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  mail.sent.length = 0;
  mail.retry.clear();
  mail.retryAll = false;
  mail.rateAll = false;
  mail.networkAll = false;
  expiryFault.fail = false;
  carryFault.skip = false;
  renderFault.fail = false;
  renderFault.pass = 0;
  renderFault.seen = 0;
  seatReads.n = 0;
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
  const sweepAt = (r: SeedOnlineChessRoundResult, now: Date, over: SweepDeps = {}) => sweepIsolated({ ...over, now, orgIds: [r.orgId] });
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
      await sweepIsolated({ now: P, orgIds: [a.orgId, b.orgId], endMeeting });
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
    expect((await sweepIsolated({ now: P, orgIds: [plain.r.orgId, ext.r.orgId] })).noShows, "at P: the unextended board only").toBe(1);
    expect([await status(plain.id), await status(ext.id)], "walked over / left alone").toEqual(["forfeited", "scheduled"]);
    expect((await sweepIsolated({ now: at(deadlineAfter(1), -1), orgIds: [ext.r.orgId] })).noShows, "1 ms before the extended deadline").toBe(0);
    expect((await sweepIsolated({ now: deadlineAfter(1), orgIds: [ext.r.orgId] })).noShows, "at the extended deadline").toBe(1);
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
    await sweepIsolated({ now: P, orgIds: [plain.r.orgId, ext.r.orgId], endMeeting });
    expect(ended, "at P: the unextended board's room is ended, the extended one is not").toEqual([meetings.get(plain.id)]);
    await sweepIsolated({ now: at(deadlineAfter(1), -1), orgIds: [ext.r.orgId], endMeeting });
    expect(ended, "1 ms before the extended deadline").toEqual([meetings.get(plain.id)]);
    await sweepIsolated({ now: deadlineAfter(1), orgIds: [ext.r.orgId], endMeeting });
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

    const report = await sweepIsolated({ now: P, orgIds: [r.orgId] });
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

describe.skipIf(!HAS_DB)("extendCheckin - the queued invites' expiry follows the extension (Task 8)", () => {
  afterEach(() => {
    mail.retryAll = false;
  });
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
    expect(ids(after), "the same rows: an invite that has already been attempted is NOT re-rendered (section 5), only its expiry moves").toEqual(ids(before));
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

  it("and when the COMMIT itself fails, the expiry is rolled back with the extension: the move rides the extension's transaction, not the pool", async () => {
    // Nothing after the expiry move can fail inside the callback, so a move made on the POOL (a second connection) instead of the
    // transaction survives every test above. A deferred constraint trigger that refuses at COMMIT is what tells them apart. It is
    // keyed to this board, so it is inert for every other test running against the shared database.
    const open = openAround();
    const r = await retryingRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const before = await invitesOf(fixtureId);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const fn = `t8_commit_fault_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'commit refused (Task 8 test)'; end $$`);
    await sql.unsafe(
      `create constraint trigger ${fn} after insert on online_chess_audit deferrable initially deferred for each row when (new.fixture_id = '${fixtureId}') execute function ${fn}()`,
    );
    try {
      await expect(press(r.owner, fixtureId, at(open, MIN))).rejects.toThrow(/commit refused/);
      expect(await rowOf(fixtureId), "the extension rolled back").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
      expect((await auditOf(fixtureId)).length).toBe(0);
      expect(expiries(await invitesOf(fixtureId)), "and the expiry with it").toEqual(before.map(() => oldDeadline.getTime()));
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on online_chess_audit`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    // The positive pair: without the fault the same press goes through and moves the invites.
    expect(await press(r.owner, fixtureId, at(open, MIN))).toMatchObject({ extensions: 1 });
    expect(expiries(await invitesOf(fixtureId))).toEqual(before.map(() => at(oldDeadline, CHECKIN_EXTEND_STEP_MS).getTime()));
  });

  it("T8-R1: the extension's transaction is the pooled (privileged) connection, never a tenant one - V470 gives app_user INSERT only, so a tenant transaction could not move the expiry", () => {
    const src = readFileSync(new URL("../external-play/checkin-extend.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src, "the board's step opens its transaction on the pool").toMatch(/return sql\.begin\(async \(tx\)/);
    expect(src, "and never goes through withTenant (app_user)").not.toMatch(/withTenant/);
    expect(src, "and calls the outbox's expiry move on that transaction").toMatch(/extendEmailExpiry\(\s*tx,/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE INVITES, RE-RENDERED - an invite still waiting to go out must not name a deadline that has passed
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// An invite's SEALED BODY names the deadline the board had when it was written. Task 8 moved the expiry of a waiting row, so it is not
// ended unsent - but it would still go out, later, saying "check in by <the old time>". Controller ruling (not an owner ruling):
// re-render only what has NOT gone out, and NEVER send an extra mail - the second outranks the first. In the extension's own
// transaction, every recipient whose newest non-replaced row is `queued` AND that no request can have reached the provider with (never
// attempted, or its only attempt answered 429) gets a fresh row with the NEW deadline and the SAME stamp (the V470 replace trigger retires the
// stale one). Any other row is not touched: a `sending`, `sent`, `delayed`, `delivered` or ended one is out of reach, and a queued one
// whose earlier attempt ended in a network error or a 5xx may have been ACCEPTED with the answer lost - a fresh row has a new
// idempotency key and would mail the recipient twice - so it keeps its key and body and only its expiry moves. After the commit the
// fresh rows are dispatched like the open's. Driven through the real producers (`openRound`, `resend`, `extendCheckin` /
// `extendRoundCheckin`, `runOutboxTick`); only the provider's answer is ours. The expected deadline is written from the constants and
// read in the mail as its MINUTE (":MM" of the UTC instant), never from the formatter under test.
type OutboxRow = {
  id: string;
  ref_id: string;
  recipient: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  expires_at: Date;
  provider_id: string | null;
  body_sealed: Buffer | null;
  meta: { fixtureId: string; colour: "white" | "black"; stampedAt: string };
};
/** Every outbox row of a board's two seats, `replaced` ones too (the first-written first). */
const outboxOf = (fixtureId: string) =>
  sql<OutboxRow[]>`
    select id, ref_id, recipient, status, attempts, next_attempt_at, last_error, expires_at, provider_id, body_sealed, meta
      from email_outbox
     where kind = 'chess_invite' and ref_type = ${CHESS_SEAT_REF_TYPE}
       and ref_id in (${chessSeatRef(fixtureId, "white")}, ${chessSeatRef(fixtureId, "black")})
     order by created_at, ref_id, recipient, id`;
/** What the seat is keyed by in the outbox: the ref and the recipient, case-folded as the replace rule folds it. */
const keyOf = (x: OutboxRow): string => `${x.ref_id}|${x.recipient.toLowerCase()}`;
const byKey = (rows: OutboxRow[]): Map<string, OutboxRow> => new Map(rows.map((x) => [keyOf(x), x]));
type RenderedInvite = { to: string; args: { deadlineLabel: string; opensLabel?: string; fixtureUrl: string; roundNo: number }; locale: string };
/** The email as the sender rendered it (the test seam writes its arguments as JSON in the text), opened from the sealed body. */
const renderedOf = (x: OutboxRow): RenderedInvite => {
  if (x.body_sealed === null) throw new Error(`row ${x.id} (${x.status}) holds no body to read`);
  return JSON.parse(openBody(x.body_sealed).text) as RenderedInvite;
};
const minuteOf = (d: Date): string => d.toISOString().slice(14, 16);
/** Does this label name that instant? By its minute: the deadlines in play are 5 minutes apart, so no two share one. */
const namesDeadline = (label: string, d: Date): boolean => label.includes(`:${minuteOf(d)}`);
type Stamps = { white: Date | null; black: Date | null };
const stampsOf = async (fixtureId: string): Promise<Stamps> =>
  (await sql<Stamps[]>`select white_emailed_at as white, black_emailed_at as black from fixture_external_play where fixture_id = ${fixtureId}`)[0]!;
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const idsOf = (rows: { id: string }[]): string[] => rows.map((x) => x.id).sort();
/** Make queued rows read as never attempted (a row the open's dispatch deferred), the state a fresh first send starts from. */
const neverAttempted = (rows: { id: string }[]) =>
  sql`update email_outbox set attempts = 0, next_attempt_at = now(), last_error = null where id = any(${idsOf(rows)}::uuid[]) and status = 'queued'`;
/** A round opened while the provider answers 429 - it refused the request before doing anything, the one ATTEMPTED state an extension may
 *  re-render: every invite is left `queued`, attempt 1 spent, `last_error` = `http 429 rate_limit_exceeded` (what `attempt.ts` writes).
 *  The open's dispatch stops at its first 429 and leaves the rest unattempted, so each remaining row gets its own first attempt through
 *  the same real send. */
async function rateLimitedRound(fixtures: number, open: Date): Promise<OpenedRound> {
  mail.rateAll = true;
  try {
    const r = await openedRound(fixtures, { open });
    for (const b of r.boards) {
      const todo = (await outboxOf(b.fixtureId)).filter((x) => x.status === "queued" && x.attempts === 0);
      for (const x of todo) await dispatchNow([x.id], { now: at(open, MIN / 2) });
    }
    return r;
  } finally {
    mail.rateAll = false;
  }
}
/** A round opened while the network fails: the request may have reached the provider, so each invite is `queued`, attempt 1 spent,
 *  `last_error` = `network timeout` - a row an extension must NOT re-render. */
async function networkFailedRound(fixtures: number, open: Date): Promise<OpenedRound> {
  mail.networkAll = true;
  try {
    return await openedRound(fixtures, { open });
  } finally {
    mail.networkAll = false;
  }
}
const RATE_LIMITED = ["queued", 1, "http 429 rate_limit_exceeded"] as const;
/** A round whose invites met a 429 TWICE: the worker's retry of the first 429 was refused again, so `last_error` reads as a 429 exactly as
 *  above but `attempts` is 2. `last_error` keeps only the LAST answer, so an earlier attempt could have been a network error the provider
 *  accepted - a 429 after it proves nothing, and an extension must NOT re-render such a row. The retry is the real worker's: the rows'
 *  `expires_at` is held in the future (the database's clock decides it, and the round is opened so the old deadline has passed) for the one
 *  tick, then put back exactly. */
async function rateLimitedTwiceRound(fixtures: number, open: Date): Promise<OpenedRound> {
  const r = await rateLimitedRound(fixtures, open);
  for (const b of r.boards) {
    const rows = await outboxOf(b.fixtureId);
    const expiries = rows.map((x) => x.expires_at.toISOString());
    const rowIds = idsOf(rows);
    await sql`update email_outbox set expires_at = now() + interval '1 hour', next_attempt_at = now() - interval '1 second' where id = any(${rowIds}::uuid[])`;
    mail.rateAll = true;
    try {
      // One tick per row: a tick stops claiming after its first 429 (it defers the rest), so a single tick would retry one row only.
      for (const id of rowIds) await runOutboxTick({ onlyIds: [id], sleep: async () => undefined });
    } finally {
      mail.rateAll = false;
    }
    for (const [i, x] of rows.entries()) await sql`update email_outbox set expires_at = ${expiries[i]!}::timestamptz where id = ${x.id}`;
  }
  return r;
}
const pressWith = (auth: AuthCtx, fixtureId: string, now: Date, over: Partial<ExtendDeps>) =>
  extendCheckin(auth, fixtureId, { now: () => now, publish: async () => {}, ...over });
/** The dispatch that sends nothing: the rows stay as the transaction left them, for a test to read their sealed bodies. */
const noDispatch: NonNullable<ExtendDeps["dispatch"]> = async () => new Map();
/** A dispatch that records what it was asked for and what another connection could see at that moment: a row the extension's
 *  transaction had not committed is invisible to the pool, so a dispatch made BEFORE the commit would see none of its ids. */
function spyDispatch() {
  const calls: { ids: string[]; seen: { id: string; status: string }[] }[] = [];
  const dispatch: NonNullable<ExtendDeps["dispatch"]> = async (ids) => {
    const seen = await sql<{ id: string; status: string }[]>`select id, status from email_outbox where id = any(${[...ids]}::uuid[])`;
    calls.push({ ids: [...ids], seen });
    return new Map();
  };
  return { calls, dispatch };
}
/** A second (and third) member of an entrant: their linked addresses become recipients of that seat. */
async function addMember(r: SeedOnlineChessRoundResult, entrantId: string, email: string): Promise<void> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale) values (${email}, 'Team mate', true, 'en') returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${r.orgId}, 'Team mate', ${u!.id}) returning id`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${p!.id}, ${r.orgId})`;
}

describe.skipIf(!HAS_DB)("extendCheckin - an invite still waiting to be sent is re-rendered with the new deadline", () => {
  afterEach(() => {
    mail.retryAll = false;
    mail.retry.clear();
    renderFault.fail = false;
  });
  const makeDue = (rows: { id: string }[]) =>
    sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = any(${idsOf(rows)}::uuid[])`;

  it("a queued invite nobody has attempted is retired (`replaced`, body gone) and a fresh one, naming the NEW deadline on the SAME stamp, takes its place", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    await neverAttempted(await outboxOf(fixtureId));
    const before = await outboxOf(fixtureId);
    const stamps = await stampsOf(fixtureId);
    expect(before.length, "premise: both seats were invited").toBeGreaterThanOrEqual(2);
    expect(before.map((x) => `${x.status}/${x.attempts}`), "premise: every invite is queued and never attempted").toEqual(before.map(() => "queued/0"));
    let named = 0;
    for (const x of before) {
      expect(namesDeadline(renderedOf(x).args.deadlineLabel, oldDeadline), "premise: each body names the OLD deadline").toBe(true);
      expect(namesDeadline(renderedOf(x).args.deadlineLabel, newDeadline), "... and not the new one").toBe(false);
      named += 1;
    }
    expect(named).toBe(before.length);

    await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });

    const after = await outboxOf(fixtureId);
    const beforeIds = new Set(before.map((x) => x.id));
    const old = after.filter((x) => beforeIds.has(x.id));
    const fresh = after.filter((x) => !beforeIds.has(x.id));
    expect(old.map((x) => x.status), "every stale invite is retired").toEqual(old.map(() => "replaced"));
    expect(old.length, "all of them, none lost").toBe(before.length);
    expect(old.map((x) => x.body_sealed), "a retired row keeps no body (the credential goes with it)").toEqual(old.map(() => null));
    expect(fresh.length, "one fresh invite per retired one").toBe(before.length);
    expect([...byKey(fresh).keys()].sort(), "for the same seat and the same recipient").toEqual([...byKey(before).keys()].sort());
    for (const f of fresh) {
      expect(f.status).toBe("queued");
      expect(f.attempts, "never attempted, so a fresh start").toBe(0);
      expect(f.expires_at.getTime(), "expiring at the NEW deadline").toBe(newDeadline.getTime());
      const body = renderedOf(f);
      expect(namesDeadline(body.args.deadlineLabel, newDeadline), "its body names the NEW deadline").toBe(true);
      expect(namesDeadline(body.args.deadlineLabel, oldDeadline), "and no longer the old one").toBe(false);
      const stamp = f.meta.colour === "white" ? stamps.white : stamps.black;
      expect(f.meta.stampedAt, "the SAME stamp the seat holds, so the chess hook keeps finding the seat's rows").toBe(iso(stamp));
      expect(f.meta.stampedAt).toBe(byKey(before).get(keyOf(f))!.meta.stampedAt);
    }
    expect(iso((await stampsOf(fixtureId)).white), "the seat stamps are exactly as they were").toBe(iso(stamps.white));
    expect(iso((await stampsOf(fixtureId)).black)).toBe(iso(stamps.black));
  });

  it("and once sent, the provider got ONE mail per recipient, naming the NEW deadline - nothing was mailed with the old one", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    await neverAttempted(await outboxOf(fixtureId));
    const before = await outboxOf(fixtureId);
    mail.sent.length = 0;

    await pressWith(r.owner, fixtureId, at(open, MIN), {}); // the real dispatchNow, on the press's own clock

    expect(mail.sent.map((m) => m.to).sort(), "one mail to each recipient, once").toEqual(before.map((x) => x.recipient).sort());
    expect(mail.sent.length).toBeGreaterThanOrEqual(2);
    for (const m of mail.sent) {
      expect(namesDeadline(m.deadlineLabel, newDeadline), `${m.to}: the NEW deadline`).toBe(true);
      expect(namesDeadline(m.deadlineLabel, oldDeadline), `${m.to}: not the old one`).toBe(false);
    }
    const after = await outboxOf(fixtureId);
    const live = after.filter((x) => x.status !== "replaced");
    expect(live.map((x) => x.status), "every fresh row went out").toEqual(live.map(() => "sent"));
    expect(live.length).toBe(before.length);
    expect(
      (await latestStatusesOfRows(before.map((x) => x.id))).size,
      "each retired id still answers with its recipient's newest row",
    ).toBe(before.length);
  });

  it("a row the provider answered 429 (it refused before doing anything) is re-rendered too, and its successor keeps the retry budget: the attempts spent, the retry time, the last error", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    const before = await outboxOf(fixtureId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(
      before.map((x) => [x.status, x.attempts, x.last_error]),
      "premise: the provider said 429 once; each invite is queued behind a retry (the exact text the eligibility test reads)",
    ).toEqual(before.map(() => RATE_LIMITED));

    await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });

    const after = await outboxOf(fixtureId);
    const beforeIds = new Set(before.map((x) => x.id));
    const fresh = after.filter((x) => !beforeIds.has(x.id));
    expect(after.filter((x) => beforeIds.has(x.id)).map((x) => x.status)).toEqual(before.map(() => "replaced"));
    expect(fresh.length).toBe(before.length);
    for (const f of fresh) {
      const was = byKey(before).get(keyOf(f))!;
      expect(namesDeadline(renderedOf(f).args.deadlineLabel, newDeadline), "re-rendered with the NEW deadline").toBe(true);
      expect(f.attempts, "the attempt already spent is still spent (the schedule is not restarted)").toBe(was.attempts);
      expect(f.next_attempt_at.getTime(), "the retry stays due when it was due").toBe(was.next_attempt_at.getTime());
      expect(f.last_error, "and says why it is waiting").toBe(was.last_error);
      expect(f.status).toBe("queued");
    }

    // The worker owns it from there: due, it is attempted ONCE MORE (attempt 2 of the schedule), and delivered with the new deadline.
    await makeDue(fresh);
    mail.sent.length = 0;
    expect(await runOutboxTick({ onlyIds: idsOf(fresh), sleep: async () => undefined })).toMatchObject({
      claimed: fresh.length,
      sent: fresh.length,
      expired: 0,
    });
    const sentNow = (await outboxOf(fixtureId)).filter((x) => x.status !== "replaced");
    expect(sentNow.map((x) => [x.status, x.attempts]), "the budget continued: attempt 2, not a second attempt 1").toEqual(sentNow.map(() => ["sent", 2]));
    expect(mail.sent.length).toBe(fresh.length);
    for (const m of mail.sent) expect(namesDeadline(m.deadlineLabel, newDeadline), `${m.to}: the NEW deadline`).toBe(true);
  });

  // The ruling that outranks re-rendering: NEVER an extra mail. A row whose earlier attempt ended in a network error or a 5xx may have been
  // ACCEPTED by the provider with the answer lost; a fresh row has a new idempotency key, so re-rendering it could deliver twice. Such a row
  // keeps its id (its key) and its body; only its expiry moves, and the worker's retry (same key) is harmless whichever way the first ended.
  for (const [name, round, lastError, attempted] of [
    ["a 503", retryingRound, "http 503 service_unavailable", 1],
    ["a network error", networkFailedRound, "network timeout", 1],
    // controller ruling: a 429 proves the request was refused only when it was the row's ONLY attempt.
    ["a 429 that followed an earlier attempt (attempts 2)", rateLimitedTwiceRound, "http 429 rate_limit_exceeded", 2],
  ] as const) {
    it(`a row whose attempt ended in ${name} is NOT re-rendered (the request may have been accepted): same row, same key, same body - only its expiry moves; no dispatch, one mail in all`, async () => {
      const open = openAround();
      const r = await round(1, open);
      const fixtureId = r.boards[0]!.fixtureId;
      const oldDeadline = at(open, DEADLINE_AFTER_MS);
      const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
      const before = await outboxOf(fixtureId);
      expect(before.length, "premise: both seats were invited").toBeGreaterThanOrEqual(2);
      expect(
        before.map((x) => [x.status, x.attempts, x.last_error]),
        `premise: each invite was attempted ${attempted}x and is waiting behind a retry (${lastError})`,
      ).toEqual(before.map(() => ["queued", attempted, lastError]));
      const spy = spyDispatch();
      mail.sent.length = 0;

      await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: spy.dispatch });

      const after = await outboxOf(fixtureId);
      expect(idsOf(after), "no new row, and so no new idempotency key").toEqual(idsOf(before));
      expect(after.map((x) => x.status), "none retired").toEqual(after.map(() => "queued"));
      expect(after.map((x) => x.body_sealed?.toString("hex")), "the body is the one written at the open").toEqual(
        before.map((x) => x.body_sealed?.toString("hex")),
      );
      for (const x of after) {
        expect(namesDeadline(renderedOf(x).args.deadlineLabel, oldDeadline), "it still names the deadline it was written with").toBe(true);
        expect(x.expires_at.getTime(), "but it expires at the NEW deadline, so its retry is delivered and not expired").toBe(newDeadline.getTime());
        expect([x.attempts, x.last_error], "and its place in the schedule is untouched").toEqual([attempted, lastError]);
      }
      expect(spy.calls, "nothing was re-rendered, so nothing is dispatched").toEqual([]);
      expect(mail.sent, "and nothing was mailed by the press").toEqual([]);

      // The worker's retry under the SAME key: one mail per recipient in all.
      await makeDue(after);
      expect(await runOutboxTick({ onlyIds: idsOf(after), sleep: async () => undefined })).toMatchObject({ claimed: after.length, sent: after.length, expired: 0 });
      expect(mail.sent.map((m) => m.to).sort(), "exactly one mail to each recipient, in total").toEqual(before.map((x) => x.recipient).sort());
    });
  }

  // EVERY status but `queued`, taken from the outbox's own list: a status added to the outbox is swept too. The base is a round whose
  // invites PASS the attempt test (429, attempt 1 spent), so the status test is the only thing keeping these rows out - a sweep over
  // rows that fail the attempt test as well would stay green with the status test deleted.
  const NOT_QUEUED = OUTBOX_STATUSES.filter((st) => st !== "queued");
  let swept = 0;
  for (const status of NOT_QUEUED) {
    it(`a ${status} invite is NOT touched: no new row, no retirement, no extra mail`, async () => {
      const open = openAround();
      const r = await rateLimitedRound(1, open); // queued rows, with bodies, eligible; put them in the status under test
      const fixtureId = r.boards[0]!.fixtureId;
      const newDeadline = at(open, DEADLINE_AFTER_MS + CHECKIN_EXTEND_STEP_MS);
      const ids = idsOf(await outboxOf(fixtureId));
      expect(ids.length, "premise: both seats were invited").toBeGreaterThanOrEqual(2);
      if (status === "sending") {
        await sql`update email_outbox set status = 'sending', lease_until = now() + interval '2 minutes' where id = any(${ids}::uuid[])`;
      } else {
        // The ended and delivered shapes the schema allows: no body, no lease; a provider id and a send time on the ones the provider took.
        await sql`
          update email_outbox
             set status = ${status}, body_sealed = null, lease_until = null, sent_at = now(), provider_id = 're_' || id::text
           where id = any(${ids}::uuid[])`;
      }
      const before = await outboxOf(fixtureId);
      expect(before.map((x) => x.status), "premise: every invite is in the status under test").toEqual(before.map(() => status));
      expect(before.map((x) => [x.attempts, x.last_error]), "premise: and would pass the attempt test, so only the status keeps it out").toEqual(
        before.map(() => [1, "http 429 rate_limit_exceeded"]),
      );
      mail.sent.length = 0;
      const spy = spyDispatch();

      await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: spy.dispatch });

      const after = await outboxOf(fixtureId);
      expect(idsOf(after), "no new row").toEqual(ids);
      expect(after.map((x) => x.status), "and no row retired").toEqual(after.map(() => status));
      expect(spy.calls, "nothing to send, so no dispatch").toEqual([]);
      expect(mail.sent, "no extra mail").toEqual([]);
      // The expiry rule of Task 8 is unchanged beside it: a row that can still be retried moves, a finished one does not.
      const moved = RETRYABLE_STATUSES.includes(status);
      expect(after.map((x) => x.expires_at.getTime())).toEqual(
        after.map((x) => (moved ? newDeadline.getTime() : byKey(before).get(keyOf(x))!.expires_at.getTime())),
      );
      swept += 1;
    });
  }
  it("the status sweep above ran for every status of the outbox but `queued` (a sweep that ran for none is a failure, not a pass)", () => {
    expect(NOT_QUEUED.length, "the list the sweep is drawn from").toBeGreaterThan(0);
    expect(NOT_QUEUED.length, "and it is the whole list less `queued`").toBe(OUTBOX_STATUSES.length - 1);
    expect(swept, "every one of them was swept").toBe(NOT_QUEUED.length);
  });

  it("a board is judged seat by seat: the player whose invite went out keeps it; only the player whose invite is still waiting gets a new one", async () => {
    const open = openAround();
    const r = await openedRound(1, { open }); // every invite is sent
    const b = r.boards[0]!;
    const [fixtureId, retrying, mailedTo] = [b.fixtureId, b.home.email, b.away.email];
    // A resend re-mails both seats on their stamps: the away player's goes out again, the home player's is answered 503 and waits.
    mail.retry.add(retrying);
    await resendExternalPlayNotice(r.owner, fixtureId, ORIGIN, { now: at(open, 30_000) });
    mail.retry.clear();
    const newDeadline = at(open, DEADLINE_AFTER_MS + CHECKIN_EXTEND_STEP_MS);
    const before = await outboxOf(fixtureId);
    const sent = before.find((x) => x.recipient === mailedTo && x.status !== "replaced")!;
    const waiting = before.find((x) => x.recipient === retrying && x.status !== "replaced")!;
    expect([sent.status, waiting.status], "premise: one invite went out, the other is waiting for a retry").toEqual(["sent", "queued"]);
    await neverAttempted([waiting]);
    mail.sent.length = 0;

    await pressWith(r.owner, fixtureId, at(open, MIN), {});

    const after = await outboxOf(fixtureId);
    expect(after.find((x) => x.id === sent.id), "the sent invite is the very same row, untouched").toMatchObject({ status: "sent", provider_id: sent.provider_id });
    expect(after.find((x) => x.id === waiting.id)!.status, "the waiting one is retired").toBe("replaced");
    const beforeIds = new Set(before.map((x) => x.id));
    const fresh = after.filter((x) => !beforeIds.has(x.id));
    expect(fresh.map((x) => [x.recipient, x.status]), "and replaced by exactly one fresh invite, to the same person").toEqual([[retrying, "sent"]]);
    expect(mail.sent.map((m) => m.to), "the only mail after the press went to the player who had not got one").toEqual([retrying]);
    expect(namesDeadline(mail.sent[0]!.deadlineLabel, newDeadline)).toBe(true);
  });

  it("a seat with several recipients is judged recipient by recipient: the member whose mail went out is not re-mailed (a team-mate's waiting one is re-rendered)", async () => {
    const open = openAround();
    const r = await openedRound(1, { open }); // every invite is sent
    const b = r.boards[0]!;
    const mate = `mate-${randomUUID().slice(0, 8)}@seazn.test`;
    await addMember(r, b.home.entrantId, mate);
    mail.retry.add(mate);
    // A resend re-mails the whole seat on its existing stamp: the captain's goes out again, the team-mate's is answered 503 and waits.
    await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN, { now: at(open, 30_000) });
    mail.retry.clear();
    const before = await outboxOf(b.fixtureId);
    const captain = before.find((x) => x.recipient === b.home.email && x.status !== "replaced")!;
    const mateRow = before.find((x) => x.recipient === mate && x.status !== "replaced")!;
    expect(captain.ref_id, "premise: one seat, two recipients").toBe(mateRow.ref_id);
    expect([captain.status, mateRow.status], "premise: the captain's mail went out, the team-mate's is waiting").toEqual(["sent", "queued"]);
    await neverAttempted([mateRow]);
    mail.sent.length = 0;

    await pressWith(r.owner, b.fixtureId, at(open, MIN), {});

    const after = await outboxOf(b.fixtureId);
    expect(after.find((x) => x.id === captain.id), "the captain's mail is untouched: not retired, so no second mail to them").toMatchObject({ status: "sent" });
    expect(after.find((x) => x.id === mateRow.id)!.status).toBe("replaced");
    expect(mail.sent.map((m) => m.to), "one mail, to the team-mate whose invite was still waiting").toEqual([mate]);
    expect(
      after.filter((x) => x.ref_id === captain.ref_id && x.recipient === mate && x.status !== "replaced").map((x) => x.meta.stampedAt),
      "on the seat's stamp",
    ).toEqual([mateRow.meta.stampedAt]);
  });

  it("the seat stays stamped and the chess hook never releases it because of the retired row (the fresh one holds the stamp); when the fresh one ends badly, the seat IS released", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const stamps = await stampsOf(fixtureId);
    expect([stamps.white, stamps.black], "premise: both seats are stamped").not.toContain(null);
    const before = await outboxOf(fixtureId);
    await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });
    const after = await outboxOf(fixtureId);
    const retired = after.filter((x) => x.status === "replaced");
    const fresh = after.filter((x) => x.status === "queued");
    expect([retired.length, fresh.length]).toEqual([before.length, before.length]);
    expect([iso((await stampsOf(fixtureId)).white), iso((await stampsOf(fixtureId)).black)], "the stamps did not move").toEqual([iso(stamps.white), iso(stamps.black)]);

    // The hook told about each RETIRED row (as if it had ended) finds the fresh row on the same stamp and leaves the seat alone.
    for (const x of retired) {
      await chessInviteEndedBadly({ id: x.id, kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refId: x.ref_id, status: "expired", meta: x.meta });
    }
    expect([iso((await stampsOf(fixtureId)).white), iso((await stampsOf(fixtureId)).black)], "no seat was released").toEqual([iso(stamps.white), iso(stamps.black)]);
    const unapplied = (await findUnappliedChessEndings(1000)).filter((e) => e.meta.fixtureId === fixtureId);
    expect(unapplied, "and the worker's re-drive finds nothing to release on this board").toEqual([]);

    // The positive pair: the fresh rows ending badly IS what releases the seat, on the stamp they carry.
    await sql`update email_outbox set status = 'dead', body_sealed = null, last_error = 'later' where id = any(${idsOf(fresh)}::uuid[])`;
    for (const x of fresh) {
      await chessInviteEndedBadly({ id: x.id, kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refId: x.ref_id, status: "dead", meta: x.meta });
    }
    expect(await stampsOf(fixtureId), "the seats are released once every email for the stamp has ended badly").toEqual({ white: null, black: null });
  });

  it("what the arbiter and the response read is unchanged: each retired id still answers with its recipient's newest row, a seat is still `retrying`, and the status read shows one row per recipient", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const refs = [chessSeatRef(fixtureId, "white"), chessSeatRef(fixtureId, "black")];
    const before = await outboxOf(fixtureId);
    const seatsOf = (rows: OutboxRow[], statuses: Map<string, string>) =>
      (["white", "black"] as const).map((colour) =>
        seatOutcome(rows.filter((x) => x.ref_id === chessSeatRef(fixtureId, colour)).map((x) => statuses.get(x.id) as never)),
      );
    const statusBefore = await latestStatusesOfRows(before.map((x) => x.id));
    const deskBefore = await latestEmailStatus(r.orgId, CHESS_SEAT_REF_TYPE, refs);
    expect(seatsOf(before, statusBefore), "premise: both seats read `retrying`").toEqual(["retrying", "retrying"]);
    expect(deskBefore.length, "premise: the status read has a row per recipient").toBe(before.length);

    await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });

    const statusAfter = await latestStatusesOfRows(before.map((x) => x.id));
    expect([...statusAfter.values()], "the response's rule: a retired id answers with the newest non-replaced row").toEqual(before.map(() => "queued"));
    expect(seatsOf(before, statusAfter), "so both seats still read `retrying`").toEqual(["retrying", "retrying"]);
    const deskAfter = await latestEmailStatus(r.orgId, CHESS_SEAT_REF_TYPE, refs);
    const shape = (rows: typeof deskBefore) => rows.map((x) => [x.refId, x.recipient.toLowerCase(), x.kind, x.status]).sort();
    expect(shape(deskAfter), "the desk's count of invites and their statuses are exactly as before").toEqual(shape(deskBefore));
  });

  it("two presses leave ONE live invite per recipient, naming the latest deadline, on the original stamp, with the retry budget carried through both generations", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    expect(before.length, "premise: the seats were invited, so there is something to count").toBeGreaterThanOrEqual(2);
    expect(before.map((x) => [x.status, x.attempts, x.last_error]), "premise: each invite waits behind a 429").toEqual(before.map(() => RATE_LIMITED));
    const stamps = await stampsOf(fixtureId);
    await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });
    await pressWith(r.owner, fixtureId, at(open, 2 * MIN), { dispatch: noDispatch });

    const all = await outboxOf(fixtureId);
    const live = all.filter((x) => x.status !== "replaced");
    expect(all.length, "three generations of each invite").toBe(3 * before.length);
    expect(all.filter((x) => x.status === "replaced").length, "the first two retired").toBe(2 * before.length);
    expect(live.length, "one live invite per recipient").toBe(before.length);
    expect([...byKey(live).keys()].sort()).toEqual([...byKey(before).keys()].sort());
    const latest = deadlineOfPress(open, 2);
    for (const x of live) {
      expect(x.status).toBe("queued");
      expect(namesDeadline(renderedOf(x).args.deadlineLabel, latest), "the latest deadline").toBe(true);
      expect(namesDeadline(renderedOf(x).args.deadlineLabel, deadlineOfPress(open, 1)), "not the middle one").toBe(false);
      expect(x.expires_at.getTime()).toBe(latest.getTime());
      expect(x.attempts, "the attempt spent at the open is the only one").toBe(1);
      expect(x.last_error, "and its reason rode through both generations").toBe(byKey(before).get(keyOf(x))!.last_error);
      expect(x.next_attempt_at.getTime(), "due when the FIRST row was due").toBe(byKey(before).get(keyOf(x))!.next_attempt_at.getTime());
      expect(x.meta.stampedAt, "the stamp of the open").toBe(iso(x.meta.colour === "white" ? stamps.white : stamps.black));
    }
  });

  it("a LATER batch's waiting invite (written before its window opened: \"opens at ...\") is re-rendered on the batch's own deadline and no longer says it has not opened", async () => {
    mail.rateAll = true; // the open's dispatch stops at its first 429: some rows are attempted, some not, and both are eligible
    let r: OpenedRound;
    try {
      r = await openedRound(1, { camera: "required", ranked: [2 * CHECKIN_BATCH_SIZE] });
    } finally {
      mail.rateAll = false;
    }
    const ranked = r.ranked[0]!;
    const batch2Opens = at(O, 2 * CHECKIN_BATCH_GAP_MS);
    const oldDeadline = at(batch2Opens, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    const before = await outboxOf(ranked.fixtureId);
    expect(before.length, "premise: the later batch's board was invited at the open").toBeGreaterThanOrEqual(2);
    for (const x of before) {
      expect(renderedOf(x).args.opensLabel, "premise: the mail said when the window opens").toBeTruthy();
      expect(namesDeadline(renderedOf(x).args.deadlineLabel, oldDeadline), "premise: on the batch's own deadline").toBe(true);
    }

    await pressWith(r.owner, ranked.fixtureId, batch2Opens, { dispatch: noDispatch });

    const fresh = (await outboxOf(ranked.fixtureId)).filter((x) => x.status === "queued");
    expect(fresh.length).toBe(before.length);
    for (const x of fresh) {
      expect(namesDeadline(renderedOf(x).args.deadlineLabel, newDeadline), "the batch's start + the window + the step").toBe(true);
      expect(renderedOf(x).args.opensLabel, "its window is open now: the mail no longer says it opens later").toBeUndefined();
    }
  });

  it("a retired row that is NEWER on the clock than the live one is never taken for the recipient's invite: the live, waiting one is still re-rendered", async () => {
    // The replace trigger retires by KEY, not by time, so a `replaced` row can be the newest by `created_at`. The newest-row rule
    // (status.ts, shared with the arbiter's read) skips it; a read that did not would find a replaced row, see no queued invite, and leave the
    // waiting one to go out naming the old deadline.
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });
    const gen1 = (await outboxOf(fixtureId)).filter((x) => x.status === "replaced");
    expect(gen1.length, "premise: the first press retired the open's invites").toBeGreaterThanOrEqual(2);
    await sql`update email_outbox set created_at = created_at + interval '1 hour' where id = any(${idsOf(gen1)}::uuid[])`;

    await pressWith(r.owner, fixtureId, at(open, 2 * MIN), { dispatch: noDispatch });

    const live = (await outboxOf(fixtureId)).filter((x) => x.status !== "replaced");
    expect(live.length, "one live invite per recipient").toBe(gen1.length);
    for (const x of live) expect(namesDeadline(renderedOf(x).args.deadlineLabel, deadlineOfPress(open, 2)), "naming the second press's deadline").toBe(true);
  });

  it("the dispatch is made AFTER the commit, once, for exactly the fresh ids (a round-wide press: once for the whole round, and not for the board it skipped)", async () => {
    const open = openAround();
    const r = await rateLimitedRound(2, open);
    const [moved, skipped] = r.boards.map((x) => x.fixtureId) as [string, string];
    await sql`update fixture_external_play set challenge_id = ${`gm-${randomUUID().slice(0, 8)}`}, status = 'ready', white_side = 'home' where fixture_id = ${skipped}`;
    const movedBefore = await outboxOf(moved);
    const skippedBefore = await outboxOf(skipped);
    const spy = spyDispatch();

    const out = await extendRoundCheckin(r.owner, { stageId: r.stageId, roundNo: r.roundNo }, { now: () => at(open, MIN), publish: async () => {}, dispatch: spy.dispatch });
    expect(out, "premise: one board extended, one skipped (a game is on it)").toMatchObject({ extended: 1, skipped: { gameStarted: 1 } });

    const movedAfter = await outboxOf(moved);
    const fresh = movedAfter.filter((x) => !movedBefore.some((o) => o.id === x.id));
    expect(fresh.length).toBe(movedBefore.length);
    expect(spy.calls.length, "one dispatch for the whole round").toBe(1);
    expect(spy.calls[0]!.ids.slice().sort(), "for exactly the fresh ids").toEqual(idsOf(fresh));
    expect(
      spy.calls[0]!.seen.map((x) => x.status),
      "which another connection could already see - so it ran after the commit - and were queued",
    ).toEqual(spy.calls[0]!.ids.map(() => "queued"));
    expect(idsOf(await outboxOf(skipped)), "the skipped board's invites are as they were").toEqual(idsOf(skippedBefore));
  });

  it("a board whose invites were never written (the empty case) is extended and dispatches nothing", async () => {
    const open = openAround();
    const r = await retryingRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    await sql`delete from email_outbox where ref_id in (${chessSeatRef(fixtureId, "white")}, ${chessSeatRef(fixtureId, "black")})`;
    expect(await outboxOf(fixtureId), "premise: no outbox row for the board").toEqual([]);
    const spy = spyDispatch();
    expect(await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: spy.dispatch })).toMatchObject({ extensions: 1 });
    expect(await outboxOf(fixtureId), "nothing invented").toEqual([]);
    expect(spy.calls, "nothing to dispatch").toEqual([]);
  });

  it("an extension that rolls back leaves no new rows and retires none: the fresh invites are written in the extension's own transaction", async () => {
    // A deferred constraint trigger that refuses at COMMIT, after every statement of the transaction (the rows included) has run; keyed
    // to this board, so it is inert for every other test on the shared database.
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const before = await outboxOf(fixtureId);
    const spy = spyDispatch();

    const fn = `fu_commit_fault_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'commit refused (re-render test)'; end $$`);
    await sql.unsafe(
      `create constraint trigger ${fn} after insert on online_chess_audit deferrable initially deferred for each row when (new.fixture_id = '${fixtureId}') execute function ${fn}()`,
    );
    try {
      await expect(pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: spy.dispatch })).rejects.toThrow(/commit refused/);
      const after = await outboxOf(fixtureId);
      expect(idsOf(after), "no new row").toEqual(idsOf(before));
      expect(after.map((x) => x.status), "and none retired").toEqual(after.map(() => "queued"));
      for (const x of after) expect(namesDeadline(renderedOf(x).args.deadlineLabel, oldDeadline), "each body is still the one written at the open").toBe(true);
      expect(spy.calls, "nothing was dispatched for a press that did not happen").toEqual([]);
      expect(await rowOf(fixtureId), "the extension rolled back").toMatchObject({ checkin_extra_ms: 0, checkin_extensions: 0 });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on online_chess_audit`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    // The positive pair: without the fault the same press re-renders.
    expect(await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: spy.dispatch })).toMatchObject({ extensions: 1 });
    expect((await outboxOf(fixtureId)).filter((x) => x.status === "queued").length).toBe(before.length);
    expect(spy.calls.length).toBe(1);
  });

  it("an invite that cannot be rendered does NOT fail the press (controller ruling: the +5 must not fail because of mail): the extension commits, the failure is logged by fixture and error name, and the waiting invites keep their deadline with the expiry moved", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    const before = await outboxOf(fixtureId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const spy = spyDispatch();
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      // The first render succeeds and its row is written (retiring the old one); the second throws. Only a savepoint undoes the first.
      renderFault.pass = 1;
      renderFault.seen = 0;
      renderFault.fail = true;
      expect(await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: spy.dispatch }), "the press answers").toMatchObject({
        extensions: 1,
        deadlineAt: newDeadline.toISOString(),
      });
      expect(renderFault.seen, "premise: the fault struck AFTER a render had succeeded").toBeGreaterThanOrEqual(2);
      renderFault.fail = false;
      expect(await rowOf(fixtureId), "the deadline moved").toMatchObject({ checkin_extra_ms: CHECKIN_EXTEND_STEP_MS, checkin_extensions: 1 });
      expect((await auditOf(fixtureId)).length, "and the audit row was kept").toBe(1);
      const after = await outboxOf(fixtureId);
      expect(idsOf(after), "no fresh row: the savepoint took the failed re-render back").toEqual(idsOf(before));
      expect(after.map((x) => x.status), "none retired").toEqual(after.map(() => "queued"));
      for (const x of after) {
        expect(namesDeadline(renderedOf(x).args.deadlineLabel, oldDeadline), "each still names the deadline it was written with").toBe(true);
        expect(x.expires_at.getTime(), "its expiry moved (the pre-Task-8 fall-back), so it is delivered and not expired").toBe(newDeadline.getTime());
      }
      expect(spy.calls, "nothing was re-rendered, so nothing is dispatched").toEqual([]);
      const lines = logged.mock.calls.filter((c) => typeof c[1] === "string" && /re-rendering the waiting invites failed/.test(c[1] as string));
      expect(lines.length, "the failure is logged once").toBe(1);
      expect(JSON.stringify(lines[0]), "by fixture").toContain(fixtureId);
      expect(JSON.stringify(lines[0]), "and error name, never an address").toContain("Error");
      for (const x of before) expect(JSON.stringify(lines[0])).not.toContain(x.recipient);
    } finally {
      renderFault.fail = false;
      logged.mockRestore();
    }
    // The positive pair: without the fault the next press re-renders them.
    expect(await pressWith(r.owner, fixtureId, at(open, 2 * MIN), { dispatch: noDispatch })).toMatchObject({ extensions: 2 });
    const live = (await outboxOf(fixtureId)).filter((x) => x.status === "queued");
    expect(live.length).toBe(before.length);
    for (const x of live) expect(namesDeadline(renderedOf(x).args.deadlineLabel, deadlineOfPress(open, 2))).toBe(true);
  });

  it("[pool] the extension's transaction never waits on the pool for a second connection: with every other connection taken, the press still completes and re-renders", async () => {
    // lib/db.ts: a pooled query made while a transaction holds one of the pool's connections is a self-deadlock under load (postgres.js has
    // no queue-wait timeout). Reading the board's seats takes pooled connections, so it must happen outside the transaction. Here the
    // pool is left ONE free connection - the transaction's own - so any pooled query made inside it waits for ever.
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    expect(before.length, "premise: invites are waiting, so the press has to read the seats").toBeGreaterThanOrEqual(2);
    const { max } = connectionOptions(process.env.DATABASE_URL!);
    expect(max, "premise: a pool of more than one, so there is something to take").toBeGreaterThan(1);
    const held: Awaited<ReturnType<typeof sql.reserve>>[] = [];
    let outcome: "done" | "stuck";
    try {
      for (let i = 0; i < max - 1; i++) held.push(await sql.reserve());
      outcome = await Promise.race([
        pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch }).then(() => "done" as const),
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 10_000)),
      ]);
    } finally {
      for (const h of held) h.release();
    }
    expect(outcome, "the press completed with a single free connection").toBe("done");
    const after = await outboxOf(fixtureId);
    expect(after.filter((x) => x.status === "queued").length, "and re-rendered every waiting invite").toBe(before.length);
    expect(after.filter((x) => x.status === "replaced").length).toBe(before.length);
  });

  it("a row the send claims while the press is deciding is left alone: the press asks for the row's lock and judges its status AFTER it, so a `sending` row is never retired", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const target = before[0]!;
    const holder = await sql.reserve();
    let done = false;
    let pending: Promise<unknown> | undefined;
    try {
      await holder`begin`;
      await holder`select id from email_outbox where id = ${target.id} for update`;
      const holderPid = await backendPid(holder);
      pending = pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch }).finally(() => {
        done = true;
      });
      expect(
        await pollWaitersBehind(holderPid, { finished: () => done }),
        "premise: the press is genuinely WAITING on the row's lock",
      ).toBeGreaterThan(0);
      expect(done, "and has not decided").toBe(false);
      // The send claims the row while the press waits.
      await holder`update email_outbox set status = 'sending', attempts = attempts + 1, lease_until = now() + interval '2 minutes' where id = ${target.id}`;
      await holder`commit`;
      await pending;
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
      await pending?.catch(() => undefined);
    }
    const after = await outboxOf(fixtureId);
    expect(after.find((x) => x.id === target.id)!.status, "the claimed row is still the send's: not retired mid-flight").toBe("sending");
    expect(
      after.filter((x) => x.id !== target.id && keyOf(x) === keyOf(target)),
      "and no fresh invite was written for its recipient (that would be a second mail)",
    ).toEqual([]);
    const others = before.filter((x) => x.id !== target.id);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) expect(after.find((x) => x.id === o.id)!.status, "the other waiting invites were re-rendered").toBe("replaced");
  });

  it("an invite whose stamp cannot be read is left as it is and logged by id; the press still goes through and the others are re-rendered", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    const broken = before[0]!;
    await sql`update email_outbox set meta = meta || '{"stampedAt":"not-an-instant"}'::jsonb where id = ${broken.id}`;
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      expect(await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch })).toMatchObject({ extensions: 1 });
      const after = await outboxOf(fixtureId);
      expect(after.find((x) => x.id === broken.id)!.status, "the unreadable one is not re-rendered").toBe("queued");
      expect(
        after.find((x) => x.id === broken.id)!.expires_at.getTime(),
        "and its expiry does NOT move: its body names the old deadline, so it ends unsent at it",
      ).toBe(broken.expires_at.getTime());
      for (const o of before.filter((x) => x.id !== broken.id)) expect(after.find((x) => x.id === o.id)!.status).toBe("replaced");
      const lines = logged.mock.calls.filter((c) => typeof c[1] === "string" && /stamp/i.test(c[1] as string));
      expect(lines.length, "named in the log").toBe(1);
      expect(JSON.stringify(lines[0]), "by its id, never its address").toContain(broken.id);
      expect(JSON.stringify(lines[0])).not.toContain(broken.recipient);
    } finally {
      logged.mockRestore();
    }
  });

  it("an invite whose stamp IS an instant but not in the canonical form the hook keys by is left as it is and logged: re-rendered, it would be re-stamped under a string the hook never finds", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    const odd = before[0]!;
    const offsetForm = odd.meta.stampedAt.replace(/Z$/, "+00:00"); // the same instant, written another way
    expect(offsetForm, "premise: written another way").not.toBe(odd.meta.stampedAt);
    expect(new Date(offsetForm).toISOString(), "premise: and it IS the same instant").toBe(odd.meta.stampedAt);
    await sql`update email_outbox set meta = meta || jsonb_build_object('stampedAt', ${offsetForm}::text) where id = ${odd.id}`;
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      expect(await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch })).toMatchObject({ extensions: 1 });
      const after = await outboxOf(fixtureId);
      expect(after.find((x) => x.id === odd.id)!.status, "the non-canonical one is not re-rendered").toBe("queued");
      expect(after.find((x) => x.id === odd.id)!.meta.stampedAt, "and keeps the stamp string it had").toBe(offsetForm);
      for (const o of before.filter((x) => x.id !== odd.id)) expect(after.find((x) => x.id === o.id)!.status, "the others are").toBe("replaced");
      const lines = logged.mock.calls.filter((c) => typeof c[1] === "string" && /stamp/i.test(c[1] as string));
      expect(lines.length, "named in the log").toBe(1);
      expect(JSON.stringify(lines[0])).toContain(odd.id);
    } finally {
      logged.mockRestore();
    }
  });

  it("a waiting invite for someone who has LEFT the seat gets no fresh invite and its expiry is NOT moved: it ends unsent at the old deadline, not mailed after it; the seat's other waiting invite is re-rendered", async () => {
    const open = openAround();
    const r = await openedRound(1, { open }); // every invite is sent
    const b = r.boards[0]!;
    const oldDeadline = at(open, DEADLINE_AFTER_MS);
    const newDeadline = at(oldDeadline, CHECKIN_EXTEND_STEP_MS);
    const mate = `mate-${randomUUID().slice(0, 8)}@seazn.test`;
    await addMember(r, b.home.entrantId, mate);
    // A resend re-mails both seats on their stamps; the team-mate's and the away player's are answered 503 and wait.
    mail.retry.add(mate);
    mail.retry.add(b.away.email);
    await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN, { now: at(open, 30_000) });
    mail.retry.clear();
    const before = await outboxOf(b.fixtureId);
    const mateRow = before.find((x) => x.recipient === mate && x.status !== "replaced")!;
    const awayRow = before.find((x) => x.recipient === b.away.email && x.status !== "replaced")!;
    expect([mateRow.status, awayRow.status], "premise: both are waiting for a retry").toEqual(["queued", "queued"]);
    await neverAttempted([mateRow, awayRow]);
    // The team-mate leaves the entrant: the seat no longer carries their address.
    await sql`
      delete from entrant_members em using persons p, users u
       where em.entrant_id = ${b.home.entrantId} and p.id = em.person_id and u.id = p.user_id and u.email = ${mate}`;
    const spy = spyDispatch();
    mail.sent.length = 0;

    await pressWith(r.owner, b.fixtureId, at(open, MIN), { dispatch: spy.dispatch });

    const after = await outboxOf(b.fixtureId);
    const left = after.find((x) => x.id === mateRow.id)!;
    expect(left.status, "the departed one's row is not retired").toBe("queued");
    expect(after.filter((x) => x.recipient === mate && x.id !== mateRow.id), "and no fresh invite is written for them").toEqual([]);
    expect(left.expires_at.getTime(), "its expiry stays at the OLD deadline: its body names it").toBe(oldDeadline.getTime());
    expect(after.find((x) => x.id === awayRow.id)!.status, "the away player's waiting invite is re-rendered").toBe("replaced");
    const freshAway = after.filter((x) => x.recipient === b.away.email && x.status === "queued");
    expect(freshAway.length).toBe(1);
    expect(freshAway[0]!.expires_at.getTime()).toBe(newDeadline.getTime());
    expect(spy.calls.map((c) => c.ids), "dispatched: the away player's fresh row only").toEqual([[freshAway[0]!.id]]);

    // The pre-Task-8 end of it: when the worker reaches the departed one's row (past the old deadline) it is expired unsent, never mailed.
    await makeDue([left]);
    expect(await runOutboxTick({ onlyIds: [left.id], sleep: async () => undefined })).toMatchObject({ claimed: 0, sent: 0, expired: 1 });
    expect(mail.sent, "nothing was mailed to the person who left").toEqual([]);
  });

  it("the retry budget is carried to a fresh row whose address differs from the retired one's only in case (the replace rule and the carry fold it the same way)", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    // An address stored in capitals, as one typed that way would be.
    await sql`update email_outbox set recipient = upper(recipient) where ref_id in (${chessSeatRef(fixtureId, "white")}, ${chessSeatRef(fixtureId, "black")})`;
    const before = await outboxOf(fixtureId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (const x of before) expect(x.recipient, "premise: stored in capitals").not.toBe(x.recipient.toLowerCase());
    const warned = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch });
      const after = await outboxOf(fixtureId);
      expect(after.filter((x) => x.status === "replaced").length, "each capitalised row was replaced by the fresh one for the same mailbox").toBe(before.length);
      const fresh = after.filter((x) => x.status === "queued");
      expect(fresh.length).toBe(before.length);
      for (const f of fresh) {
        expect(f.recipient, "premise: the fresh row's address is not the retired row's spelling").not.toBe(byKey(before).get(keyOf(f))!.recipient);
        expect([f.attempts, f.last_error], "yet it took the budget").toEqual([1, "http 429 rate_limit_exceeded"]);
      }
      expect(warned.mock.calls.filter((c) => /retry budget/.test(String(c[1]))), "so nothing was reported as not carried").toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it("when a re-rendered invite does not take its retired row's retry budget the press says so (ids only) and still goes through; when every one does, it says nothing", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const warned = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      carryFault.skip = true; // the copy matches nothing
      expect(await pressWith(r.owner, fixtureId, at(open, MIN), { dispatch: noDispatch })).toMatchObject({ extensions: 1 });
      carryFault.skip = false;
      const lines = warned.mock.calls.filter((c) => /retry budget/.test(String(c[1])));
      expect(lines.length, "said once").toBe(1);
      const fields = lines[0]![0] as { expected: number; carried: number; retiredIds: string[]; freshIds: string[] };
      expect([fields.expected, fields.carried], "how many were owed and how many were carried").toEqual([before.length, 0]);
      expect([...fields.retiredIds].sort(), "by the ids of the retired rows").toEqual(idsOf(before));
      expect(fields.freshIds.length).toBe(before.length);
      for (const x of before) expect(JSON.stringify(lines[0]), "never an address").not.toContain(x.recipient);
      expect(
        (await outboxOf(fixtureId)).filter((x) => x.status === "queued").map((x) => x.attempts),
        "what it warns about: the schedule of each fresh row did start over",
      ).toEqual(before.map(() => 0));

      // The positive pair: a round whose copy works says nothing.
      warned.mockClear();
      const r2 = await rateLimitedRound(1, openAround());
      await pressWith(r2.owner, r2.boards[0]!.fixtureId, at(openAround(), MIN), { dispatch: noDispatch });
      expect(warned.mock.calls.filter((c) => /retry budget/.test(String(c[1]))), "nothing to say when every budget was carried").toEqual([]);
    } finally {
      carryFault.skip = false;
      warned.mockRestore();
    }
  });

  it("a dispatch that throws after the commit does not fail the press: the extension and the fresh rows stand, the failure is logged by error name, the worker finishes the rows", async () => {
    const open = openAround();
    const r = await rateLimitedRound(1, open);
    const fixtureId = r.boards[0]!.fixtureId;
    const before = await outboxOf(fixtureId);
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const out = await pressWith(r.owner, fixtureId, at(open, MIN), {
        dispatch: async () => {
          throw new Error("the dispatch blew up");
        },
      });
      expect(out, "the press answers as it would have").toMatchObject({ extensions: 1 });
      expect(await rowOf(fixtureId)).toMatchObject({ checkin_extensions: 1 });
      const live = (await outboxOf(fixtureId)).filter((x) => x.status === "queued");
      expect(live.length, "the fresh rows are durable").toBe(before.length);
      const lines = logged.mock.calls.filter((c) => /sending the re-rendered invites failed/.test(String(c[1])));
      expect(lines.length, "and the failure is logged once").toBe(1);
      expect(JSON.stringify(lines[0])).toContain("Error");
    } finally {
      logged.mockRestore();
    }
  });

  it("the board's seats are read only when there is an invite to re-render: an extension with nothing waiting reads none, one with a waiting invite reads them once", async () => {
    const open = openAround();
    const sent = await openedRound(1, { open }); // the provider answers 200: every invite is `sent`
    const waiting = await rateLimitedRound(1, open);
    seatReads.n = 0;
    await press(sent.owner, sent.boards[0]!.fixtureId, at(open, MIN));
    expect(seatReads.n, "nothing waiting: the seats were never read").toBe(0);
    await pressWith(waiting.owner, waiting.boards[0]!.fixtureId, at(open, MIN), { dispatch: noDispatch });
    expect(seatReads.n, "an invite waiting: the seats were read once, outside the transaction").toBe(1);
  });

  it("the organiser's Resend takes the board's check-in window lock: it waits behind an extension in flight and names the EXTENDED deadline, never one read in front of it", async () => {
    const r = await openedRound(1); // opened at O: every invite is sent; the window is open at O + 30 s
    const fixtureId = r.boards[0]!.fixtureId;
    const holder = await sql.reserve();
    let done = false;
    let pending: Promise<unknown> | undefined;
    try {
      await holder`begin`;
      await lockCheckinWindow(holder, fixtureId); // the extension's first act
      const holderPid = await backendPid(holder);
      mail.sent.length = 0;
      pending = resendExternalPlayNotice(r.owner, fixtureId, ORIGIN, { now: at(O, 30_000) }).finally(() => {
        done = true;
      });
      expect(
        await pollWaitersBehind(holderPid, { queryLike: "%pg_advisory_xact_lock%", finished: () => done }),
        "premise: the Resend is genuinely WAITING on the window lock",
      ).toBeGreaterThan(0);
      expect(done, "and has not read the deadline").toBe(false);
      // The extension commits its move while the Resend waits.
      await holder`update fixture_external_play set checkin_extra_ms = ${CHECKIN_EXTEND_STEP_MS}, checkin_extensions = 1 where fixture_id = ${fixtureId}`;
      await holder`commit`;
      await pending;
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
      await pending?.catch(() => undefined);
    }
    expect(mail.sent.length, "premise: the Resend mailed the seats").toBeGreaterThanOrEqual(2);
    for (const m of mail.sent) {
      expect(namesDeadline(m.deadlineLabel, deadlineAfter(1)), `${m.to}: the extended deadline`).toBe(true);
      expect(namesDeadline(m.deadlineLabel, OLD), `${m.to}: not the old one`).toBe(false);
    }
  });
});

void LINE_DEADLINE_GRACE_MS;
