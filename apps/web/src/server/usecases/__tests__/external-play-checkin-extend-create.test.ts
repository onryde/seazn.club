// The check-in extension (spec 2026-10-09 §3.2.2) at the CREATE: the readers of a board's window that sit behind T9 and need the
// Lichess Board API module-mocked - the create itself, the bridge row's expiry, the create's dequeue, the line's cap, the sweep's
// mint-retry and its expected end. The other readers, the rule and the race are in external-play-checkin-extend.test.ts; both
// files carry `[extend-reader:<id>]` tests and batch-anchor-source-guard.test.ts proves the table closed over the two.
//
// Each test asks ONE question at ONE instant that falls between the unextended deadline and the extended one, of a board that was
// extended and of a control that was not, so the same question has two right answers - a reader that did not read the extension
// gives the control's answer for both. Every instant is written from the constants, never read back from window.ts.
//
// Single-sport by construction: online play exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS, DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS } from "@/server/external-play/window";
import { CREATION_429_HOLD_MS, __resetCreationQueue, __setCreationQueueDeps, enqueueCreation } from "@/server/external-play/creation-queue";

const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>() }));
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
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

// T8's seat: the real one would call RealtimeKit. Default is "both seated"; isPlayableFixtureStatus stays the REAL predicate.
const preflight = vi.hoisted(() => ({ seatPlayer: vi.fn() }));
vi.mock("../external-play/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-play/preflight")>()),
  seatPlayer: preflight.seatPlayer,
}));

// T4's REAL queue, observed: a test can tell when a create is WAITING in it.
const queue = vi.hoisted(() => ({ enqueued: [] as { key: string; challenger: string }[] }));
vi.mock("@/server/external-play/creation-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/creation-queue")>();
  return {
    ...actual,
    enqueueCreation: <T>(req: { key: string; challenger: string }, job: () => Promise<T>) => {
      queue.enqueued.push(req);
      return actual.enqueueCreation(req, job);
    },
  };
});

import { openRound } from "../external-play/open-round";
import { extendCheckin } from "../external-play/checkin-extend";
import { createGameIfReady } from "../external-play/create-game";
import { sweepExternalPlay, type SweepDeps } from "../external-play/sweep";
import { stampFixtureCheckIn } from "../me";
import type { AuthCtx } from "@/server/api-v1/auth";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const freshGameId = () => `gm-${randomUUID().slice(0, 12)}`;
beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  queue.enqueued.length = 0;
  board.createChallengeToUser.mockImplementation(async () => ({ ok: true, challengeId: freshGameId() }));
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });
  preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
});

// ── the instants, from the constants (as external-play-checkin-extend.test.ts) ──────────────────────────────────────────────
const O = new Date("2026-10-01T12:00:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const OLD = at(O, DEADLINE_AFTER_MS);
const deadlineAfter = (k: number) => at(OLD, k * CHECKIN_EXTEND_STEP_MS);
const EXT_AT = at(O, MIN);
/** Strictly between the unextended deadline and the deadline after one press. */
const P = at(OLD, MIN);
/** The division's clock; both clocks run out after `2 x (base + 40 x increment)`, the rulebook's expected end (M13). */
const CLOCK = { base: 300, increment: 3 } as const;
const M13_MOVE_WEIGHT = 40;

/** A round of `n` boards, opened through the product's `openRound` at O. Camera off: one batch, so a board's deadline is O + the window. */
async function openedRound(n: number): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures: n, clock: CLOCK });
  expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: O }), "premise: the real open").toMatchObject({ opened: true });
  return r;
}
const press = (auth: AuthCtx, fixtureId: string, now: Date = EXT_AT) => extendCheckin(auth, fixtureId, { now: () => now, publish: async () => {} });
/** Both players checked in inside the window (so past the deadline the create is allowed iff the window, extended or not, is still alive). */
async function bothCame(r: SeedOnlineChessRoundResult, b: SeedRoundBoard, when: Date = EXT_AT) {
  for (const side of [b.home, b.away]) await stampFixtureCheckIn(side.personId, b.fixtureId, r.orgId, { at: when });
}
const noHttp = () => {
  expect(board.createChallengeToUser, "no Lichess call may happen").not.toHaveBeenCalled();
  expect(board.acceptChallenge).not.toHaveBeenCalled();
};
const bridge = async (fixtureId: string) =>
  (await sql<{ status: string; expires_at: Date | null; sweep_no_truth_reads: number }[]>`
    select status, expires_at, sweep_no_truth_reads from fixture_external_play where fixture_id = ${fixtureId}`)[0];

function blockQueue() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = enqueueCreation({ key: `blocker-${randomUUID()}`, challenger: `blocker-${randomUUID().slice(0, 8)}` }, () => gate);
  return {
    release: async () => {
      open();
      await done;
    },
  };
}
async function waitUntilQueued(fixtureId: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!queue.enqueued.some((r) => r.key === fixtureId)) throw new Error("not queued yet");
    },
    { timeout: 15_000, interval: 20 },
  );
}

