// dispatchNow's pacing and budget (Task 7, coordinator ruling): the first attempts a request runs right after its transaction
// commits must stay inside Resend's 2 requests a second, and must not hold the organiser's request for a whole large round.
//
//  - consecutive attempts start at least MIN_SEND_INTERVAL_MS apart (the interval runs from the START of the previous attempt,
//    as the worker's does), and nothing sleeps before the first attempt, so a single-row call (the sign-in link) never waits;
//  - once DISPATCH_NOW_BUDGET_MS has elapsed since the call began, no further row is claimed: it stays `queued`, attempts
//    untouched, outcome `deferred` (what the first-429 stop leaves too), and the worker sends it. The FIRST attempt of a call is
//    never held back by the budget;
//  - the interval is owed to the provider, so only a request counts: a row refused before any request left (no API key,
//    suppressed, expired as its attempt began) starts no interval and adds no wait (fix round 1, C2);
//  - production cannot be unpaced; the escape the test config uses (EMAIL_OUTBOX_DISPATCH_UNPACED) is refused there;
//  - the production DEFAULTS of the two seams (a real timer, `performance.now()`) are driven with nothing injected (fix round 1, I1).
//
// Every expected number comes from the constants (MIN_SEND_INTERVAL_MS, DISPATCH_NOW_BUDGET_MS) and the test's own fake
// clock; nothing waits for real. The fake clock is `t`: `sleep(ms)` advances it by `ms`, and a send advances it by whatever
// the test says that send "took".
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { suppress } from "@/lib/email";
import { attemptClaimed, claimQueuedRow, dispatchNow, toClaimedRow, type ClaimedRow } from "../attempt";
import { DISPATCH_NOW_BUDGET_MS, MIN_SEND_INTERVAL_MS, OUTBOX_KINDS, type OutboxKind } from "../constants";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { KIND_HOOKS } from "../hooks";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t7p-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;

/** How many attempts a call can start inside the budget when every send is instant: the k-th (from 0) starts at k * interval,
 *  and is held back once that reaches the budget. Derived from the two constants, never typed. */
const ATTEMPTS_IN_BUDGET = Math.ceil(DISPATCH_NOW_BUDGET_MS / MIN_SEND_INTERVAL_MS);

type Row = { status: string; attempts: number; lease_until: Date | null; body_sealed: Buffer | null };

