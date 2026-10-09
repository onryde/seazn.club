// M3 (measured 2026-10-09): four creates in ~1s, then every subsequent create
// 429s. A 64-player round wants 32 games at once. This queue serialises
// creation and backs off; the tests assert the ORDER and the SPACING, because
// "it eventually succeeded" is also what an unthrottled burst looks like once
// the retries land.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATION_BACKOFF_MS,
  CREATION_MIN_SPACING_MS,
  CreationRateLimited,
  __resetCreationQueue,
  __setCreationQueueDeps,
  enqueueCreation,
} from "../creation-queue";
import { MINT_CLAIM_STALE_MS } from "../window";

/** A virtual clock. `sleep` advances it instead of waiting, so a 32-game burst
 *  runs in microseconds and the assertions are exact rather than tolerant. */
function virtualClock() {
  let t = 0;
  return {
    deps: {
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    },
    at: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

let clock: ReturnType<typeof virtualClock>;

beforeEach(() => {
  __resetCreationQueue();
  clock = virtualClock();
  __setCreationQueueDeps(clock.deps);
});
afterEach(() => {
  __resetCreationQueue();
});

describe("enqueueCreation — order", () => {
  it("runs jobs in the order they were enqueued, one at a time", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const job = (name: string) => async () => {
      started.push(name);
      // If the queue were not serial, the next job would start here.
      await Promise.resolve();
      finished.push(name);
      return name;
    };
    const keys = ["f1", "f2", "f3", "f4", "f5"];
    const results = await Promise.all(keys.map((k) => enqueueCreation(k, job(k))));
    expect(results).toEqual(keys);
    expect(started).toEqual(keys);
    // Strict interleave: every job finished before the next one started.
    expect(finished).toEqual(keys);
  });

  it("never runs two jobs concurrently, even when each one awaits", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const job = () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return 1;
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => enqueueCreation(`k${i}`, job())));
    expect(maxInFlight).toBe(1);
  });

  it("a failing job does not stall the queue — the next one still runs", async () => {
    const ran: string[] = [];
    const bad = enqueueCreation("bad", async () => { throw new Error("provider down"); });
    await expect(bad).rejects.toThrow("provider down");
    await enqueueCreation("good", async () => { ran.push("good"); return 1; });
    expect(ran).toEqual(["good"]);
  });
});