describe.skipIf(!HAS_DB)("the extension at the create (T9)", () => {
  it("[extend-reader:create] a create at P is not_ready on an unextended board and runs on an extended one; at the extended deadline exactly it is not_ready again, 1 ms before it runs", async () => {
    const r = await openedRound(4);
    const [plain, extended, edge, justBefore] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    for (const b of [extended, edge, justBefore]) await press(r.owner, b.fixtureId);
    expect(await createGameIfReady(plain.fixtureId, { now: P }), "unextended, past its deadline: the control").toEqual({ created: false, reason: "not_ready" });
    noHttp();
    expect(await createGameIfReady(extended.fixtureId, { now: P }), "extended: inside the new window").toMatchObject({ created: true });
    expect(await createGameIfReady(edge.fixtureId, { now: deadlineAfter(1) }), "at the extended deadline").toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser, "only the extended board's create went to Lichess").toHaveBeenCalledTimes(1);
    expect(await createGameIfReady(justBefore.fixtureId, { now: at(deadlineAfter(1), -1) }), "1 ms before it").toMatchObject({ created: true });
  }, 120_000);

  it("[extend-reader:expires-at] the ready row's expires_at is the board's EXTENDED deadline: 0, 1 and the cap's worth of presses", async () => {
    const r = await openedRound(CHECKIN_EXTEND_MAX + 1);
    let checked = 0;
    for (let k = 0; k <= CHECKIN_EXTEND_MAX; k++) {
      const b = r.boards[k]!;
      for (let i = 0; i < k; i++) await press(r.owner, b.fixtureId);
      expect(await createGameIfReady(b.fixtureId, { now: EXT_AT }), `${k} presses`).toMatchObject({ created: true });
      expect((await bridge(b.fixtureId))?.expires_at?.toISOString(), `${k} presses: the row expires at the board's deadline`).toBe(deadlineAfter(k).toISOString());
      checked += 1;
    }
    expect(checked, "anti-vacuity: presses counts checked").toBe(CHECKIN_EXTEND_MAX + 1);
    // Created PAST the old deadline, inside the new one: the row expires at the NEW deadline (the create is inside the window, so
    // the allowance's cap is not what it expires at).
    const q = await openedRound(1);
    const lateBoard = q.boards[0]!;
    await press(q.owner, lateBoard.fixtureId);
    expect(await createGameIfReady(lateBoard.fixtureId, { now: P }), "created past the old deadline").toMatchObject({ created: true });
    expect((await bridge(lateBoard.fixtureId))?.expires_at?.toISOString(), "expires at the extended deadline").toBe(deadlineAfter(1).toISOString());
  }, 120_000);

  it("[extend-reader:dequeue] a create that WAITED in the queue past the old deadline runs on an extended board and is not_ready on an unextended one", async () => {
    const r = await openedRound(2);
    const [plain, extended] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await press(r.owner, extended.fixtureId);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const waits = async (b: SeedRoundBoard) => {
        vi.setSystemTime(EXT_AT);
        const blocker = blockQueue();
        const pending = createGameIfReady(b.fixtureId);
        await waitUntilQueued(b.fixtureId);
        vi.setSystemTime(P); // the world moves past the OLD deadline while it waits
        await blocker.release();
        return pending;
      };
      expect(await waits(extended), "extended: still inside its window at the dequeue").toMatchObject({ created: true });
      board.createChallengeToUser.mockClear();
      board.acceptChallenge.mockClear();
      expect(await waits(plain), "unextended: past its deadline at the dequeue, nobody counted").toEqual({ created: false, reason: "not_ready" });
      noHttp();
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("an extension that lands BETWEEN the plan and the dequeue is seen at the dequeue (the window is re-read there, not carried in the plan), and the row expires at the new deadline", async () => {
    const r = await openedRound(2);
    const [landed, control] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const waits = async (b: SeedRoundBoard, between: () => Promise<unknown>) => {
        vi.setSystemTime(EXT_AT);
        const blocker = blockQueue();
        const pending = createGameIfReady(b.fixtureId); // the PLAN is made now: the board's window is the unextended one
        await waitUntilQueued(b.fixtureId);
        await between(); // ...an arbiter extends while the create waits
        vi.setSystemTime(P); // ...and the world moves past the OLD deadline
        await blocker.release();
        return pending;
      };
      expect(
        await waits(landed, () => press(r.owner, landed.fixtureId)),
        "the extension landed between plan and dequeue: the create runs",
      ).toMatchObject({ created: true });
      expect((await bridge(landed.fixtureId))?.expires_at?.toISOString(), "and the row expires at the EXTENDED deadline").toBe(deadlineAfter(1).toISOString());
      board.createChallengeToUser.mockClear();
      board.acceptChallenge.mockClear();
      expect(await waits(control, async () => undefined), "the control: nothing landed, past the old deadline at the dequeue").toEqual({ created: false, reason: "not_ready" });
      noHttp();
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("the line's cap moves with the deadline: both players counted, a create after the extended deadline and before the extended cap runs; the same instant on an unextended board is past ITS cap", async () => {
    const r = await openedRound(3);
    const [plain, extended, atCap] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    for (const b of [plain, extended, atCap]) await bothCame(r, b);
    await press(r.owner, extended.fixtureId);
    await press(r.owner, atCap.fixtureId);
    // After one press the deadline is OLD + a step. The cap is a grace later. A probe 30 s past the extended deadline is past the
    // UNEXTENDED cap while the step is at least the grace (both five minutes today): asserted below, not assumed.
    const probe = at(deadlineAfter(1), 30_000);
    expect(probe.getTime(), "premise: the probe is past the unextended board's cap (retune the probe if the step ever drops below the grace)").toBeGreaterThan(at(OLD, LINE_DEADLINE_GRACE_MS).getTime());
    expect(await createGameIfReady(plain.fixtureId, { now: probe }), "unextended, past its cap").toEqual({ created: false, reason: "not_ready" });
    noHttp();
    const made = await createGameIfReady(extended.fixtureId, { now: probe });
    expect(made, "extended: past its deadline, inside its cap, both counted").toMatchObject({ created: true });
    expect((await bridge(extended.fixtureId))?.expires_at?.toISOString(), "created past the deadline: the row expires at the EXTENDED cap").toBe(
      at(deadlineAfter(1), LINE_DEADLINE_GRACE_MS).toISOString(),
    );
    board.createChallengeToUser.mockClear();
    board.acceptChallenge.mockClear();
    expect(await createGameIfReady(atCap.fixtureId, { now: at(deadlineAfter(1), LINE_DEADLINE_GRACE_MS) }), "AT the extended cap").toEqual({ created: false, reason: "not_ready" });
    noHttp();
  }, 120_000);
});

describe.skipIf(!HAS_DB)("the extension in the sweep's create and end readers", () => {
  const sweep = (r: SeedOnlineChessRoundResult, now: Date, over: SweepDeps = {}) => sweepExternalPlay({ ...over, now, orgIds: [r.orgId] });

  it("[extend-reader:mint-retry] a create Lichess throttled is retried past the unextended cap when the board is extended, and not retried on an unextended board", async () => {
    const r = await openedRound(2);
    const [plain, extended] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    for (const b of [plain, extended]) await bothCame(r, b);
    // Two presses: the deadline is OLD + 2 steps, past the unextended CAP (OLD + the line's grace) by construction of the probe below.
    for (let i = 0; i < 2; i++) await press(r.owner, extended.fixtureId);
    const probe = at(OLD, LINE_DEADLINE_GRACE_MS + MIN);
    expect(probe.getTime(), "premise: the probe is past the throttle's hold").toBeGreaterThanOrEqual(at(EXT_AT, CREATION_429_HOLD_MS).getTime());
    expect(probe.getTime(), "premise: inside the twice-extended window").toBeLessThan(deadlineAfter(2).getTime());
    for (const b of [plain, extended]) {
      __setCreationQueueDeps({ now: () => EXT_AT.getTime() });
      board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests. Try again later." });
      expect(await createGameIfReady(b.fixtureId, { now: EXT_AT, publish: async () => {} }), "premise: T9 was throttled").toEqual({ created: false, reason: "provider_error" });
    }
    const tried: string[] = [];
    const createGame: NonNullable<SweepDeps["createGameIfReady"]> = async (fixtureId, d) => {
      tried.push(fixtureId);
      __setCreationQueueDeps({ now: () => d.now.getTime() });
      return createGameIfReady(fixtureId, { now: d.now, publish: async () => {} });
    };
    const report = await sweep(r, probe, { createGameIfReady: createGame });
    expect(tried, "only the extended board is retried").toEqual([extended.fixtureId]);
    expect(report.mintRetries).toBe(1);
  }, 120_000);

  it("[extend-reader:expected-end] a ready game that never started has its expected end counted from the EXTENDED deadline: an empty read between the two ends is not counted", async () => {
    const r = await openedRound(2);
    const [plain, extended] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    for (const b of [plain, extended]) await bothCame(r, b);
    await press(r.owner, extended.fixtureId);
    for (const b of [plain, extended]) expect(await createGameIfReady(b.fixtureId, { now: EXT_AT, publish: async () => {} }), "premise: ready").toMatchObject({ created: true });
    // The rulebook's end: the deadline plus both clocks running out, M13's moves of increment each (from the rulebook, not the code).
    const endAfter = (deadline: Date) => at(deadline, 2 * (CLOCK.base + M13_MOVE_WEIGHT * CLOCK.increment) * 1000);
    const mid = at(endAfter(OLD), 1);
    expect(endAfter(deadlineAfter(1)).getTime(), "premise: the two ends differ").toBeGreaterThan(mid.getTime());
    const empty: NonNullable<SweepDeps["reconcile"]> = async () => null;
    await sweep(r, mid, { reconcile: empty });
    expect((await bridge(plain.fixtureId))?.sweep_no_truth_reads, "past the unextended end: counted").toBe(1);
    expect((await bridge(extended.fixtureId))?.sweep_no_truth_reads, "past the old end, before the extended one: not counted").toBe(0);
    await sweep(r, at(endAfter(deadlineAfter(1)), 1), { reconcile: empty });
    expect((await bridge(extended.fixtureId))?.sweep_no_truth_reads, "past its own extended end: counted").toBe(1);
  }, 120_000);
});
