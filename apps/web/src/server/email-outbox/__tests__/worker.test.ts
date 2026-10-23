// The email outbox's retry worker against a real Postgres, with the one network seam (@/server/email-outbox/transport)
// replaced by a vi.fn. Spec: docs/superpowers/specs/2026-10-19-email-outbox-design.md ("The retry worker", "Sending"),
// rulings R9 and R10 and the plan's Task 4.
//
// What each group pins:
//  - the sequences the house rules owe: retry then success under ONE idempotency key, exhaustion after MAX_ATTEMPTS, a lapsed
//    lease reclaimed (and at the attempt ceiling ended dead), expiry, the R9 reclaim after a 2xx whose write failed;
//  - the bounds: a batch ceiling, Resend's 2 requests a second as a wait between attempts, a time budget, a stop at the
//    first 429, and a deferred count that reads "rows due right now that this tick did not take";
//  - the claim itself: only due rows, oldest first, never a row another tick holds (skip locked), `attempts + 1` and the
//    lease set in the claiming statement (R10), and nothing outside the ids a test scopes the tick to;
//  - the hooks: run for every row the tick ended, re-driven for a badly-ended row whose effect was never applied (R9), and
//    never run for a row that did not end badly.
//
// SHARED DATABASE. Test files run in parallel against one database, and the worker claims ANY due row, so every tick below
// is scoped with `onlyIds` (the seam external-play's sweep has as `orgIds`); a row outside the scope is proven untouched.
//
// Clock. The tick's pacing and budget read an injected monotonic clock whose `sleep` advances it, so "waits are exactly
// MIN_SEND_INTERVAL_MS" is arithmetic, not a stopwatch. One test uses the real default sleep.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { suppress, type DeliverResult } from "@/lib/email";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { attemptClaimed, dispatchNow, toClaimedRow, type ClaimedRecord, type ClaimedRow } from "../attempt";
import {
  ENDED_BADLY_STATUSES,
  ENDING_BATCH_SIZE,
  HOOK_RESERVE_FRACTION,
  HOOK_RESERVE_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MIN_SEND_INTERVAL_MS,
  OUTBOX_KINDS,
  PACING_HEADROOM_MS,
  REDRIVE_LIMIT,
  RESEND_IDEMPOTENCY_TTL_MS,
  RESEND_MIN_INTERVAL_MS,
  RESEND_REQUESTS_PER_SECOND,
  RETRY_DELAYS_MS,
  SEND_TIMEOUT_MS,
  STG_TICK_MS,
  TICK_BUDGET_MS,
  WORKER_BATCH_SIZE,
  idempotencyKey,
  type OutboxKind,
} from "../constants";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { KIND_HOOKS, type EndedRow } from "../hooks";
import { runOutboxTick, type OutboxTickReport, type RunOutboxTickOptions } from "../worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t4-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const API_KEY = "re_test";
const MIN = 60_000;
/** A provider id unique to this run: provider_id is unique across the table. */
const pid = (s: string): string => `re_${s}_${RUN}`;

/** The `budgetMs` for which the SEND loop's share (the budget less the hook reserve) is `sendMs`. */
const budgetFor = (sendMs: number): number => sendMs / (1 - HOOK_RESERVE_FRACTION);

const ZERO: OutboxTickReport = { claimed: 0, sent: 0, retried: 0, dead: 0, suppressed: 0, expired: 0, failed: 0, deferred: 0 };
const REPORT_KEYS = Object.keys(ZERO).sort();

type Row = {
  id: string;
  kind: OutboxKind;
  ref_type: string;
  ref_id: string;
  meta: Record<string, string>;
  recipient: string;
  body_sealed: Buffer | null;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  expires_at: Date;
  last_error: string | null;
  provider_id: string | null;
  status_at: Date;
};

const http = (status: number, errorName: string | null): DeliverResult => ({
  ok: false,
  reason: "http",
  status,
  errorName,
  detail: `RAW-PROVIDER-DETAIL-${status}`,
});

/** The fake provider: one message per Idempotency-Key, however many requests carry it (what Resend does for 24 h). */
function makeProvider() {
  const messages = new Map<string, string>(); // key -> provider id
  const requests: string[] = []; // every key seen, in order
  return {
    messages,
    requests,
    accept: (key: string): DeliverResult => {
      requests.push(key);
      if (!messages.has(key)) messages.set(key, pid(randomUUID()));
      return { ok: true, providerId: messages.get(key)! };
    },
  };
}

type Sent = { to: string; idempotencyKey: string; tags: Record<string, string>; html: string; text: string };
const idOf = (m: { tags: Record<string, string> }): string => m.tags.outbox!;

function msg(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    kind: "magic_link",
    refType: "login",
    refId: `${RUN}-${randomUUID()}`,
    orgId: null,
    to: `${randomUUID()}@x.test`,
    subject: "Your sign-in link",
    html: `<a href="https://seazn.club/v?token=${randomUUID()}">Sign in</a>`,
    text: "Sign in",
    transactional: true,
    expiresAt: new Date(Date.now() + 15 * MIN),
    ...over,
  };
}

describe("the schedule the worker keeps (no database)", () => {
  it("R9: the whole reclaim span, worst case, stays inside Resend's 24 h idempotency-key life (derived from the constants)", () => {
    const delays = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    // Every attempt may crash (a lease to wait out), wait for the slowest cadence (stg's 5-minute tick), sit behind a full
    // tick (the budget) and run its request to the timeout.
    const worst = delays + MAX_ATTEMPTS * (SEND_TIMEOUT_MS + LEASE_MS + STG_TICK_MS + TICK_BUDGET_MS);
    // Anti-vacuity: the sum really was built from five delays and six attempts' slack, and it is not a trivial bound.
    expect(RETRY_DELAYS_MS.length).toBe(MAX_ATTEMPTS - 1);
    expect(worst).toBeGreaterThan(delays);
    expect(worst).toBeLessThan(RESEND_IDEMPOTENCY_TTL_MS);
  });

  it("the bounds are positive whole numbers and nest: a full batch's pacing waits fit inside the time budget", () => {
    for (const [name, n] of Object.entries({ WORKER_BATCH_SIZE, MIN_SEND_INTERVAL_MS, TICK_BUDGET_MS, REDRIVE_LIMIT })) {
      expect(Number.isInteger(n) && n > 0, name).toBe(true);
    }
    expect((WORKER_BATCH_SIZE - 1) * MIN_SEND_INTERVAL_MS).toBeLessThan(TICK_BUDGET_MS);
    // Resend's limit is 2 requests a second; the pacing is STRICTLY under it (see the headroom test below).
    expect(1000 / MIN_SEND_INTERVAL_MS).toBeLessThan(RESEND_REQUESTS_PER_SECOND);
  });

  it("the hook reserve is a fraction of the tick budget: positive, under the whole, and leaves room to send a full pacing wait", () => {
    expect(HOOK_RESERVE_FRACTION).toBeGreaterThan(0);
    expect(HOOK_RESERVE_FRACTION).toBeLessThan(1);
    expect(HOOK_RESERVE_MS).toBe(TICK_BUDGET_MS * HOOK_RESERVE_FRACTION);
    // The controller's ruling: a quarter of the budget. A pinned ruling, not read back from the code under test.
    expect(HOOK_RESERVE_FRACTION).toBe(0.25);
    // The sends keep a real share: at least a full batch's pacing waits fit in the part the reserve leaves them.
    expect((WORKER_BATCH_SIZE - 1) * MIN_SEND_INTERVAL_MS).toBeLessThan(TICK_BUDGET_MS - HOOK_RESERVE_MS);
    // A round of the bounded ending statements' hooks at a generous per-hook cost fits in the reserve.
    expect(HOOK_RESERVE_MS / (2 * ENDING_BATCH_SIZE + WORKER_BATCH_SIZE)).toBeGreaterThanOrEqual(25);
  });

  it("M1 (Task 4 review): the pacing is Resend's own floor PLUS headroom, so a timer that fires early cannot breach the limit", () => {
    // Resend's floor between two requests, from its rate (2 a second), and a headroom that is a named, positive number.
    expect(RESEND_MIN_INTERVAL_MS).toBe(1000 / RESEND_REQUESTS_PER_SECOND);
    expect(PACING_HEADROOM_MS).toBeGreaterThan(0);
    expect(MIN_SEND_INTERVAL_MS).toBe(RESEND_MIN_INTERVAL_MS + PACING_HEADROOM_MS);
    // Strictly slower than the provider allows: at the pacing, requests per second are under the limit.
    expect(1000 / MIN_SEND_INTERVAL_MS).toBeLessThan(RESEND_REQUESTS_PER_SECOND);
    // The reviewer's ruling (M1): 600 ms. A pinned ruling, not a value read back from the code under test.
    expect(MIN_SEND_INTERVAL_MS).toBe(600);
  });
});