describe("enqueueCreation — spacing", () => {
  it("spaces consecutive creates by at least CREATION_MIN_SPACING_MS", async () => {
    const at: number[] = [];
    const keys = ["a", "b", "c", "d", "e", "f"];
    await Promise.all(keys.map((k) =>
      enqueueCreation(k, async () => { at.push(clock.at()); return k; })));
    expect(at.length).toBe(keys.length);
    let checked = 0;
    for (let i = 1; i < at.length; i++) {
      expect(at[i]! - at[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(CREATION_MIN_SPACING_MS);
      checked++;
    }
    // Anti-vacuity: a one-element run would pass the loop above vacuously.
    expect(checked, "the spacing sweep checked no gaps").toBe(keys.length - 1);
    expect(checked).toBeGreaterThan(0);
  });

  it("the 32 creates a 64-player round wants stay under the measured ceiling", async () => {
    const at: number[] = [];
    await Promise.all(Array.from({ length: 32 }, (_, i) =>
      enqueueCreation(`f${i}`, async () => { at.push(clock.at()); return i; })));
    expect(at.length).toBe(32);
    // M3's ceiling is ~4 creates per second. Derived from the constant, not
    // retyped: a change to the spacing moves this assertion with it.
    const perSecond = 1000 / CREATION_MIN_SPACING_MS;
    expect(perSecond).toBeLessThan(4);
    expect(at[31]! - at[0]!).toBeGreaterThanOrEqual(31 * CREATION_MIN_SPACING_MS);
    // And it is not absurdly slow: a round must open in seconds, not minutes.
    expect(at[31]! - at[0]!).toBeLessThan(30_000);
  });

  it("does NOT pay the spacing before the first create — an idle queue is instant", async () => {
    await enqueueCreation("solo", async () => clock.at());
    expect(clock.at()).toBe(0);
  });

  it("a create arriving after a long idle gap pays no spacing either", async () => {
    await enqueueCreation("one", async () => 1);
    clock.advance(60_000);
    const before = clock.at();
    await enqueueCreation("two", async () => 2);
    expect(clock.at()).toBe(before);
  });
});

describe("enqueueCreation — 429 backoff", () => {
  it("retries a rate-limited job on the declared backoff ladder, in order", async () => {
    const attemptsAt: number[] = [];
    let attempt = 0;
    const out = await enqueueCreation("rl", async () => {
      attemptsAt.push(clock.at());
      attempt++;
      if (attempt <= CREATION_BACKOFF_MS.length) throw new CreationRateLimited("429");
      return "created";
    });
    expect(out).toBe("created");
    expect(attemptsAt.length).toBe(CREATION_BACKOFF_MS.length + 1);
    let checked = 0;
    for (let i = 1; i < attemptsAt.length; i++) {
      // The gap is the ladder rung PLUS the spacing the next attempt pays.
      expect(attemptsAt[i]! - attemptsAt[i - 1]!, `rung ${i}`)
        .toBeGreaterThanOrEqual(CREATION_BACKOFF_MS[i - 1]!);
      checked++;
    }
    expect(checked, "the backoff sweep checked no rungs").toBe(CREATION_BACKOFF_MS.length);
    expect(checked).toBeGreaterThan(0);
    // Monotonic, not flat: a ladder of equal rungs is not a backoff.
    const rungs = [...CREATION_BACKOFF_MS];
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(new Set(rungs).size).toBe(rungs.length);
  });

  it("gives up after the ladder is exhausted, and says it was rate limited", async () => {
    let attempt = 0;
    await expect(enqueueCreation("rl2", async () => {
      attempt++;
      throw new CreationRateLimited("429");
    })).rejects.toBeInstanceOf(CreationRateLimited);
    expect(attempt).toBe(CREATION_BACKOFF_MS.length + 1);
  });

  it("a NON-429 failure is not retried — a bad username must not be hammered", async () => {
    let attempt = 0;
    await expect(enqueueCreation("nr", async () => {
      attempt++;
      throw new Error("no such user");
    })).rejects.toThrow("no such user");
    expect(attempt).toBe(1);
  });

  // Added beyond the brief: the module's comment claims the ladder fits inside
  // the claim a create is made under. Pinned against the claim's OWN constant,
  // so growing either one moves this assertion with it.
  it("the whole ladder sums to less than MINT_CLAIM_STALE_MS", () => {
    const sum = CREATION_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(CREATION_BACKOFF_MS.length).toBeGreaterThan(0);
    expect(sum).toBeLessThan(MINT_CLAIM_STALE_MS);
  });

  it("a backing-off job does not block the queue head forever: the next key still runs after it", async () => {
    const order: string[] = [];
    let attempt = 0;
    const slow = enqueueCreation("slow", async () => {
      order.push(`slow:${attempt}`);
      attempt++;
      if (attempt === 1) throw new CreationRateLimited("429");
      return "slow";
    });
    const next = enqueueCreation("next", async () => { order.push("next"); return "next"; });
    await Promise.all([slow, next]);
    // The retry is re-queued rather than held at the head, so a 32-game round
    // does not stop dead on one unlucky pairing.
    expect(order).toContain("next");
    expect(order.filter((o) => o.startsWith("slow")).length).toBe(2);
  });
});

describe("enqueueCreation — the key", () => {
  it("two concurrent enqueues of the SAME key share one run (Review Focus 2's shape)", async () => {
    let runs = 0;
    const job = async () => { runs++; await Promise.resolve(); return "once"; };
    const [a, b] = await Promise.all([
      enqueueCreation("same", job),
      enqueueCreation("same", job),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe("once");
    expect(b).toBe("once");
  });

  // Added beyond the brief: the SEQUENCE case. A second tap on a fixture whose
  // create is mid-backoff must join that create, not start a second one — the
  // key stays in flight across the retry, not just across the first attempt.
  it("the SAME key enqueued while the first is BACKING OFF joins it, not a second run", async () => {
    let runs = 0;
    const job = async () => {
      runs++;
      if (runs === 1) throw new CreationRateLimited("429");
      return `run${runs}`;
    };
    let joined: Promise<string> | null = null;
    __setCreationQueueDeps({
      now: clock.deps.now,
      sleep: async (ms: number) => {
        clock.advance(ms);
        // The first rung is only ever slept by a 429 retry: enqueue here, mid-backoff.
        if (ms === CREATION_BACKOFF_MS[0] && joined === null) joined = enqueueCreation("bk", job);
      },
    });
    const first = await enqueueCreation("bk", job);
    expect(joined, "the hook never fired — the case did not reach the backoff").not.toBeNull();
    expect(await joined!).toBe(first);
    expect(first).toBe("run2");
    expect(runs).toBe(2);
  });

  it("the SAME key enqueued again AFTER the first settled runs a second time", async () => {
    let runs = 0;
    const job = async () => { runs++; return runs; };
    expect(await enqueueCreation("seq", job)).toBe(1);
    expect(await enqueueCreation("seq", job)).toBe(2);
    expect(runs).toBe(2);
  });

  it("a shared key that REJECTS rejects both callers, and does not poison the key", async () => {
    const boom = async () => { throw new Error("boom"); };
    const [a, b] = await Promise.allSettled([
      enqueueCreation("shared", boom),
      enqueueCreation("shared", boom),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(await enqueueCreation("shared", async () => "fine")).toBe("fine");
  });

  it("different keys do not share — the empty case for dedupe", async () => {
    let runs = 0;
    const job = async () => { runs++; return runs; };
    await Promise.all([enqueueCreation("k1", job), enqueueCreation("k2", job)]);
    expect(runs).toBe(2);
  });
});
