// T9 — the property the controller asked for: random interleavings of
// {seat White, seat Black, queue release, 429, timeout, withdrawal, retry,
// reschedule (fix round 1, I1)}
// against the REAL creation queue (T4) and the real database. Invariants: at
// most one Lichess challenge per fixture, and never a game on a board that is
// no longer playable. Every call's outcome is also checked against a model
// written from the queue's DECLARED limits (CREATION_PER_CHALLENGER,
// CREATION_429_HOLD_MS) and the board's own rules, never read off create-game.ts.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts's `d.sport_key = 'boardgame'`).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { sql } from "@/lib/db";
import {
  CREATION_429_HOLD_MS,
  CREATION_PER_CHALLENGER,
  __resetCreationQueue,
  __setCreationQueueDeps,
  enqueueCreation,
} from "@/server/external-play/creation-queue";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady, type CreateOutcome } from "../external-play/create-game";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");

const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

const preflight = vi.hoisted(() => ({ seatPlayer: vi.fn() }));
vi.mock("../external-play/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-play/preflight")>()),
  seatPlayer: preflight.seatPlayer,
}));

const queue = vi.hoisted(() => ({ enqueued: [] as { key: string; challenger: string }[] }));
vi.mock("@/server/external-play/creation-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/creation-queue")>();
  return {
    ...actual,
    enqueueCreation: <R>(req: { key: string; challenger: string }, job: () => Promise<R>) => {
      queue.enqueued.push(req);
      return actual.enqueueCreation(req, job);
    },
  };
});