describe.skipIf(!HAS_DB)("the email outbox retry worker (DB)", () => {
  const created: string[] = [];
  const suppressed: string[] = [];
  const savedHooks = {} as Record<OutboxKind, (typeof KIND_HOOKS)[OutboxKind]>;
  const hookSpy = vi.fn<(row: EndedRow) => Promise<void>>(async () => {});

  // The injected clock: sleep advances it, so the budget sees the waits it asked for.
  let clock = 0;
  const sleeps: number[] = [];
  const fakeClock = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    nowMs: () => clock,
  };
  const tick = (ids: readonly string[], extra: Partial<RunOutboxTickOptions> = {}): Promise<OutboxTickReport> =>
    runOutboxTick({ onlyIds: ids, ...fakeClock, ...extra });

  async function queue(over: Partial<OutboxMessage> = {}): Promise<string> {
    const id = await enqueueEmail(sql, msg(over));
    created.push(id);
    return id;
  }
  const get = async (id: string): Promise<Row> => {
    const [r] = await sql<Row[]>`select * from email_outbox where id = ${id}`;
    if (!r) throw new Error(`no outbox row ${id}`);
    return r;
  };
  /** Due now, as a retry row is once its delay has passed. */
  const makeDue = async (id: string, secondsAgo = 1): Promise<void> => {
    await sql`update email_outbox set next_attempt_at = now() - make_interval(secs => ${secondsAgo}) where id = ${id}`;
  };
  /** A row a crashed worker left `sending`, its lease lapsed, having made `attempts` attempts. */
  const strand = async (id: string, attempts: number): Promise<void> => {
    await sql`
      update email_outbox
         set status = 'sending', attempts = ${attempts}, lease_until = now() - interval '1 second', status_at = now()
       where id = ${id} and status = 'queued'`;
  };
  const lapse = async (id: string): Promise<void> => {
    await sql`update email_outbox set lease_until = now() - interval '1 second' where id = ${id} and status = 'sending'`;
  };
  /** A row whose last status change was long ago, so a tick that moves it must move `status_at` too. */
  const age = async (...ids: string[]): Promise<void> => {
    await sql`update email_outbox set status_at = now() - interval '1 hour' where id = any(${ids}::uuid[])`;
  };
  /** Did a status change just now? (`status_at` is what phase 2 reads as "when".) */
  const movedJustNow = (r: Row): boolean => Date.now() - r.status_at.getTime() < 60_000;
  const expireNow = async (id: string): Promise<void> => {
    await sql`update email_outbox set expires_at = now() - interval '1 second' where id = ${id}`;
  };
  /** What a worker's claim does, by hand: sending, attempts + 1, a lease. Returns the row as `attemptClaimed` takes it. */
  async function claimByHand(id: string): Promise<ClaimedRow> {
    const [rec] = await sql<ClaimedRecord[]>`
      update email_outbox
         set status = 'sending', attempts = attempts + 1, lease_until = now() + interval '2 minutes', status_at = now()
       where id = ${id} and status = 'queued'
      returning id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional,
                attempts, expires_at, lease_until`;
    if (!rec) throw new Error(`could not claim ${id} (not queued)`);
    return toClaimedRow(rec);
  }
  const sent = () => deliverMock.mock.calls.map((c) => c[0] as Sent);

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    if (suppressed.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressed)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("LICHESS_TOKEN_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    clock = 0;
    sleeps.length = 0;
    logMock.error.mockClear();
    logMock.warn.mockClear();
    logMock.info.mockClear();
    deliverMock.mockReset();
    deliverMock.mockImplementation(async (m: Sent) => ({ ok: true, providerId: pid(idOf(m)) }));
    hookSpy.mockClear();
    for (const k of OUTBOX_KINDS) savedHooks[k] = KIND_HOOKS[k];
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = { onEndedBadly: hookSpy };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = savedHooks[k];
  });

  // ---- the sequences --------------------------------------------------------------------------------------------------

  describe("sequences", () => {
    it("retry then success: a 500 on dispatch, then a tick sends it - attempts 2, the SAME idempotency key both times, one provider message", async () => {
      const id = await queue();
      const provider = makeProvider();
      let n = 0;
      deliverMock.mockImplementation(async (m: Sent) => (n++ === 0 ? http(500, "internal_server_error") : provider.accept(m.idempotencyKey)));

      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      const retrying = await get(id);
      expect([retrying.status, retrying.attempts]).toEqual(["queued", 1]);

      // Not due yet (the schedule's first delay): the tick leaves it alone, and says so with zeros.
      expect(await tick([id])).toEqual(ZERO);
      expect(deliverMock).toHaveBeenCalledTimes(1);

      await makeDue(id);
      expect(await tick([id])).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      const done = await get(id);
      expect([done.status, done.attempts, done.body_sealed, done.lease_until]).toEqual(["sent", 2, null, null]);
      expect(done.provider_id).toBe(provider.messages.get(idempotencyKey(id)));
      expect(sent().map((m) => m.idempotencyKey)).toEqual([idempotencyKey(id), idempotencyKey(id)]);
      expect(sent().map((m) => idOf(m))).toEqual([id, id]);
      expect(provider.messages.size, "one email however many requests").toBe(1);
      expect(hookSpy).not.toHaveBeenCalled(); // a sent row never releases anything
    });

    it("MAX_ATTEMPTS retryable failures end dead: deliver is called exactly MAX_ATTEMPTS times across dispatch + ticks, then never again", async () => {
      const id = await queue();
      deliverMock.mockResolvedValue(http(500, "internal_server_error"));
      await dispatchNow([id]); // attempt 1
      const reports: OutboxTickReport[] = [];
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        // The row waits out its delay in `queued` between attempts (the pair: it is queued, not dead, until the last).
        expect((await get(id)).status, `before attempt ${attempt}`).toBe("queued");
        await makeDue(id);
        reports.push(await tick([id]));
      }
      expect(deliverMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(reports.length, "ticks run").toBe(MAX_ATTEMPTS - 1);
      expect(reports.slice(0, -1).every((r) => r.claimed === 1 && r.retried === 1 && r.dead === 0)).toBe(true);
      expect(reports.at(-1)).toEqual({ ...ZERO, claimed: 1, dead: 1 });
      const dead = await get(id);
      expect([dead.status, dead.attempts, dead.body_sealed, dead.lease_until, dead.last_error]).toEqual([
        "dead",
        MAX_ATTEMPTS,
        null,
        null,
        "http 500 internal_server_error",
      ]);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id, status: "dead" });
      // After the end: nothing is due, nothing is sent.
      await makeDue(id);
      expect(await tick([id])).toEqual(ZERO);
      expect(deliverMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    it("a stale lease is reclaimed under attempts + 1; a live lease is left alone", async () => {
      const id = await queue();
      await claimByHand(id); // a worker that took it and died: sending, attempts 1, lease 2 minutes ahead
      expect(await tick([id]), "lease still running").toEqual(ZERO);
      expect(deliverMock).not.toHaveBeenCalled();
      expect((await get(id)).attempts).toBe(1);

      await lapse(id);
      expect(await tick([id])).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      const r = await get(id);
      expect([r.status, r.attempts]).toEqual(["sent", 2]);
    });

    it("the attempt ceiling: a lapsed lease at MAX_ATTEMPTS - 1 is reclaimed (the last attempt), at MAX_ATTEMPTS it goes dead 'attempts_exhausted' unsent", async () => {
      const last = await queue({ meta: { stamp: "s-last" } });
      const spent = await queue({ meta: { stamp: "s-spent" } });
      await strand(last, MAX_ATTEMPTS - 1);
      await strand(spent, MAX_ATTEMPTS);
      await age(spent);
      const report = await tick([last, spent]);
      expect(report).toEqual({ ...ZERO, claimed: 1, sent: 1, dead: 1 });

      expect(sent().map(idOf), "only the row with an attempt left was sent").toEqual([last]);
      const a = await get(last);
      expect([a.status, a.attempts]).toEqual(["sent", MAX_ATTEMPTS]);
      const b = await get(spent);
      expect([b.status, b.attempts, b.body_sealed, b.lease_until, b.last_error]).toEqual(["dead", MAX_ATTEMPTS, null, null, "attempts_exhausted"]);
      expect(movedJustNow(b), "ending it moves status_at").toBe(true);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id: spent, status: "dead", meta: { stamp: "s-spent" } });
    });

    it("a row whose attempt is IN FLIGHT (live lease) is never expired or ended dead by a tick, even past its time or at the attempt ceiling", async () => {
      const lastAttempt = await queue();
      const pastTime = await queue();
      await sql`
        update email_outbox
           set status = 'sending', attempts = ${MAX_ATTEMPTS}, lease_until = now() + interval '1 minute'
         where id = ${lastAttempt}`;
      await sql`
        update email_outbox
           set status = 'sending', attempts = 1, lease_until = now() + interval '1 minute', expires_at = now() - interval '1 second'
         where id = ${pastTime}`;
      expect(await tick([lastAttempt, pastTime])).toEqual(ZERO);
      expect(deliverMock).not.toHaveBeenCalled();
      expect(hookSpy).not.toHaveBeenCalled();
      const rows = await Promise.all([lastAttempt, pastTime].map(get));
      expect(rows.map((r) => [r.status, r.body_sealed === null])).toEqual([["sending", false], ["sending", false]]);
      // The pair: once those leases lapse, both are ended (the control that the rows were reachable).
      await lapse(lastAttempt);
      await lapse(pastTime);
      expect(await tick([lastAttempt, pastTime])).toEqual({ ...ZERO, dead: 1, expired: 1 });
    });

    it("a row that has spent every attempt is never claimed again, even one left `queued` (it can only be ended by its expiry)", async () => {
      const id = await queue();
      await sql`update email_outbox set attempts = ${MAX_ATTEMPTS} where id = ${id}`;
      await makeDue(id);
      expect(await tick([id])).toEqual(ZERO);
      expect(deliverMock).not.toHaveBeenCalled();
      const r = await get(id);
      expect([r.status, r.attempts]).toEqual(["queued", MAX_ATTEMPTS]);
    });

    it("a row past expires_at is expired by the tick and never delivered, body gone, and the hook runs", async () => {
      const id = await queue({ meta: { stamp: "s-exp" }, refType: "fixture_seat", refId: `${RUN}-seat-exp`, kind: "chess_invite" });
      const live = await queue();
      await expireNow(id);
      await age(id);
      const report = await tick([id, live]);
      expect(report).toEqual({ ...ZERO, claimed: 1, sent: 1, expired: 1 });
      expect(sent().map(idOf), "the expired row was never sent").toEqual([live]);
      const r = await get(id);
      expect([r.status, r.body_sealed, r.lease_until]).toEqual(["expired", null, null]);
      expect(movedJustNow(r), "the expiry moves status_at").toBe(true);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toEqual({
        id,
        kind: "chess_invite",
        refType: "fixture_seat",
        refId: `${RUN}-seat-exp`,
        status: "expired",
        meta: { stamp: "s-exp" },
      });
    });

    it("a row stranded `sending` and past expires_at is expired, not reclaimed and re-sent", async () => {
      const id = await queue();
      await strand(id, 1);
      await expireNow(id);
      expect(await tick([id])).toEqual({ ...ZERO, expired: 1 });
      expect(deliverMock).not.toHaveBeenCalled();
      expect((await get(id)).status).toBe("expired");
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });

    it("a row that expires DURING the tick is not claimed: the claim reads expires_at on the clock of the claim", async () => {
      const first = await queue();
      const second = await queue({ expiresAt: new Date(Date.now() + 700) });
      await makeDue(first, 10);
      await makeDue(second, 5);
      deliverMock.mockImplementationOnce(async (m: Sent) => {
        await new Promise((r) => setTimeout(r, 1_000)); // the first send takes longer than the second row has left
        return { ok: true, providerId: pid(idOf(m)) };
      });
      const report = await tick([first, second]);
      expect(sent().map(idOf), "the second row was never sent").toEqual([first]);
      expect(report.sent).toBe(1);
      expect(report.claimed, "and never even claimed").toBe(1);
      expect((await get(second)).attempts).toBe(0);
    });
  });

  // ---- R9: a 2xx whose write failed ----------------------------------------------------------------------------------

  describe("R9: a Resend 2xx, then a database write failure, then the lease lapses", () => {
    /** Make the post-send UPDATE throw: another row already holds this provider id (the column is unique). */
    async function holdProviderId(providerId: string): Promise<string> {
      const holder = await queue();
      await sql`update email_outbox set provider_id = ${providerId} where id = ${holder}`;
      return holder;
    }

    it("dispatch: the row stays sending, the worker leaves it while the lease runs, then reclaims it and re-sends under the SAME key: one provider message", async () => {
      const id = await queue();
      const provider = makeProvider();
      const P = pid("collide");
      const holder = await holdProviderId(P);
      let accepted = 0;
      deliverMock.mockImplementation(async (m: Sent) => {
        provider.accept(m.idempotencyKey);
        accepted++;
        return { ok: true, providerId: P }; // the provider DID accept; the write of its id is what collides
      });

      expect((await dispatchNow([id])).get(id)).toBe("deferred");
      const stuck = await get(id);
      expect([stuck.status, stuck.attempts, stuck.provider_id]).toEqual(["sending", 1, null]);
      expect(stuck.lease_until).not.toBeNull();
      expect(provider.requests).toEqual([idempotencyKey(id)]);

      expect(await tick([id]), "the lease has not lapsed: not ours to take").toEqual(ZERO);
      expect(accepted).toBe(1);

      await sql`update email_outbox set provider_id = null where id = ${holder}`; // the fault clears
      await lapse(id);
      expect(await tick([id])).toEqual({ ...ZERO, claimed: 1, sent: 1 });

      expect(provider.requests).toEqual([idempotencyKey(id), idempotencyKey(id)]);
      expect(provider.messages.size, "one email however many times the key was sent").toBe(1);
      const done = await get(id);
      expect([done.status, done.attempts, done.provider_id, done.body_sealed, done.lease_until]).toEqual(["sent", 2, P, null, null]);
    });

    it("the worker itself: a tick whose write fails reports failed 1 and moves on to the next row; the next lapsed tick finishes it", async () => {
      const bad = await queue();
      const good = await queue();
      await makeDue(bad, 10);
      await makeDue(good, 5);
      const provider = makeProvider();
      const P = pid("collide-w");
      const holder = await holdProviderId(P);
      deliverMock.mockImplementation(async (m: Sent) => {
        provider.accept(m.idempotencyKey);
        return idOf(m) === bad ? { ok: true, providerId: P } : { ok: true, providerId: pid(idOf(m)) };
      });

      expect(await tick([bad, good])).toEqual({ ...ZERO, claimed: 2, sent: 1, failed: 1 });
      expect((await get(good)).status, "the tick moved on").toBe("sent");
      const stuck = await get(bad);
      expect([stuck.status, stuck.attempts]).toEqual(["sending", 1]);
      expect(logMock.error).toHaveBeenCalled();
      expect(JSON.stringify(logMock.error.mock.calls), "no body or address in the log").not.toContain("@x.test");

      await sql`update email_outbox set provider_id = null where id = ${holder}`;
      await lapse(bad);
      expect(await tick([bad])).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(provider.requests.filter((k) => k === idempotencyKey(bad))).toHaveLength(2);
      expect(provider.messages.size, "two rows, two messages").toBe(2);
      expect((await get(bad)).provider_id).toBe(P);
    });
  });

  // ---- bounds -----------------------------------------------------------------------------------------------------------

  describe("bounds", () => {
    it("claims at most WORKER_BATCH_SIZE per tick, paces with MIN_SEND_INTERVAL_MS (waits = claimed - 1), and counts the rest as deferred", async () => {
      const extra = 3;
      const ids: string[] = [];
      for (let i = 0; i < WORKER_BATCH_SIZE + extra; i++) ids.push(await queue());

      const first = await tick(ids);
      expect(first).toEqual({ ...ZERO, claimed: WORKER_BATCH_SIZE, sent: WORKER_BATCH_SIZE, deferred: extra });
      expect(deliverMock).toHaveBeenCalledTimes(WORKER_BATCH_SIZE);
      expect(sleeps).toEqual(Array(WORKER_BATCH_SIZE - 1).fill(MIN_SEND_INTERVAL_MS));
      const left = await Promise.all(ids.map(get));
      expect(left.filter((r) => r.status === "queued" && r.attempts === 0), "rows left untouched").toHaveLength(extra);

      sleeps.length = 0;
      expect(await tick(ids)).toEqual({ ...ZERO, claimed: extra, sent: extra });
      expect(sleeps).toEqual(Array(extra - 1).fill(MIN_SEND_INTERVAL_MS));
      expect((await Promise.all(ids.map(get))).every((r) => r.status === "sent")).toBe(true);
    });

    it("the wait is the REMAINDER of the interval: an attempt that took 300 ms waits MIN - 300, one that took the whole interval waits none", async () => {
      const slow = [await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += 300;
        return { ok: true, providerId: pid(idOf(m)) };
      });
      expect(await tick(slow)).toMatchObject({ claimed: 3, sent: 3 });
      expect(sleeps).toEqual([MIN_SEND_INTERVAL_MS - 300, MIN_SEND_INTERVAL_MS - 300]);

      sleeps.length = 0;
      const slower = [await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += MIN_SEND_INTERVAL_MS;
        return { ok: true, providerId: pid(idOf(m)) };
      });
      expect(await tick(slower)).toMatchObject({ claimed: 3, sent: 3 });
      expect(sleeps, "no wait owed").toEqual([]);
    });

    it("stops claiming once the budget is spent (exactly AT it) and counts the rows still due as deferred", async () => {
      const deliverMs = 2 * MIN_SEND_INTERVAL_MS; // slower than the interval, so no wait is owed and the arithmetic is bare
      const ids = [await queue(), await queue(), await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += deliverMs;
        return { ok: true, providerId: pid(idOf(m)) };
      });
      // Two attempts take exactly the SEND share of the budget, so the third claim would start AT it: spent when reached.
      const report = await tick(ids, { budgetMs: budgetFor(2 * deliverMs) });
      expect(report).toEqual({ ...ZERO, claimed: 2, sent: 2, deferred: 3 });
      expect(deliverMock).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([]);
      expect(await tick(ids), "the next tick, with the default budget, takes the rest").toEqual({ ...ZERO, claimed: 3, sent: 3 });
    });

    it("the pacing waits count against the budget", async () => {
      const deliverMs = MIN_SEND_INTERVAL_MS / 5;
      const ids = [await queue(), await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += deliverMs;
        return { ok: true, providerId: pid(idOf(m)) };
      });
      // Attempt 1 takes deliverMs, the wait before attempt 2 takes the rest of the interval, attempt 2 takes deliverMs
      // again: that is MIN + deliverMs when the third claim comes up, which is the budget.
      const report = await tick(ids, { budgetMs: budgetFor(MIN_SEND_INTERVAL_MS + deliverMs) });
      expect(report).toEqual({ ...ZERO, claimed: 2, sent: 2, deferred: 2 });
      expect(sleeps).toEqual([MIN_SEND_INTERVAL_MS - deliverMs]);
    });

    it("the default budget is TICK_BUDGET_MS", async () => {
      const ids = [await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += TICK_BUDGET_MS; // the first attempt alone spends the whole budget
        return { ok: true, providerId: pid(idOf(m)) };
      });
      expect(await tick(ids)).toEqual({ ...ZERO, claimed: 1, sent: 1, deferred: 2 });
    });

    it("the send loop stops at TICK_BUDGET_MS less the hook reserve, to the millisecond (default budget)", async () => {
      const sendBudget = TICK_BUDGET_MS - HOOK_RESERVE_MS;
      // AT the send share: one attempt, the second claim is refused.
      const atIds = [await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += sendBudget;
        return { ok: true, providerId: pid(idOf(m)) };
      });
      expect(await tick(atIds)).toEqual({ ...ZERO, claimed: 1, sent: 1, deferred: 2 });

      // One ms UNDER it: the second claim still starts (and then its own attempt spends the rest).
      deliverMock.mockReset();
      const underIds = [await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += sendBudget - 1;
        return { ok: true, providerId: pid(idOf(m)) };
      });
      expect(await tick(underIds)).toEqual({ ...ZERO, claimed: 2, sent: 2, deferred: 1 });
    });

    it("hook starvation: sends that would use the WHOLE budget still leave the hooks to run in the same tick", async () => {
      const HOOK_MS = 500;
      const DELIVER_MS = 1_000; // slower than the pacing interval, so no waits blur the arithmetic
      const BUDGET = 8 * DELIVER_MS;
      const due = [];
      for (let i = 0; i < 12; i++) due.push(await queue()); // far more than the budget can send
      const ending: string[] = [];
      for (let i = 0; i < 3; i++) ending.push(await queue({ kind: "chess_invite", refType: "fixture_seat" }));
      for (const id of ending) await expireNow(id);
      const ran: string[] = [];
      KIND_HOOKS.chess_invite = {
        onEndedBadly: async (row) => {
          clock += HOOK_MS;
          ran.push(row.id);
        },
      };
      deliverMock.mockImplementation(async (m: Sent) => {
        clock += DELIVER_MS;
        return { ok: true, providerId: pid(idOf(m)) };
      });

      const sendShare = BUDGET * (1 - HOOK_RESERVE_FRACTION);
      const wouldSend = Math.ceil(sendShare / DELIVER_MS); // claims start while elapsed < the send share
      const report = await tick([...due, ...ending], { budgetMs: BUDGET });
      expect(wouldSend, "anti-vacuity: the sends really are capped below what the whole budget would allow").toBeLessThan(BUDGET / DELIVER_MS);
      expect(report).toEqual({ ...ZERO, claimed: wouldSend, sent: wouldSend, expired: ending.length, deferred: due.length - wouldSend });
      expect(ran.sort(), "every hook ran in the SAME tick").toEqual([...ending].sort());
      expect(logMock.warn, "none was skipped").not.toHaveBeenCalled();
      expect(clock, "and the tick stayed inside its budget").toBeLessThanOrEqual(BUDGET);
    });

    it("stops at the first 429: nothing else is claimed, the rest stay queued untouched and count in deferred", async () => {
      const ids = [await queue(), await queue(), await queue()];
      deliverMock.mockResolvedValue(http(429, "rate_limit_exceeded"));
      expect(await tick(ids)).toEqual({ ...ZERO, claimed: 1, retried: 1, deferred: 2 });
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(sleeps, "no pacing wait owed once it stopped").toEqual([]);
      const rows = await Promise.all(ids.map(get));
      expect(rows.map((r) => [r.status, r.attempts])).toEqual([["queued", 1], ["queued", 0], ["queued", 0]]);
      // The rate-limited row is NOT due again (its delay is in the future), so it is not counted in `deferred` above.
      expect(rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    });

    it("the pair: a 500 does not stop the tick (only a 429 does) - all three rows are tried", async () => {
      const ids = [await queue(), await queue(), await queue()];
      deliverMock.mockResolvedValue(http(500, "internal_server_error"));
      expect(await tick(ids)).toEqual({ ...ZERO, claimed: 3, retried: 3 });
      expect(deliverMock).toHaveBeenCalledTimes(3);
    });

    it("an unreadable body goes dead and the tick moves on to the next row", async () => {
      const broken = await queue({ meta: { stamp: "s-broken" } });
      const fine = await queue();
      await makeDue(broken, 10);
      await makeDue(fine, 5);
      await sql`update email_outbox set body_sealed = ${Buffer.from("not-a-sealed-envelope")} where id = ${broken}`;
      expect(await tick([broken, fine])).toEqual({ ...ZERO, claimed: 2, dead: 1, sent: 1 });
      const r = await get(broken);
      expect([r.status, r.last_error, r.body_sealed]).toEqual(["dead", "body_unreadable", null]);
      expect(sent().map(idOf), "the unreadable row never reached the transport").toEqual([fine]);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id: broken, status: "dead", meta: { stamp: "s-broken" } });
    });

    it("an empty scope: every count 0, deliver never called, no hook, no wait, nothing logged", async () => {
      for (const ids of [[randomUUID()], []]) {
        expect(await tick(ids), JSON.stringify(ids.length)).toEqual(ZERO);
      }
      expect(deliverMock).not.toHaveBeenCalled();
      expect(hookSpy).not.toHaveBeenCalled();
      expect(sleeps).toEqual([]);
      expect(logMock.error).not.toHaveBeenCalled();
    });

    it("the report always carries exactly the eight counters, all whole numbers", async () => {
      const report = await tick([randomUUID()]);
      expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
      expect(REPORT_KEYS.length).toBe(8);
      for (const [k, v] of Object.entries(report)) expect(Number.isInteger(v), k).toBe(true);
    });

    it("with the real default sleep, two rows are sent at least MIN_SEND_INTERVAL_MS apart", async () => {
      const ids = [await queue(), await queue()];
      const stamps: number[] = [];
      deliverMock.mockImplementation(async (m: Sent) => {
        stamps.push(performance.now());
        return { ok: true, providerId: pid(idOf(m)) };
      });
      const report = await runOutboxTick({ onlyIds: ids }); // no injected clock or sleep
      expect(report).toEqual({ ...ZERO, claimed: 2, sent: 2 });
      expect(stamps).toHaveLength(2);
      expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(MIN_SEND_INTERVAL_MS - 25);
    });
  });

  // ---- the claim --------------------------------------------------------------------------------------------------------

  describe("the claim", () => {
    it("takes the oldest due row first, ties broken by id, and never a row whose next_attempt_at is still ahead", async () => {
      const a = await queue();
      const b = await queue();
      const c = await queue();
      const future = await queue();
      await makeDue(a, 180);
      await makeDue(c, 120);
      await makeDue(b, 60);
      await sql`update email_outbox set next_attempt_at = now() + interval '10 minutes' where id = ${future}`;
      // Rows due at the very same instant: the lower id goes first. Random uuids make heap (insertion) order differ from id
      // order with probability 1 - 1/8!, so a claim with no id tiebreak cannot pass this by luck.
      const TIED = 8;
      const tied: string[] = [];
      for (let i = 0; i < TIED; i++) tied.push(await queue());
      const same = new Date(Date.now() - 30_000);
      await sql`update email_outbox set next_attempt_at = ${same} where id = any(${tied}::uuid[])`;

      const report = await tick([a, b, c, future, ...tied]);
      expect(report).toEqual({ ...ZERO, claimed: 3 + TIED, sent: 3 + TIED });
      expect(sent().map(idOf)).toEqual([a, c, b, ...[...tied].sort()]);
      expect(tied.length, "the tie group is the size the odds assume").toBe(TIED);
      expect((await get(future)).attempts, "a row ahead of its time is not taken").toBe(0);
    });

    it("R10: the claiming statement itself sets sending, attempts + 1 and a lease of LEASE_MS, with the body still held", async () => {
      const id = await queue();
      const seen: Row[] = [];
      deliverMock.mockImplementation(async (m: Sent) => {
        seen.push(await get(idOf(m)));
        return { ok: true, providerId: pid(idOf(m)) };
      });
      await age(id);
      const before = Date.now();
      await tick([id]);
      expect(seen).toHaveLength(1);
      const mid = seen[0]!;
      expect([mid.status, mid.attempts]).toEqual(["sending", 1]);
      expect(mid.body_sealed).not.toBeNull();
      expect(movedJustNow(mid), "the claim moves status_at").toBe(true);
      expect(Math.abs(mid.lease_until!.getTime() - (before + LEASE_MS))).toBeLessThan(10_000);

      // The same on a RETRY: attempts 1 -> 2 in the claim.
      const retry = await queue();
      deliverMock.mockResolvedValueOnce(http(500, "internal_server_error"));
      await dispatchNow([retry]);
      await makeDue(retry);
      seen.length = 0;
      deliverMock.mockImplementation(async (m: Sent) => {
        seen.push(await get(idOf(m)));
        return { ok: true, providerId: pid(idOf(m)) };
      });
      await tick([retry]);
      expect([seen[0]!.status, seen[0]!.attempts]).toEqual(["sending", 2]);
    });

    it("two ticks in parallel never deliver one row twice, and between them take every row once", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await queue());
      deliverMock.mockImplementation(async (m: Sent) => {
        await new Promise((r) => setTimeout(r, 25)); // long enough for the two ticks to interleave
        return { ok: true, providerId: pid(idOf(m)) };
      });
      const [a, b] = await Promise.all([tick(ids), tick(ids)]);
      expect(sent().map(idOf).sort(), "each row delivered exactly once").toEqual([...ids].sort());
      expect(a.claimed + b.claimed).toBe(ids.length);
      expect(a.sent + b.sent).toBe(ids.length);
      expect(Math.min(a.claimed, b.claimed), "both ticks really took part").toBeGreaterThanOrEqual(1);
      expect((await Promise.all(ids.map(get))).every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    });

    it("skip locked: a row another transaction holds is passed over, not waited for", async () => {
      const held = await queue();
      const free = await queue();
      await makeDue(held, 10);
      await makeDue(free, 5);
      await sql.begin(async (tx) => {
        await tx`select id from email_outbox where id = ${held} for update`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const blocked = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the tick blocked on a row another transaction holds")), 4_000);
        });
        try {
          const report = await Promise.race([tick([held, free]), blocked]);
          expect(report).toEqual({ ...ZERO, claimed: 1, sent: 1 });
        } finally {
          clearTimeout(timer);
        }
      });
      expect(sent().map(idOf)).toEqual([free]);
      expect((await get(held)).attempts, "the held row was left for later").toBe(0);
      // Released: the next tick takes it.
      expect(await tick([held])).toEqual({ ...ZERO, claimed: 1, sent: 1 });
    });

    it("touches nothing outside the ids it was scoped to (a due, an expired and an exhausted row all stay as they were)", async () => {
      const due = await queue();
      const expired = await queue();
      const spent = await queue();
      await expireNow(expired);
      await strand(spent, MAX_ATTEMPTS);
      const before = await Promise.all([due, expired, spent].map(get));

      const mine = await queue();
      expect(await tick([mine])).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      const after = await Promise.all([due, expired, spent].map(get));
      expect(after.map((r) => [r.status, r.attempts, r.last_error])).toEqual(before.map((r) => [r.status, r.attempts, r.last_error]));
      expect(sent().map(idOf)).toEqual([mine]);
      expect(hookSpy).not.toHaveBeenCalled();

      // The control: scoped to them, the same tick acts on all three.
      expect(await tick([due, expired, spent])).toEqual({ ...ZERO, claimed: 1, sent: 1, expired: 1, dead: 1 });
    });
  });

  // ---- the report's other outcomes ---------------------------------------------------------------------------------------

  describe("every outcome lands in its own counter", () => {
    it("one tick with a sent, a retried, a dead, a suppressed, a thrown and a replaced-mid-flight row: each counted once, and claimed is the sum", async () => {
      const mk = async (label: string, over: Partial<OutboxMessage> = {}) => {
        const to = `${label}-${randomUUID()}@x.test`;
        const id = await queue({ to, ...over });
        return { id, to };
      };
      const ok = await mk("ok");
      const retry = await mk("retry");
      const dead = await mk("dead");
      const sup = await mk("sup", { transactional: false });
      const boom = await mk("boom");
      const repl = await mk("repl", { refType: "login", refId: `${RUN}-repl-${randomUUID()}` });
      const rows = [ok, retry, dead, sup, boom, repl];
      for (const [i, r] of rows.entries()) await makeDue(r.id, 100 - i); // table order = processing order
      await suppress(sup.to, "manual");
      suppressed.push(sup.to);
      const P = pid("collide-mixed");
      const holder = await queue();
      await sql`update email_outbox set provider_id = ${P} where id = ${holder}`;

      deliverMock.mockImplementation(async (m: Sent) => {
        const id = idOf(m);
        if (id === retry.id) return http(500, "internal_server_error");
        if (id === dead.id) return http(422, "validation_error");
        if (id === boom.id) return { ok: true, providerId: P };
        if (id === repl.id) {
          // A newer row for the same kind + ref + recipient arrives while this attempt is in flight.
          const [cur] = await sql<{ ref_id: string }[]>`select ref_id from email_outbox where id = ${repl.id}`;
          created.push(await enqueueEmail(sql, msg({ to: repl.to, refType: "login", refId: cur!.ref_id })));
        }
        return { ok: true, providerId: pid(id) };
      });

      const report = await tick(rows.map((r) => r.id));
      expect(report).toEqual({ ...ZERO, claimed: 6, sent: 1, retried: 1, dead: 1, suppressed: 1, failed: 1 });
      const status = async (r: { id: string }) => (await get(r.id)).status;
      expect(await Promise.all(rows.map(status))).toEqual(["sent", "queued", "dead", "suppressed", "sending", "replaced"]);
      // The fenced row (replaced in flight) is claimed but in no outcome counter: claimed - the five counters = 1.
      const counted = report.sent + report.retried + report.dead + report.suppressed + report.expired + report.failed;
      expect(report.claimed - counted).toBe(1);
      expect(deliverMock, "the suppressed row never reached the transport").toHaveBeenCalledTimes(5);
      // Hooks: dead and suppressed ended badly; nothing else did (the replaced row is not an ending).
      expect(hookSpy.mock.calls.map((c) => [c[0].id, c[0].status]).sort()).toEqual(
        [[dead.id, "dead"], [sup.id, "suppressed"]].sort(),
      );
    });

    it("failed counts a row whose attempt threw, and an unrelated row in the same tick is still attempted afterwards", async () => {
      const bad = await queue();
      const good = await queue();
      await makeDue(bad, 10);
      await makeDue(good, 5);
      const P = pid("collide-throw");
      const holder = await queue();
      await sql`update email_outbox set provider_id = ${P} where id = ${holder}`;
      deliverMock.mockImplementation(async (m: Sent) => ({ ok: true, providerId: idOf(m) === bad ? P : pid(idOf(m)) }));
      const report = await tick([bad, good]);
      expect(report.failed).toBe(1);
      expect(report.sent).toBe(1);
      expect(sent().map(idOf)).toEqual([bad, good]);
    });
  });

  // ---- hooks ------------------------------------------------------------------------------------------------------------

  describe("M2 (Task 4 review): the two ending statements are bounded", () => {
    const LATE = 3;
    const ended = (ids: string[]) => sql<{ id: string; status: string }[]>`select id, status from email_outbox where id = any(${ids}::uuid[])`;

    it("expiry: at most ENDING_BATCH_SIZE rows a tick, the longest-expired first; the rest drain on later ticks and every hook runs once", async () => {
      // The LATE rows are created first, so heap order would favour them: only an ORDER BY on expires_at leaves them for last.
      const late: string[] = [];
      for (let i = 0; i < LATE; i++) late.push(await queue());
      const early: string[] = [];
      for (let i = 0; i < ENDING_BATCH_SIZE; i++) early.push(await queue());
      await sql`update email_outbox set expires_at = now() - interval '1 minute' where id = any(${late}::uuid[])`;
      await sql`update email_outbox set expires_at = now() - interval '1 hour' where id = any(${early}::uuid[])`;
      const all = [...late, ...early];

      expect(await tick(all)).toEqual({ ...ZERO, expired: ENDING_BATCH_SIZE });
      expect(hookSpy).toHaveBeenCalledTimes(ENDING_BATCH_SIZE);
      expect((await ended(late)).map((r) => r.status), "the latest-expired rows wait").toEqual(Array(LATE).fill("queued"));
      expect((await ended(early)).every((r) => r.status === "expired")).toBe(true);

      expect(await tick(all)).toEqual({ ...ZERO, expired: LATE });
      expect(hookSpy).toHaveBeenCalledTimes(ENDING_BATCH_SIZE + LATE);
      expect(await tick(all), "drained").toEqual(ZERO);
      expect(new Set(hookSpy.mock.calls.map((c) => (c[0] as EndedRow).id)).size, "each row's hook ran once").toBe(all.length);
    });

    it("exhaustion: the same bound and order on the dead statement (the longest-lapsed lease first)", async () => {
      const late: string[] = [];
      for (let i = 0; i < LATE; i++) late.push(await queue());
      const early: string[] = [];
      for (let i = 0; i < ENDING_BATCH_SIZE; i++) early.push(await queue());
      for (const id of [...late, ...early]) await strand(id, MAX_ATTEMPTS);
      await sql`update email_outbox set lease_until = now() - interval '1 minute' where id = any(${late}::uuid[])`;
      await sql`update email_outbox set lease_until = now() - interval '1 hour' where id = any(${early}::uuid[])`;
      const all = [...late, ...early];

      expect(await tick(all)).toEqual({ ...ZERO, dead: ENDING_BATCH_SIZE });
      expect(hookSpy).toHaveBeenCalledTimes(ENDING_BATCH_SIZE);
      expect((await ended(late)).map((r) => r.status)).toEqual(Array(LATE).fill("sending"));
      expect(await tick(all)).toEqual({ ...ZERO, dead: LATE });
      expect(await tick(all), "drained").toEqual(ZERO);
      expect(hookSpy).toHaveBeenCalledTimes(ENDING_BATCH_SIZE + LATE);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where id = any(${all}::uuid[]) and last_error = 'attempts_exhausted'`;
      expect(n).toBe(all.length);
    });

    it("skip locked: a row another transaction holds is passed over by BOTH ending statements, not waited for", async () => {
      const heldExpiring = await queue();
      const heldExhausted = await queue();
      const freeExpiring = await queue();
      const freeExhausted = await queue();
      await sql`update email_outbox set expires_at = now() - interval '1 second' where id in (${heldExpiring}, ${freeExpiring})`;
      for (const id of [heldExhausted, freeExhausted]) await strand(id, MAX_ATTEMPTS);
      const all = [heldExpiring, heldExhausted, freeExpiring, freeExhausted];
      await sql.begin(async (tx) => {
        await tx`select id from email_outbox where id in (${heldExpiring}, ${heldExhausted}) for update`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const blocked = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the tick blocked on a row another transaction holds")), 4_000);
        });
        try {
          expect(await Promise.race([tick(all), blocked])).toEqual({ ...ZERO, expired: 1, dead: 1 });
        } finally {
          clearTimeout(timer);
        }
      });
      expect((await get(heldExpiring)).status, "the held expiring row was left for later").toBe("queued");
      expect((await get(heldExhausted)).status, "the held exhausted row was left for later").toBe("sending");
      expect(await tick(all), "released: the next tick ends both").toEqual({ ...ZERO, expired: 1, dead: 1 });
    });

    it("the two statements have a bound each: ENDING_BATCH_SIZE + 1 expired and as many dead in one tick end ENDING_BATCH_SIZE of each", async () => {
      const expiring: string[] = [];
      const exhausted: string[] = [];
      for (let i = 0; i <= ENDING_BATCH_SIZE; i++) {
        expiring.push(await queue());
        exhausted.push(await queue());
      }
      await sql`update email_outbox set expires_at = now() - interval '1 second' where id = any(${expiring}::uuid[])`;
      for (const id of exhausted) await strand(id, MAX_ATTEMPTS);
      const all = [...expiring, ...exhausted];
      expect(await tick(all)).toEqual({ ...ZERO, expired: ENDING_BATCH_SIZE, dead: ENDING_BATCH_SIZE });
      expect(await tick(all)).toEqual({ ...ZERO, expired: 1, dead: 1 });
      expect(await tick(all)).toEqual(ZERO);
    });
  });

  describe("hooks", () => {
    it("run for every row the tick ended - expired, exhausted and an attempt that went dead - once each, with the row's identity and meta", async () => {
      const mkSeat = (stamp: string) => ({ kind: "chess_invite" as const, refType: "fixture_seat", refId: `${RUN}-${stamp}`, meta: { stamp } });
      const exp = await queue(mkSeat("e"));
      const spent = await queue(mkSeat("x"));
      const bad = await queue(mkSeat("d"));
      const fine = await queue(mkSeat("f"));
      await expireNow(exp);
      await strand(spent, MAX_ATTEMPTS);
      await makeDue(bad, 10);
      await makeDue(fine, 5);
      deliverMock.mockImplementation(async (m: Sent) => (idOf(m) === bad ? http(400, "validation_error") : { ok: true, providerId: pid(idOf(m)) }));

      const report = await tick([exp, spent, bad, fine]);
      expect(report).toEqual({ ...ZERO, claimed: 2, dead: 2, sent: 1, expired: 1 });
      const calls = hookSpy.mock.calls.map((c) => c[0]);
      expect(calls.map((r) => [r.id, r.status]).sort()).toEqual([[exp, "expired"], [spent, "dead"], [bad, "dead"]].sort());
      for (const r of calls) {
        expect(r.kind).toBe("chess_invite");
        expect(r.refType).toBe("fixture_seat");
        expect(r.meta.stamp).toBe(r.refId.slice(`${RUN}-`.length));
      }
      expect(calls.some((r) => r.id === fine), "the sent row released nothing").toBe(false);
    });

    it("a hook that throws is logged and does not fail the tick or stop the other rows' hooks", async () => {
      const a = await queue();
      const b = await queue();
      await expireNow(a);
      await expireNow(b);
      hookSpy.mockImplementationOnce(async () => {
        throw new Error("hook blew up");
      });
      expect(await tick([a, b])).toEqual({ ...ZERO, expired: 2 });
      expect(hookSpy).toHaveBeenCalledTimes(2);
      expect(logMock.error).toHaveBeenCalled();
    });

    describe("R9 (M2): a badly-ended row whose effect was never applied is re-driven", () => {
      // Models a kind's finder: it recomputes from state (here, "the hook has not run for this row yet"), exactly the shape
      // the chess seat release has (a seat still stamped while every row for it has ended badly).
      const applied = new Set<string>();
      const mine: string[] = [];
      const finder = vi.fn(async (limit: number): Promise<EndedRow[]> => {
        if (mine.length === 0) return [];
        // The exclusion of applied rows is IN the query, before the limit, as a real finder's is: filtering afterwards
        // would let already-applied rows fill the limit and starve the rest.
        const rows = await sql<{ id: string; kind: OutboxKind; ref_type: string; ref_id: string; status: EndedRow["status"]; meta: Record<string, string> }[]>`
          select id, kind, ref_type, ref_id, status, meta from email_outbox
           where id = any(${mine}::uuid[]) and not (id = any(${[...applied]}::uuid[]))
             and status = any(${ENDED_BADLY_STATUSES as string[]}) and kind = 'chess_invite'
           order by status_at, id limit ${limit}`;
        return rows.map((r) => ({ id: r.id, kind: r.kind, refType: r.ref_type, refId: r.ref_id, status: r.status, meta: r.meta }));
      });

      beforeEach(() => {
        applied.clear();
        mine.length = 0;
        finder.mockClear();
        KIND_HOOKS.chess_invite = {
          onEndedBadly: async (row) => {
            hookSpy(row);
            applied.add(row.id);
          },
          findUnapplied: finder,
        };
      });

      const seat = (over: Partial<OutboxMessage> = {}) => queue({ kind: "chess_invite", refType: "fixture_seat", ...over });

      it("process death between the terminal write and the hook: the next tick runs the hook, once, and the tick after it does not", async () => {
        const id = await seat();
        mine.push(id);
        deliverMock.mockResolvedValue(http(400, "validation_error"));
        // The attempt writes `dead` ... and the process dies before afterEndedBadly: we call attemptClaimed and stop there.
        const row = await claimByHand(id);
        const result = await attemptClaimed(row);
        expect(result.outcome).toBe("dead");
        expect((await get(id)).status).toBe("dead");
        expect(hookSpy, "the hook never ran: the process 'died'").not.toHaveBeenCalled();

        const report = await tick([id]);
        expect(report).toEqual(ZERO); // nothing claimed, expired or ended by THIS tick ...
        expect(hookSpy, "... and the hook ran anyway").toHaveBeenCalledTimes(1);
        expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id, status: "dead", kind: "chess_invite" });

        await tick([id]);
        expect(hookSpy, "applied: never run again").toHaveBeenCalledTimes(1);
      });

      it("a hook that threw leaves its effect unapplied, so the next tick tries again and succeeds", async () => {
        const id = await seat();
        mine.push(id);
        await expireNow(id);
        let calls = 0;
        KIND_HOOKS.chess_invite = {
          onEndedBadly: async (row) => {
            calls++;
            if (calls === 1) throw new Error("db blip");
            applied.add(row.id);
            hookSpy(row);
          },
          findUnapplied: finder,
        };
        expect(await tick([id])).toEqual({ ...ZERO, expired: 1 });
        expect(calls, "tick 1: the expiry's hook ran and threw").toBe(1);
        expect(applied.size).toBe(0);

        await tick([id]);
        expect(calls, "tick 2: re-driven").toBe(2);
        expect(applied.has(id)).toBe(true);

        await tick([id]);
        expect(calls, "tick 3: applied, so quiet").toBe(2);
      });

      it("a row ended in THIS tick that the finder also reports is driven once, not twice", async () => {
        const id = await seat();
        mine.push(id);
        await expireNow(id);
        await tick([id]);
        expect(hookSpy).toHaveBeenCalledTimes(1);
      });

      it("asks the finder for REDRIVE_LIMIT rows on every tick, even a tick that found nothing else to do", async () => {
        await tick([randomUUID()]);
        await tick([randomUUID()]);
        expect(finder).toHaveBeenCalledTimes(2);
        expect(finder).toHaveBeenCalledWith(REDRIVE_LIMIT);
      });

      it("a backlog beyond the limit drains across ticks, REDRIVE_LIMIT at a time (no tick is unbounded)", async () => {
        const ids: string[] = [];
        for (let i = 0; i < REDRIVE_LIMIT + 2; i++) {
          const id = await seat();
          ids.push(id);
          mine.push(id);
          await sql`update email_outbox set status = 'dead', body_sealed = null, lease_until = null, status_at = now() where id = ${id}`;
        }
        await tick(ids);
        expect(applied.size).toBe(REDRIVE_LIMIT);
        await tick(ids);
        expect(applied.size).toBe(ids.length);
        expect(hookSpy).toHaveBeenCalledTimes(ids.length);
      });

      it("a finder that throws does not fail the tick or lose the tick's own work", async () => {
        const id = await queue();
        const live = await queue();
        await expireNow(id);
        KIND_HOOKS.chess_invite = {
          onEndedBadly: async () => {},
          findUnapplied: async () => {
            throw new Error("finder blew up");
          },
        };
        const report = await tick([id, live]);
        expect(report).toEqual({ ...ZERO, claimed: 1, sent: 1, expired: 1 });
        expect(logMock.error).toHaveBeenCalled();
      });

      it("M2: hooks count against the tick budget; the ones skipped are re-driven by the next tick, each hook exactly once", async () => {
        const HOOK_MS = 1_000;
        const N = 5;
        const SPENT_AFTER = 3;
        const ids: string[] = [];
        for (let i = 0; i < N; i++) {
          const id = await seat();
          ids.push(id);
          mine.push(id);
          await expireNow(id);
        }
        const ran: string[] = [];
        KIND_HOOKS.chess_invite = {
          onEndedBadly: async (row) => {
            clock += HOOK_MS; // a hook costs time on the tick's clock
            ran.push(row.id);
            applied.add(row.id);
          },
          findUnapplied: finder,
        };
        // The budget is spent after SPENT_AFTER hooks: the rows are ended (cheap, bounded) but only three hooks run.
        const report = await tick(ids, { budgetMs: SPENT_AFTER * HOOK_MS });
        expect(report).toEqual({ ...ZERO, expired: N });
        expect(ran, "hooks run until the budget is reached").toHaveLength(SPENT_AFTER);
        expect(finder, "budget spent: the re-drive is not even asked").not.toHaveBeenCalled();
        expect(logMock.warn, "the skipped hooks are said out loud, once").toHaveBeenCalledTimes(1);
        expect(logMock.warn.mock.calls[0]![0]).toMatchObject({ skippedHooks: N - SPENT_AFTER });

        // The next tick ends nothing new; the finder (the kind's own state) hands back the two unapplied rows.
        expect(await tick(ids, { budgetMs: SPENT_AFTER * HOOK_MS })).toEqual(ZERO);
        expect(finder).toHaveBeenCalledTimes(1);
        expect(ran).toHaveLength(N);
        expect(new Set(ran).size, "every row's hook ran exactly once").toBe(N);
        expect(logMock.warn, "nothing skipped the second time").toHaveBeenCalledTimes(1);

        await tick(ids);
        expect(ran, "applied: quiet").toHaveLength(N);
      });

      it("M2: a tick whose budget is already spent still ends rows (a bounded statement) but runs no hook and asks no finder; the next tick does both", async () => {
        const id = await seat();
        mine.push(id);
        await expireNow(id);
        expect(await tick([id], { budgetMs: 0 })).toEqual({ ...ZERO, expired: 1 });
        expect((await get(id)).status).toBe("expired");
        expect(hookSpy).not.toHaveBeenCalled();
        expect(finder).not.toHaveBeenCalled();
        expect(logMock.warn).toHaveBeenCalledTimes(1);
        expect(logMock.warn.mock.calls[0]![0]).toMatchObject({ skippedHooks: 1 });

        expect(await tick([id])).toEqual(ZERO);
        expect(hookSpy, "re-driven on the next tick").toHaveBeenCalledTimes(1);
        expect(finder).toHaveBeenCalledTimes(1);
      });

      it("a row that did NOT end badly is never re-driven: the finder is only asked about endings, and a live row is untouched", async () => {
        const id = await seat();
        mine.push(id);
        await tick([id]);
        expect((await get(id)).status).toBe("sent");
        expect(hookSpy).not.toHaveBeenCalled();
      });
    });
  });
});
