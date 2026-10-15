// T17B fix 2, D21 — the platform-wide RealtimeKit call budget (video/budget.ts, V446 `realtimekit_call_budget`).
//
// The vendor allows 1,200 REST calls per five minutes for the WHOLE account; past it every call, for every club, is
// refused for five minutes. The bucket is how we stay under it — so what these tests pin is the property the vendor
// cares about, not the bucket's internals: in ANY five-minute window no more than the ceiling is ever let through,
// however hard it is hammered, whatever the clock does, however many machines ask at once.
//
// The ceiling and the vendor's limit are the constants the code declares and the ruling states (900 of 1,200); every
// expectation below is derived from them or from the bucket's own algebra, never from a number typed beside the
// assertion. The time axis is the statement's `at` seam, so a twenty-minute hammering runs in seconds.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  RTK_BUDGET_BURST,
  RTK_BUDGET_REFILL_PER_S,
  RTK_BUDGET_WINDOW_MS,
  RTK_CALLS_PER_WINDOW,
  RTK_VENDOR_LIMIT_PER_WINDOW,
  budgetKey,
  takeRealtimeKitCall,
} from "../budget";

const DB = !!process.env.DATABASE_URL;
const T0 = new Date("2026-10-15T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
/** A key no other test or run shares: the table persists between runs and the production key is never touched. */
const mint = () => `test|${randomUUID()}`;
const made: string[] = [];
const fresh = () => {
  const k = mint();
  made.push(k);
  return k;
};
afterAll(async () => {
  if (DB && made.length > 0) await sql`delete from realtimekit_call_budget where key in ${sql(made)}`;
  if (DB) await sql.end();
});

describe("the constants (the ruling, not the algebra of the implementation)", () => {
  it("the ceiling is under the vendor's limit, and the bucket's burst and refill add up to exactly the ceiling over a window", () => {
    expect(RTK_VENDOR_LIMIT_PER_WINDOW, "the vendor's published limit").toBe(1_200);
    expect(RTK_BUDGET_WINDOW_MS).toBe(5 * 60_000);
    expect(RTK_CALLS_PER_WINDOW).toBeLessThan(RTK_VENDOR_LIMIT_PER_WINDOW);
    // A bucket of capacity B refilled at r per second can pass at most B + r*W in any window W — the burst PLUS a
    // window's refill. Sizing the capacity at the whole ceiling would pass twice it (1,800 in five minutes).
    expect(RTK_BUDGET_BURST + RTK_BUDGET_REFILL_PER_S * (RTK_BUDGET_WINDOW_MS / 1_000)).toBe(RTK_CALLS_PER_WINDOW);
    expect(RTK_BUDGET_BURST).toBeLessThan(RTK_CALLS_PER_WINDOW);
  });

  it("the key names the vendor host AND the account: another fixture vendor, or another account, is another bucket", () => {
    const keys = new Set([
      budgetKey("https://api.cloudflare.com/client/v4", "acct-1"),
      budgetKey("https://api.cloudflare.com/client/v4/", "acct-1"),
      budgetKey("https://api.cloudflare.com/client/v4", "acct-2"),
      budgetKey("http://127.0.0.1:41001", "acct-1"),
      budgetKey("http://127.0.0.1:41002", "acct-1"),
    ]);
    // The trailing slash is the same vendor; the other three differ.
    expect(keys.size).toBe(4);
  });
});

describe.skipIf(!DB)("the bucket", () => {
  it("empty case: a vendor never asked about has a FULL bucket — exactly the burst is let through, the next call is refused", async () => {
    const key = fresh();
    let allowed = 0;
    for (let i = 0; i < RTK_BUDGET_BURST + 5; i += 1) if (await takeRealtimeKitCall(key, { at: at(0) })) allowed += 1;
    expect(allowed, "the burst, no more").toBe(RTK_BUDGET_BURST);
    expect(await takeRealtimeKitCall(key, { at: at(0) }), "the call after the burst").toBe(false);
  });

  it("a refused call spends nothing and a refusal is repeatable (the second ask is not a different answer)", async () => {
    const key = fresh();
    for (let i = 0; i < RTK_BUDGET_BURST; i += 1) await takeRealtimeKitCall(key, { at: at(0) });
    const answers = [];
    for (let i = 0; i < 3; i += 1) answers.push(await takeRealtimeKitCall(key, { at: at(0) }));
    expect(answers).toEqual([false, false, false]);
    const [row] = await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`;
    expect(row!.tokens, "a refusal takes no token").toBeGreaterThanOrEqual(0);
    expect(row!.tokens).toBeLessThan(1);
  });

  it("refills with elapsed time: after k seconds exactly floor(k * rate) calls are let through again — a count that is NOT the burst", async () => {
    const key = fresh();
    for (let i = 0; i < RTK_BUDGET_BURST; i += 1) await takeRealtimeKitCall(key, { at: at(0) });
    const seconds = 10;
    const want = Math.floor(seconds * RTK_BUDGET_REFILL_PER_S);
    expect(want, "premise: differs from the burst, so a no-refill or a full-refill bucket cannot pass").not.toBe(RTK_BUDGET_BURST);
    expect(want).toBeGreaterThan(0);
    let allowed = 0;
    for (let i = 0; i < want + 5; i += 1) if (await takeRealtimeKitCall(key, { at: at(seconds * 1_000) })) allowed += 1;
    expect(allowed).toBe(want);
  });

  it("never refills past the burst: an hour idle lets exactly the burst through, not an hour's worth", async () => {
    const key = fresh();
    await takeRealtimeKitCall(key, { at: at(0) });
    let allowed = 0;
    for (let i = 0; i < RTK_BUDGET_BURST + 20; i += 1) if (await takeRealtimeKitCall(key, { at: at(3_600_000) })) allowed += 1;
    expect(allowed).toBe(RTK_BUDGET_BURST);
  });

  it("a clock that steps BACK neither mints nor LOSES tokens (elapsed time is floored at zero): the bucket afterwards holds exactly what was left", async () => {
    const key = fresh();
    const spentFirst = 10;
    for (let i = 0; i < spentFirst; i += 1) expect(await takeRealtimeKitCall(key, { at: at(600_000) })).toBe(true);
    // A stamp a minute AHEAD of this call: a minute of "negative" refill, which must be nothing at all.
    expect(await takeRealtimeKitCall(key, { at: at(540_000) }), "the step back is still served").toBe(true);
    let allowed = 0;
    for (let i = 0; i < RTK_BUDGET_BURST + 5; i += 1) if (await takeRealtimeKitCall(key, { at: at(540_000) })) allowed += 1;
    expect(allowed, "exactly the tokens left: the burst less the eleven spent").toBe(RTK_BUDGET_BURST - spentFirst - 1);
  });

  it("the statement reads the clock ONCE: a volatile clock expression is evaluated exactly one time per call, on a new bucket and on an existing one (D21 review m4)", async () => {
    // A backward clock step between the statement's WHERE and its SET refilled less in the SET than the WHERE had
    // judged, took the bucket a hair under zero, and the CHECK (tokens >= 0) then threw out of every RealtimeKit call.
    // The DB clock cannot be stepped from here, so the property is witnessed the other way: stand a VOLATILE expression
    // in for the clock (a sequence's nextval, one step further back each time it is evaluated) and count the evaluations.
    const seq = `test_clock_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sql.unsafe(`create sequence ${seq}`);
    try {
      const steppingBack = () => sql`(${T0}::timestamptz + interval '1 hour' - nextval(${seq}::regclass) * interval '3 seconds')`;
      const evaluations = async () => {
        const [row] = await sql<{ last_value: string; is_called: boolean }[]>`select last_value, is_called from ${sql(seq)}`;
        return row!.is_called ? Number(row!.last_value) : 0;
      };
      const key = fresh();
      expect(await evaluations(), "premise: the stand-in clock has not been read").toBe(0);
      expect(await takeRealtimeKitCall(key, { clockSql: steppingBack() }), "a new bucket").toBe(true);
      expect(await evaluations(), "a new bucket: one evaluation").toBe(1);
      expect(await takeRealtimeKitCall(key, { clockSql: steppingBack() }), "an existing bucket").toBe(true);
      expect(await evaluations(), "an existing bucket: one more evaluation, not three").toBe(2);
      // A refusal reads it once too (the WHERE judged against the same instant the stamp would have used).
      const drained = fresh();
      // Stamped ahead of the stand-in clock, so no time has passed for it: nothing refills.
      await sql`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${drained}, 0, ${at(2 * 3_600_000)})`;
      expect(await takeRealtimeKitCall(drained, { clockSql: steppingBack() }), "a bucket with nothing in it: refused").toBe(false);
      expect(await evaluations(), "a refusal: one more evaluation").toBe(3);
      const [row] = await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`;
      expect(row!.tokens, "never below zero").toBeGreaterThanOrEqual(0);
    } finally {
      await sql.unsafe(`drop sequence ${seq}`);
    }
  });

  it("two vendors never share a bucket: spending one to empty leaves the other full", async () => {
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < RTK_BUDGET_BURST; i += 1) await takeRealtimeKitCall(a, { at: at(0) });
    expect(await takeRealtimeKitCall(a, { at: at(0) })).toBe(false);
    expect(await takeRealtimeKitCall(b, { at: at(0) }), "the positive pair").toBe(true);
  });

  it("CONCURRENT callers can never spend the same token: N machines asking at once are let through exactly as many times as there are tokens", async () => {
    const key = fresh();
    const tokens = 12;
    await sql`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, ${tokens}, ${at(0)})`;
    const asks = 80;
    const answers = await Promise.all(Array.from({ length: asks }, () => takeRealtimeKitCall(key, { at: at(0) })));
    expect(answers.length, "anti-vacuity").toBe(asks);
    expect(answers.filter(Boolean).length).toBe(tokens);
  });

  it("two first-ever callers racing to create the row neither error nor over-spend: the burst is still the burst", async () => {
    const key = fresh();
    const answers = await Promise.all(Array.from({ length: RTK_BUDGET_BURST + 40 }, () => takeRealtimeKitCall(key, { at: at(0) })));
    expect(answers.filter(Boolean).length).toBe(RTK_BUDGET_BURST);
  });

  it("THE INVARIANT: hammered for twenty minutes, no five-minute window ever passes more than the ceiling — and the bucket is not simply shut (supply is used)", async () => {
    const key = fresh();
    const stepMs = 250;
    const minutes = 20;
    const passed: number[] = [];
    let asked = 0;
    for (let t = 0; t <= minutes * 60_000; t += stepMs) {
      // Demand far above supply: four asks per step.
      for (let i = 0; i < 4; i += 1) {
        asked += 1;
        if (await takeRealtimeKitCall(key, { at: at(t) })) passed.push(t);
      }
    }
    expect(asked, "anti-vacuity: the sweep asked").toBeGreaterThan(RTK_CALLS_PER_WINDOW * 4);
    // Every CLOSED window of RTK_BUDGET_WINDOW_MS beginning at a call that was let through (closed is the harder bar:
    // both ends count).
    let windows = 0;
    let worst = 0;
    let hi = 0;
    for (let lo = 0; lo < passed.length; lo += 1) {
      while (hi < passed.length && passed[hi]! <= passed[lo]! + RTK_BUDGET_WINDOW_MS) hi += 1;
      worst = Math.max(worst, hi - lo);
      windows += 1;
    }
    expect(windows, "anti-vacuity: windows checked").toBe(passed.length);
    expect(worst, "the most any five-minute window passed").toBeLessThanOrEqual(RTK_CALLS_PER_WINDOW);
    // Not vacuously safe: a bucket that refuses everything passes zero. The steady state is the refill rate.
    const expectedTotal = RTK_BUDGET_BURST + Math.floor(minutes * 60 * RTK_BUDGET_REFILL_PER_S);
    expect(passed.length).toBe(expectedTotal);
    // …and the worst window really did reach the ceiling (the burst plus one window's refill), so the bound is tight.
    expect(worst).toBe(RTK_CALLS_PER_WINDOW);
  }, 120_000);
});