describe.skipIf(!HAS_DB)("dispatchNow - pacing and the budget (DB)", () => {
  const created: string[] = [];
  const suppressedAddresses: string[] = [];
  const saved = {} as Record<OutboxKind, (typeof KIND_HOOKS)[OutboxKind]>;

  // The fake clock and what happened on it, in order.
  let t = 0;
  let events: string[] = [];
  let starts: number[] = [];
  let sleeps: number[] = [];
  /** How many sends the provider has seen in this test, and how long the n-th (from 0) one "takes" on the fake clock. */
  let sendNo = 0;
  let tookMs: (n: number) => number = () => 0;
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    events.push("sleep");
    t += ms;
  };
  const nowMs = (): number => t;

  async function queueN(n: number, over: Partial<OutboxMessage> = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const m: OutboxMessage = {
        kind: "chess_invite",
        refType: "fixture_seat",
        refId: `${RUN}-${randomUUID()}`,
        orgId: null,
        to: `${randomUUID()}@x.test`,
        subject: "Round 1",
        html: "<p>x</p>",
        text: "x",
        transactional: true,
        expiresAt: new Date(Date.now() + 15 * MIN),
        ...over,
      };
      const id = await enqueueEmail(sql, m);
      created.push(id);
      ids.push(id);
    }
    return ids;
  }
  const rowOf = async (id: string): Promise<Row> =>
    (await sql<Row[]>`select status, attempts, lease_until, body_sealed from email_outbox where id = ${id}`)[0]!;

  beforeAll(() => {
    // The chess kind has a hook in production; nothing here ends badly, and the hook would reach other tables.
    for (const k of OUTBOX_KINDS) saved[k] = KIND_HOOKS[k];
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    if (suppressedAddresses.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressedAddresses)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", "ab".repeat(32));
    vi.stubEnv("RESEND_API_KEY", "re_test");
    // The test config runs the whole suite UNPACED (vitest.config.ts) so the chess suites do not sleep for real; this file is
    // the one that proves the pacing, so it switches it back on.
    vi.stubEnv("EMAIL_OUTBOX_DISPATCH_UNPACED", "");
    t = 1_000;
    events = [];
    starts = [];
    sleeps = [];
    tookMs = () => 0;
    sendNo = 0;
    logMock.error.mockClear();
    deliverMock.mockReset();
    deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) => {
      events.push("send");
      starts.push(t);
      t += tookMs(sendNo++);
      return { ok: true, providerId: `re_${m.tags.outbox}` };
    });
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = {};
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = saved[k];
  });

  it("consecutive attempts start at least MIN_SEND_INTERVAL_MS apart, whatever the sends cost", async () => {
    // The sends' own durations differ (instant, half an interval, a whole interval, longer than one): the rule is on the START
    // of one attempt to the START of the next, so a slow send owes less (or no) wait and a quick one owes the whole interval.
    tookMs = (n) => [0, MIN_SEND_INTERVAL_MS / 2, MIN_SEND_INTERVAL_MS, MIN_SEND_INTERVAL_MS * 2, 0][n % 5]!;
    const ids = await queueN(6);
    const out = await dispatchNow(ids, { sleep, nowMs });
    expect(starts, "anti-vacuity: every row was attempted").toHaveLength(ids.length);
    expect([...out.values()].every((o) => o === "sent")).toBe(true);
    let gaps = 0;
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!, `attempt ${i} started too soon after attempt ${i - 1}`).toBeGreaterThanOrEqual(MIN_SEND_INTERVAL_MS);
      gaps += 1;
    }
    expect(gaps, "anti-vacuity: the gaps were checked").toBe(ids.length - 1);
  });

  it("the wait is only what the previous attempt left of the interval, and none is owed after a send that took the whole interval", async () => {
    tookMs = (n) => (n === 0 ? MIN_SEND_INTERVAL_MS / 2 : n === 1 ? MIN_SEND_INTERVAL_MS : 0);
    const ids = await queueN(4);
    await dispatchNow(ids, { sleep, nowMs });
    // attempt 0 took half an interval: wait the other half. attempt 1 took the whole interval: no wait. attempt 2 was instant:
    // the whole interval.
    expect(sleeps).toEqual([MIN_SEND_INTERVAL_MS / 2, MIN_SEND_INTERVAL_MS]);
  });

  it("nothing sleeps before the first attempt: the order is send, sleep, send, ...", async () => {
    const ids = await queueN(3);
    await dispatchNow(ids, { sleep, nowMs });
    expect(events).toEqual(["send", "sleep", "send", "sleep", "send"]);
  });

  it("a single-row call (the sign-in link) never sleeps and sends at once", async () => {
    const [id] = await queueN(1);
    const out = await dispatchNow([id!], { sleep, nowMs });
    expect(out.get(id!)).toBe("sent");
    expect(sleeps).toHaveLength(0);
    expect(events).toEqual(["send"]);
  });

  it("ids that cannot be attempted (already taken) do not count as a previous attempt: the first real attempt does not wait", async () => {
    const [done, fresh] = await queueN(2);
    await dispatchNow([done!], { sleep, nowMs });
    events = [];
    sleeps = [];
    const out = await dispatchNow([done!, fresh!], { sleep, nowMs }); // `done` is already sent: deferred, never attempted
    expect(out.get(done!)).toBe("deferred");
    expect(out.get(fresh!)).toBe("sent");
    expect(sleeps, "the only attempt of the call is its first").toHaveLength(0);
  });

  it("C2 - a call that makes no request owes no wait: N rows with no API key mean zero sleeps (the CI and e2e shape)", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    const ids = await queueN(4);
    const out = await dispatchNow(ids, { sleep, nowMs });
    expect(ids.map((id) => out.get(id)), "anti-vacuity: every row was attempted and refused at the gate").toEqual(ids.map(() => "dead"));
    expect(deliverMock, "no request left").not.toHaveBeenCalled();
    expect(sleeps, "refusals start no interval, so nothing waits").toEqual([]);
  });

  it("C2 - a row refused before any request does not delay the first real one, and the real requests stay MIN_SEND_INTERVAL_MS apart around a refusal", async () => {
    const to = `${randomUUID()}@suppressed.test`;
    suppressedAddresses.push(to);
    await suppress(to, "manual");
    const refusedAhead = (await queueN(1, { to, transactional: false }))[0]!;
    const [real0, real1] = await queueN(2);
    const refusedBetween = (await queueN(1, { to, transactional: false }))[0]!;
    const real2 = (await queueN(1))[0]!;
    const out = await dispatchNow([refusedAhead, real0!, real1!, refusedBetween, real2], { sleep, nowMs });
    expect([refusedAhead, refusedBetween].map((id) => out.get(id)), "premise: both were refused at the gate").toEqual(["suppressed", "suppressed"]);
    expect([real0!, real1!, real2].map((id) => out.get(id))).toEqual(["sent", "sent", "sent"]);
    expect(starts, "anti-vacuity: exactly the three real rows made a request").toHaveLength(3);
    expect(events[0], "the first real request is not held back by the refusal ahead of it").toBe("send");
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!, `request ${i} started too soon after request ${i - 1}`).toBeGreaterThanOrEqual(MIN_SEND_INTERVAL_MS);
    }
    expect(sleeps.length, "a wait is owed only between two requests").toBeLessThanOrEqual(starts.length - 1);
  });

  it("T7 N1 - a row whose attempt THROWS after its request left still starts an interval: the next send waits one", async () => {
    // The post-send write of the first row fails (another row already holds the provider id the transport answered with: the column is
    // unique), so `attemptClaimed` throws AFTER the request left. dispatchNow's catch cannot know the request's fate, so it counts it as made.
    const [bad, good] = await queueN(2);
    const [holder] = await queueN(1);
    await sql`update email_outbox set provider_id = ${`re_${bad!}`} where id = ${holder!}`; // the id deliverMock answers `bad` with
    const out = await dispatchNow([bad!, good!], { sleep, nowMs });
    expect(out.get(bad!), "premise: the recording write threw, so the row is left to the worker").toBe("deferred");
    expect((await rowOf(bad!)).status, "and it is still sending").toBe("sending");
    expect(out.get(good!)).toBe("sent");
    expect(starts, "anti-vacuity: both requests left").toHaveLength(2);
    expect(sleeps, "the request that threw counts: one interval before the next").toEqual([MIN_SEND_INTERVAL_MS]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(MIN_SEND_INTERVAL_MS);
    expect(logMock.error, "and the failure was logged").toHaveBeenCalled();
  });

  describe("attemptClaimed says whether a request left (what the pacing counts)", () => {
    /** Claim one queued row with the production statement (`claimQueuedRow`, the one `dispatchNow` makes) and return it as the attempt is
     *  handed it. */
    async function claimed(over: Partial<OutboxMessage> = {}): Promise<ClaimedRow> {
      const [id] = await queueN(1, over);
      const rec = await claimQueuedRow(id!, new Date());
      if (!rec) throw new Error(`could not claim ${id}`);
      return toClaimedRow(rec);
    }
    const http = (status: number, errorName: string) => ({ ok: false, reason: "http", status, errorName, detail: "x" });

    it("is true exactly when the transport was called, for every way an attempt can end", async () => {
      const suppressedTo = `${randomUUID()}@suppressed.test`;
      suppressedAddresses.push(suppressedTo);
      await suppress(suppressedTo, "manual");
      type Case = { name: string; requestMade: boolean; run: () => Promise<Awaited<ReturnType<typeof attemptClaimed>>> };
      const cases: Case[] = [
        { name: "2xx", requestMade: true, run: async () => attemptClaimed(await claimed()) },
        {
          name: "503 (retry later)",
          requestMade: true,
          run: async () => {
            deliverMock.mockResolvedValueOnce(http(503, "service_unavailable"));
            return attemptClaimed(await claimed());
          },
        },
        {
          name: "429",
          requestMade: true,
          run: async () => {
            deliverMock.mockResolvedValueOnce(http(429, "rate_limit_exceeded"));
            return attemptClaimed(await claimed());
          },
        },
        {
          name: "422 (dead for good)",
          requestMade: true,
          run: async () => {
            deliverMock.mockResolvedValueOnce(http(422, "validation_error"));
            return attemptClaimed(await claimed());
          },
        },
        {
          name: "the transport throws (the request may have left)",
          requestMade: true,
          run: async () => {
            deliverMock.mockRejectedValueOnce(new Error("boom"));
            return attemptClaimed(await claimed());
          },
        },
        {
          name: "no API key",
          requestMade: false,
          run: async () => {
            vi.stubEnv("RESEND_API_KEY", undefined);
            return attemptClaimed(await claimed());
          },
        },
        { name: "suppressed", requestMade: false, run: async () => attemptClaimed(await claimed({ to: suppressedTo, transactional: false })) },
        {
          name: "expired as the attempt begins",
          requestMade: false,
          run: async () => attemptClaimed(await claimed(), { now: new Date(Date.now() + 60 * MIN) }),
        },
        {
          name: "the body is missing",
          requestMade: false,
          run: async () => attemptClaimed({ ...(await claimed()), bodySealed: null }),
        },
        {
          name: "the body cannot be opened",
          requestMade: false,
          run: async () => attemptClaimed({ ...(await claimed()), bodySealed: new Uint8Array([1, 2, 3]) }),
        },
      ];
      let checked = 0;
      for (const c of cases) {
        deliverMock.mockClear();
        vi.stubEnv("RESEND_API_KEY", "re_test");
        const res = await c.run();
        expect(res.requestMade, c.name).toBe(c.requestMade);
        expect(deliverMock.mock.calls.length > 0, `${c.name}: requestMade must agree with whether the transport was called`).toBe(c.requestMade);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every case ran").toBe(cases.length);
      expect(cases.filter((c) => c.requestMade).length, "both classes are represented").toBeGreaterThan(0);
      expect(cases.filter((c) => !c.requestMade).length).toBeGreaterThan(0);
    });
  });

  // I1: the two production defaults. Everything above injects both seams; this runs with NEITHER, on real timers.
  it("I1 - with nothing injected, the real timer and the real clock hold consecutive requests MIN_SEND_INTERVAL_MS apart, start to start", async () => {
    const SEND_TOOK_MS = 400; // < the interval: the wait owed after it is the remainder, measured on the real monotonic clock
    const TIMER_SLACK_MS = 10; // a Node timer may fire a millisecond or so early
    const marks: { start: number; end: number }[] = [];
    deliverMock.mockReset();
    deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) => {
      const start = performance.now();
      await new Promise((r) => setTimeout(r, SEND_TOOK_MS));
      marks.push({ start, end: performance.now() });
      return { ok: true, providerId: `re_${m.tags.outbox}` };
    });
    const ids = await queueN(2);
    const out = await dispatchNow(ids); // no sleep, no nowMs
    expect(ids.map((id) => out.get(id))).toEqual(["sent", "sent"]);
    expect(marks, "anti-vacuity: two requests were made").toHaveLength(2);
    const startToStart = marks[1]!.start - marks[0]!.start;
    expect(startToStart, "the default sleep really waits").toBeGreaterThanOrEqual(MIN_SEND_INTERVAL_MS - TIMER_SLACK_MS);
    // Start to start, not end to start: the first send used SEND_TOOK_MS of the interval, so only the rest was owed. A default
    // clock that does not tell time (a constant) would owe the whole interval again after the send, and the gap from the first
    // request's END to the second's START would be MIN_SEND_INTERVAL_MS instead of the remainder.
    const owedAfterSend = marks[1]!.start - marks[0]!.end;
    expect(owedAfterSend, "the default clock measures from the START of the previous request").toBeLessThan(
      MIN_SEND_INTERVAL_MS - SEND_TOOK_MS / 2,
    );
  });

  it("the budget: past DISPATCH_NOW_BUDGET_MS the rest is never claimed - queued, attempts 0, no lease, body kept, outcome deferred", async () => {
    const ids = await queueN(ATTEMPTS_IN_BUDGET + 3);
    const out = await dispatchNow(ids, { sleep, nowMs });
    expect(starts, "exactly the attempts that fit in the budget were made").toHaveLength(ATTEMPTS_IN_BUDGET);
    const attempted = ids.slice(0, ATTEMPTS_IN_BUDGET);
    const rest = ids.slice(ATTEMPTS_IN_BUDGET);
    expect(rest, "anti-vacuity: some rows were beyond the budget").not.toHaveLength(0);
    for (const id of attempted) expect(out.get(id), id).toBe("sent");
    for (const id of rest) {
      expect(out.get(id), id).toBe("deferred");
      const row = await rowOf(id);
      expect(row.status).toBe("queued");
      expect(row.attempts, "an unclaimed row's attempts are unchanged").toBe(0);
      expect(row.lease_until).toBeNull();
      expect(row.body_sealed, "the worker will need the body").not.toBeNull();
    }
    // Every attempt that was made started inside the budget; none after it.
    for (const s of starts) expect(s - 1_000).toBeLessThan(DISPATCH_NOW_BUDGET_MS);
  });

  it("a slow provider spends the budget mid-batch: the send that took it all is the last, the remainder stays queued", async () => {
    tookMs = (n) => (n === 2 ? DISPATCH_NOW_BUDGET_MS : 0);
    const ids = await queueN(6);
    const out = await dispatchNow(ids, { sleep, nowMs });
    expect(starts, "the third send used the whole budget; nothing was claimed after it").toHaveLength(3);
    expect(ids.slice(0, 3).map((id) => out.get(id))).toEqual(["sent", "sent", "sent"]);
    expect(ids.slice(3).map((id) => out.get(id))).toEqual(["deferred", "deferred", "deferred"]);
    for (const id of ids.slice(3)) expect(await rowOf(id)).toMatchObject({ status: "queued", attempts: 0, lease_until: null });
  });

  it("the budget never holds back the FIRST attempt of a call, however late the clock already reads", async () => {
    // A clock that jumps a whole budget at every look: by the time the first row is reached the budget is long gone.
    let calls = 0;
    const jumpy = (): number => calls++ * DISPATCH_NOW_BUDGET_MS;
    const ids = await queueN(3);
    const out = await dispatchNow(ids, { sleep, nowMs: jumpy });
    expect(starts, "one attempt, the first").toHaveLength(1);
    expect(out.get(ids[0]!)).toBe("sent");
    expect(ids.slice(1).map((id) => out.get(id))).toEqual(["deferred", "deferred"]);
  });

  it("the first 429 still stops the call, and the stop is not followed by a wait", async () => {
    deliverMock.mockReset();
    let sent = 0;
    deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) => {
      events.push("send");
      sent += 1;
      return sent === 2
        ? { ok: false, reason: "http", status: 429, errorName: "rate_limit_exceeded", detail: "slow down" }
        : { ok: true, providerId: `re_${m.tags.outbox}` };
    });
    const ids = await queueN(4);
    const out = await dispatchNow(ids, { sleep, nowMs });
    expect(sent, "two requests: the one that was limited is the last").toBe(2);
    expect(events).toEqual(["send", "sleep", "send"]);
    expect(ids.map((id) => out.get(id))).toEqual(["sent", "retrying", "deferred", "deferred"]);
  });

  it("production is paced whatever the test escape says; outside production the escape turns the wait off but not the budget", async () => {
    const ids = await queueN(3);
    vi.stubEnv("EMAIL_OUTBOX_DISPATCH_UNPACED", "1");
    vi.stubEnv("NODE_ENV", "production");
    await dispatchNow(ids, { sleep, nowMs });
    expect(sleeps, "production sleeps between sends even with the escape set").toEqual([MIN_SEND_INTERVAL_MS, MIN_SEND_INTERVAL_MS]);

    // Outside production the escape is honoured: no waits at all (this is how the chess suites run), and the budget still bounds a call.
    vi.stubEnv("NODE_ENV", "test");
    sleeps = [];
    starts = [];
    const more = await queueN(3);
    const firstOfThese = sendNo; // the provider has already seen the production call's sends
    tookMs = (n) => (n === firstOfThese ? DISPATCH_NOW_BUDGET_MS : 0);
    const out = await dispatchNow(more, { sleep, nowMs });
    expect(sleeps).toHaveLength(0);
    expect(starts, "unpaced, but the first send spent the budget, so the rest is left queued").toHaveLength(1);
    expect(more.slice(1).map((id) => out.get(id))).toEqual(["deferred", "deferred"]);
  });
});