afterAll(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Act =
  | { kind: "arrive"; colour: "white" | "black" }
  | { kind: "block" }
  | { kind: "release" }
  | { kind: "429" }
  | { kind: "timeout" }
  | { kind: "withdraw" }
  | { kind: "retry" }
  | { kind: "reschedule" }
  | { kind: "wait" };

const act: fc.Arbitrary<Act> = fc.oneof(
  { arbitrary: fc.constantFrom<"white" | "black">("white", "black").map((colour) => ({ kind: "arrive" as const, colour })), weight: 3 },
  { arbitrary: fc.constant<Act>({ kind: "retry" }), weight: 3 },
  { arbitrary: fc.constant<Act>({ kind: "block" }), weight: 1 },
  { arbitrary: fc.constant<Act>({ kind: "release" }), weight: 2 },
  { arbitrary: fc.constant<Act>({ kind: "429" }), weight: 1 },
  { arbitrary: fc.constant<Act>({ kind: "timeout" }), weight: 1 },
  { arbitrary: fc.constant<Act>({ kind: "withdraw" }), weight: 1 },
  { arbitrary: fc.constant<Act>({ kind: "wait" }), weight: 1 },
  { arbitrary: fc.constant<Act>({ kind: "reschedule" }), weight: 1 },
);
const W: Act = { kind: "arrive", colour: "white" };
const B: Act = { kind: "arrive", colour: "black" };
// Prefixes that reach the paths the property is named for; random tails mix
// everything else in after them.
const prefix = fc.oneof(
  { arbitrary: fc.constant<Act[]>([]), weight: 2 },
  { arbitrary: fc.constant<Act[]>([B, W]), weight: 1 },
  { arbitrary: fc.constant<Act[]>([W, { kind: "block" }, B, { kind: "withdraw" }, { kind: "release" }]), weight: 1 },
  { arbitrary: fc.constant<Act[]>([W, { kind: "block" }, B, { kind: "retry" }, { kind: "release" }]), weight: 1 },
  { arbitrary: fc.constant<Act[]>([{ kind: "429" }, W, B, { kind: "retry" }, { kind: "wait" }, { kind: "retry" }]), weight: 1 },
  { arbitrary: fc.constant<Act[]>([{ kind: "timeout" }, B, W, { kind: "retry" }]), weight: 1 },
  // Fix round 1, I1: a reschedule after a game, after a held unknown
  // outcome, and while a create waits in the queue.
  { arbitrary: fc.constant<Act[]>([B, W, { kind: "reschedule" }, { kind: "retry" }]), weight: 1 },
  { arbitrary: fc.constant<Act[]>([{ kind: "timeout" }, B, W, { kind: "reschedule" }, { kind: "retry" }]), weight: 1 },
  { arbitrary: fc.constant<Act[]>([W, { kind: "block" }, B, { kind: "reschedule" }, { kind: "release" }, { kind: "retry" }]), weight: 1 },
);
const scenario = fc
  .tuple(prefix, fc.array(act, { minLength: 1, maxLength: 12 }))
  .map(([head, rest]) => [...head, ...rest]);

/** T4's declared per-challenger minute window (lila's "fast" bucket), and the
 *  step that clears both it and a 429 hold. */
const MINUTE = CREATION_PER_CHALLENGER[0]!;
const WAIT_MS = Math.max(MINUTE.windowMs, CREATION_429_HOLD_MS) + 1;

type Expect = { kind: "created" } | { kind: "outcome"; outcome: CreateOutcome };
const NOT_READY: Expect = { kind: "outcome", outcome: { created: false, reason: "not_ready" } };
const ALREADY: Expect = { kind: "outcome", outcome: { created: false, reason: "already" } };
const PROVIDER: Expect = { kind: "outcome", outcome: { created: false, reason: "provider_error" } };

type Run = {
  s: SeedOnlineChessFixtureResult;
  arrived: Set<string>;
  withdrawn: boolean;
  /** What Lichess answers the NEXT create with. */
  slot: "ok" | "429" | "timeout";
  /** Creates that may have made a challenge at Lichess (ok, or a timeout). */
  maybeCreated: number;
  lastId: string | null;
  /** Minutes the fixture has been moved by (a fresh time per reschedule). */
  moves: number;
};
let current: Run | null = null;
/** A call's outcome, or what it threw — kept so a queued call never rejects
 *  unobserved while the run goes on. */
type Settled = { v?: CreateOutcome; e?: unknown };

describe.skipIf(!process.env.DATABASE_URL)("property: random interleavings of seat / queue / 429 / timeout / withdrawal / retry", () => {
  it(
    "at most one Lichess challenge per fixture, never a game on an unplayable board — and every outcome matches the model",
    async () => {
      const totals = {
        runs: 0,
        actions: 0,
        calls: 0,
        createCalls: 0,
        created: 0,
        publishes: 0,
        already: 0,
        blackFirst: 0,
        rate429: 0,
        holdRefusals: 0,
        budgetRefusals: 0,
        createdAfter429: 0,
        timeoutsHeld: 0,
        notReadyWhileHeld: 0,
        withdrawnBeforeCall: 0,
        withdrawnWhileQueued: 0,
        pendingGroups: 0,
        dedupedCalls: 0,
        // Fix round 1: distinct games made, followers told `already`, and the
        // three reschedule paths.
        games: 0,
        alreadyFollowers: 0,
        rescheduledAfterGame: 0,
        rescheduledAfterHold: 0,
        rescheduledWhileQueued: 0,
        // The invariants, counted on their own.
        violationsDuplicate: 0,
        violationsUnplayable: 0,
        violationsUnclaimed: 0,
        violationsUnseated: 0,
        violationsStuckClaim: 0,
      };

      board.createChallengeToUser.mockImplementation(
        async (a: { whiteToken: string; blackUsername: string }) => {
          const r = current!;
          totals.createCalls += 1;
          // Read at the moment of the call — the only moment that matters.
          const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${r.s.fixtureId}`;
          if (r.withdrawn || fx?.status !== "scheduled") totals.violationsUnplayable += 1;
          const [b] = await sql<{ status: string; challenge_id: string | null; mint_claimed_at: Date | null }[]>`
            select status, challenge_id, mint_claimed_at from fixture_external_play where fixture_id = ${r.s.fixtureId}`;
          if (!b || b.status !== "pending" || b.challenge_id !== null || b.mint_claimed_at === null) {
            totals.violationsUnclaimed += 1;
          }
          if (!r.arrived.has(r.s.home.personId) || !r.arrived.has(r.s.away.personId)) totals.violationsUnseated += 1;
          // No pairing card ⇒ White is home: home's token creates, away is challenged.
          expect(a.whiteToken).toBe(`lio_seed_${r.s.home.lichessId}`);
          expect(a.blackUsername).toBe(r.s.away.lichessId);
          const slot = r.slot;
          r.slot = "ok";
          if (slot === "429") return { ok: false, code: "rate_limited", raw: "Too many requests" };
          r.maybeCreated += 1;
          if (r.maybeCreated > 1) totals.violationsDuplicate += 1;
          if (slot === "timeout") return { ok: false, code: "outcome_unknown", raw: "" };
          r.lastId = `pg-${randomUUID().slice(0, 12)}`;
          return { ok: true, challengeId: r.lastId };
        },
      );
      board.acceptChallenge.mockResolvedValue({ ok: true });
      // No create in this property can leave a marker on a claimable row (a
      // 429 clears it; an unknown outcome is held), so the recovery lookups
      // are never reached: answering "unknown" would surface as a mismatch.
      board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected lookup" });
      board.listOngoingGames.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected lookup" });
      board.cancelChallenge.mockResolvedValue({ ok: true });
      preflight.seatPlayer.mockImplementation(async (a: { personId: string }) =>
        current!.arrived.has(a.personId)
          ? { seated: true, participant: null }
          : { seated: false, reason: "camera_required", participant: null },
      );
      const publish = async () => {
        totals.publishes += 1;
      };

      await fc.assert(
        fc.asyncProperty(scenario, async (acts) => {
          totals.runs += 1;
          __resetCreationQueue();
          queue.enqueued.length = 0;
          let qNow = Date.parse("2026-10-01T12:05:00.000Z");
          __setCreationQueueDeps({ now: () => qNow });
          const s = await seedOnlineChessFixture({
            onlinePlay: "lichess",
            divisionStarted: true,
            scheduledAt: T,
            linked: true,
            roundOpenedAt: OPENED,
            clock: { base: 300, increment: 3 },
          });
          const r: Run = { s, arrived: new Set(), withdrawn: false, slot: "ok", maybeCreated: 0, lastId: null, moves: 0 };
          current = r;
          // The model. Object fields: they change inside the loop.
          const m: {
            game: "none" | "ready" | "held";
            held: boolean; // a 429 hold on White is in force
            stamps: number; // White's creates charged in this minute
            saw429: boolean;
            movedWhileQueued: boolean; // a reschedule landed after the queued group's first call
          } = { game: "none", held: false, stamps: 0, saw429: false, movedWhileQueued: false };
          let blocker: { release: () => Promise<void> } | null = null;
          let pending: { where: string; got: Promise<Settled> }[] = [];

          /** What the checks BEFORE the queue answer, or null if it is queued. */
          const beforeQueue = (): Expect | null => {
            if (m.game === "ready") return ALREADY;
            if (m.game === "held") {
              totals.notReadyWhileHeld += 1;
              return NOT_READY;
            }
            if (r.withdrawn) {
              totals.withdrawnBeforeCall += 1;
              return NOT_READY;
            }
            const white = r.arrived.has(s.home.personId);
            const black = r.arrived.has(s.away.personId);
            if (!white || !black) {
              if (black && !white) totals.blackFirst += 1;
              return NOT_READY;
            }
            return null;
          };
          /** What the queue and the dequeue answer, mutating the model. */
          const atDequeue = (): Expect => {
            if (m.held) {
              totals.holdRefusals += 1;
              return PROVIDER;
            }
            if (m.stamps >= MINUTE.max) {
              totals.budgetRefusals += 1;
              return PROVIDER;
            }
            m.stamps += 1; // T4 charges every run it lets through
            if (r.withdrawn) {
              totals.withdrawnWhileQueued += 1;
              return NOT_READY;
            }
            if (m.movedWhileQueued) return NOT_READY; // rescheduled while queued: refused before any claim
            const slot = r.slot;
            if (slot === "429") {
              m.held = true;
              m.saw429 = true;
              totals.rate429 += 1;
              return PROVIDER;
            }
            if (slot === "timeout") {
              m.game = "held";
              totals.timeoutsHeld += 1;
              return PROVIDER;
            }
            m.game = "ready";
            totals.games += 1;
            return { kind: "created" };
          };
          const settle = (want: Expect, got: CreateOutcome, where: string) => {
            if (want.kind === "created") {
              expect(got, where).toEqual({ created: true, gameId: r.lastId });
              totals.created += 1;
              if (m.saw429) totals.createdAfter429 += 1;
            } else {
              expect(got, where).toEqual(want.outcome);
              if (!got.created && got.reason === "already") totals.already += 1;
            }
          };
          const call = async (where: string) => {
            totals.calls += 1;
            const pre = beforeQueue();
            // The model answers BEFORE the call: the Lichess mock consumes the
            // scripted answer as it runs.
            const want = pre ?? (blocker ? null : atDequeue());
            const before = queue.enqueued.length;
            const p: Promise<Settled> = createGameIfReady(s.fixtureId, { now: NOW, publish }).then(
              (v) => ({ v }),
              (e: unknown) => ({ e }),
            );
            if (want !== null) {
              const out = await p;
              if (out.e) throw out.e;
              settle(want, out.v!, where);
              return;
            }
            // Queued behind the blocker: wait until it is really IN the queue.
            await vi.waitFor(
              () => {
                if (queue.enqueued.length === before) throw new Error(`${where}: not queued yet`);
              },
              { timeout: 10_000, interval: 5 },
            );
            pending.push({ where, got: p });
          };
          const release = async () => {
            if (!blocker) return;
            const b = blocker;
            blocker = null;
            const group = pending;
            pending = [];
            // One create per fixture in flight: every caller queued behind the
            // blocker shares the one run, so the model answers once for all.
            const want = group.length > 0 ? atDequeue() : null;
            m.movedWhileQueued = false;
            await b.release();
            if (group.length > 0) totals.pendingGroups += 1;
            if (group.length > 1) totals.dedupedCalls += group.length - 1;
            for (const [i, g] of group.entries()) {
              const out = await g.got;
              if (out.e) throw out.e;
              // Minor a: the group's FIRST call is the leader whose job ran;
              // a follower made nothing and answers `already`.
              if (i > 0 && want!.kind === "created") {
                settle(ALREADY, out.v!, `${g.where} (released, follower)`);
                totals.alreadyFollowers += 1;
              } else {
                settle(want!, out.v!, `${g.where} (released)`);
              }
            }
          };

          for (const [i, x] of acts.entries()) {
            totals.actions += 1;
            const where = `${JSON.stringify(acts)} → #${i} ${JSON.stringify(x)}`;
            if (x.kind === "arrive") {
              r.arrived.add(x.colour === "white" ? s.home.personId : s.away.personId);
              await call(where);
            } else if (x.kind === "retry") {
              await call(where);
            } else if (x.kind === "block") {
              if (!blocker) {
                let open!: () => void;
                const gate = new Promise<void>((resolve) => {
                  open = resolve;
                });
                const done = enqueueCreation(
                  { key: `blocker-${randomUUID()}`, challenger: `blocker-${randomUUID().slice(0, 8)}` },
                  () => gate,
                );
                blocker = {
                  release: async () => {
                    open();
                    await done;
                  },
                };
              }
            } else if (x.kind === "release") {
              await release();
            } else if (x.kind === "429") {
              r.slot = "429";
            } else if (x.kind === "timeout") {
              r.slot = "timeout";
            } else if (x.kind === "reschedule") {
              r.moves += 2;
              await sql`update fixtures set scheduled_at = ${new Date(T.getTime() + r.moves * 60_000)} where id = ${s.fixtureId}`;
              if (m.game === "ready") totals.rescheduledAfterGame += 1;
              if (m.game === "held") totals.rescheduledAfterHold += 1;
              if (pending.length > 0) {
                m.movedWhileQueued = true;
                totals.rescheduledWhileQueued += 1;
              }
            } else if (x.kind === "withdraw") {
              if (!r.withdrawn) {
                await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
                r.withdrawn = true;
              }
            } else {
              qNow += WAIT_MS;
              m.held = false;
              m.stamps = 0;
            }
          }
          await release();

          const [row] = await sql<{
            status: string; challenge_id: string | null; white_side: string | null;
            mint_claimed_at: Date | null; needs_reason: string | null;
          }[]>`
            select status, challenge_id, white_side, mint_claimed_at, needs_reason
              from fixture_external_play where fixture_id = ${s.fixtureId}`;
          const tag = JSON.stringify(acts);
          if (row?.mint_claimed_at) totals.violationsStuckClaim += 1;
          if (m.game === "ready") {
            expect(row?.status, tag).toBe("ready");
            expect(row?.challenge_id, tag).toBe(r.lastId);
            expect(row?.white_side, tag).toBe("home");
          } else if (m.game === "held") {
            expect(row?.status, tag).toBe("needs_organiser");
            expect(row?.needs_reason, tag).toBe("provider_error");
            expect(row?.challenge_id ?? null, tag).toBeNull();
          } else {
            expect(row?.challenge_id ?? null, tag).toBeNull();
          }
          current = null;
        }),
        // endOnFailure: every replay seeds a whole fixture, so shrinking is
        // switched off; the failing sequence is printed in each message.
        { numRuns: 60, seed: 20261009, endOnFailure: true },
      );

      console.log(`PROPERTY_COUNTS ${JSON.stringify(totals)}`);
      expect(totals.violationsDuplicate, "INVARIANT: at most one Lichess challenge per fixture").toBe(0);
      expect(totals.violationsUnplayable, "INVARIANT: never a game on an unplayable board").toBe(0);
      expect(totals.violationsUnclaimed, "INVARIANT: no create without this caller's claim on a pending row").toBe(0);
      expect(totals.violationsUnseated, "INVARIANT: no create before both players are seated").toBe(0);
      expect(totals.violationsStuckClaim, "INVARIANT: no claim left behind").toBe(0);
      // Minor a: counted against DISTINCT games the model let through to
      // Lichess, not against outcomes — a follower's answer is not a game.
      expect(totals.publishes, "one lobby publish per distinct game").toBe(totals.games);
      expect(totals.created, "one `created` answer per distinct game").toBe(totals.games);
      // Anti-vacuity: zero checked is a failure, per path the property is named for.
      expect(totals.runs, "runs").toBeGreaterThanOrEqual(60);
      expect(totals.calls, "calls").toBeGreaterThan(0);
      expect(totals.createCalls, "create calls").toBeGreaterThan(0);
      expect(totals.created, "games created").toBeGreaterThan(0);
      expect(totals.already, "already after a game").toBeGreaterThan(0);
      expect(totals.blackFirst, "Black arriving first").toBeGreaterThan(0);
      expect(totals.rate429, "429s").toBeGreaterThan(0);
      expect(totals.holdRefusals, "retries refused inside a 429 hold").toBeGreaterThan(0);
      expect(totals.createdAfter429, "a game created after a 429 and a wait").toBeGreaterThan(0);
      expect(totals.timeoutsHeld, "timeouts held for an organiser").toBeGreaterThan(0);
      expect(totals.notReadyWhileHeld, "retries after a timeout").toBeGreaterThan(0);
      expect(totals.withdrawnBeforeCall, "calls after a withdrawal").toBeGreaterThan(0);
      expect(totals.withdrawnWhileQueued, "withdrawn while queued").toBeGreaterThan(0);
      expect(totals.pendingGroups, "creates released from the queue").toBeGreaterThan(0);
      expect(totals.dedupedCalls, "concurrent creates sharing one run").toBeGreaterThan(0);
      expect(totals.games, "distinct games").toBeGreaterThan(0);
      expect(totals.alreadyFollowers, "followers of a created run").toBeGreaterThan(0);
      expect(totals.rescheduledAfterGame, "a reschedule after a game").toBeGreaterThan(0);
      expect(totals.rescheduledAfterHold, "a reschedule after a held unknown outcome").toBeGreaterThan(0);
      expect(totals.rescheduledWhileQueued, "a reschedule while queued").toBeGreaterThan(0);
    },
    300_000,
  );
});
