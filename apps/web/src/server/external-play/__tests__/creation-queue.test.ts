// The creation limits, as lila states them. Source, not measurement — read
// 2026-10-09 at lichess-org/lila eab1e3ac2:
//   modules/web/src/main/Limiters.scala
//     challengeUser = RateLimit.composite[UserId]("challenge.create.user")(
//       ("fast", 5 * 5, 1.minute), ("slow", 40 * 5, 1.day))
//     challenge     = RateLimit[IpAddress](500, 10.minute, "challenge.create.ip")
//   app/controllers/Challenge.scala, apiCreate
//     the IP limiter charges 1; the user limiter charges 5 for a create to a
//     human who does not follow the challenger (0 if they do).
//   modules/memo/src/main/RateLimit.scala
//     a window opens at the first charge (clearAt = first + duration); a charge
//     is refused while count >= credits AND now <= clearAt.
//   modules/core/src/main/userId.scala
//     UserIdOf[UserStr] = n => UserId(n.value.toLowerCase)
// The v1 battery agrees: five creates landed, the sixth 429'd (M3 as corrected
// by the Task 3-5 review). Every expected number below comes from these
// constants, never from creation-queue.ts.
//
// Replaces round 0's "<4 creates/s" ceiling, which no log showed (T4-I1).
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATION_429_HOLD_MS,
  CREATION_PER_CHALLENGER,
  CREATION_PER_IP,
  CreationRateLimited,
  __creationQueueTracked,
  __resetCreationQueue,
  __setCreationQueueDeps,
  enqueueCreation,
} from "../creation-queue";

const LILA_USER_FAST_CREDITS = 5 * 5;
const LILA_USER_SLOW_CREDITS = 40 * 5;
const LILA_USER_COST = 5;
const LILA_USER_FAST_WINDOW_MS = 60_000;
const LILA_USER_SLOW_WINDOW_MS = 24 * 60 * 60_000;
const LILA_IP_CREDITS = 500;
const LILA_IP_COST = 1;
const LILA_IP_WINDOW_MS = 10 * 60_000;
/** lichess-org/api doc/specs/lichess-api.yaml at 906d1a6e9, "Rate limiting":
 *  "In most cases, waiting one minute before retrying will be sufficient". */
const LICHESS_DOCS_429_WAIT_MS = 60_000;

const PER_CHALLENGER_PER_MINUTE = LILA_USER_FAST_CREDITS / LILA_USER_COST; // 5
const PER_CHALLENGER_PER_DAY = LILA_USER_SLOW_CREDITS / LILA_USER_COST; // 40
const PER_IP = LILA_IP_CREDITS / LILA_IP_COST; // 500

/** A transcription of lila's RateLimit.apply, for the property below. Where
 *  lila's behaviour depends on Caffeine's expiry edge (expireAfterWrite), the
 *  STRICTER reading is taken (an entry lives until strictly past `duration`
 *  since its last write), so passing against this model passes against both. */
function lilaRateLimit(credits: number, durationMs: number) {
  let entry: { count: number; clearAt: number; writtenAt: number } | null = null;
  return (now: number, cost: number): boolean => {
    if (entry && now - entry.writtenAt > durationMs) entry = null;
    if (entry === null) {
      entry = { count: cost, clearAt: now + durationMs, writtenAt: now };
      return true;
    }
    if (entry.count < credits) {
      entry = { count: entry.count + cost, clearAt: entry.clearAt, writtenAt: now };
      return true;
    }
    if (now > entry.clearAt) {
      entry = { count: cost, clearAt: now + durationMs, writtenAt: now };
      return true;
    }
    return false;
  };
}

/** lila's apiCreate order: the IP limiter, then the composite user limiter,
 *  whose fold stops charging at its first refusal. */
function lilaCreateLimits() {
  const ip = lilaRateLimit(LILA_IP_CREDITS, LILA_IP_WINDOW_MS);
  const fast = lilaRateLimit(LILA_USER_FAST_CREDITS, LILA_USER_FAST_WINDOW_MS);
  const slow = lilaRateLimit(LILA_USER_SLOW_CREDITS, LILA_USER_SLOW_WINDOW_MS);
  return (now: number) =>
    ip(now, LILA_IP_COST) && fast(now, LILA_USER_COST) && slow(now, LILA_USER_COST);
}

/** A virtual clock: nothing in the module sleeps, so time moves only when a
 *  test moves it. */
let t = 0;
let seq = 0;
const sent: Array<{ challenger: string; at: number }> = [];

beforeEach(() => {
  __resetCreationQueue();
  t = 0;
  sent.length = 0;
  __setCreationQueueDeps({ now: () => t });
});
afterEach(() => {
  __resetCreationQueue();
});

/** One create through the queue. `outcome` is what Lichess "answers". */
function create(challenger: string, outcome: "ok" | "429" | "error" = "ok", key = `fx${seq++}`) {
  return enqueueCreation({ key, challenger }, async () => {
    sent.push({ challenger, at: t });
    if (outcome === "429") throw new CreationRateLimited({ message: "429" });
    if (outcome === "error") throw new Error("no such user");
    return `created:${key}`;
  });
}
const sentBy = (challenger: string) => sent.filter((s) => s.challenger === challenger).length;

describe("the limits are lila's own numbers", () => {
  it("per challenger 5 a minute and 40 a day, per IP 500 per 10 minutes", () => {
    expect(CREATION_PER_CHALLENGER).toEqual([
      { max: PER_CHALLENGER_PER_MINUTE, windowMs: LILA_USER_FAST_WINDOW_MS },
      { max: PER_CHALLENGER_PER_DAY, windowMs: LILA_USER_SLOW_WINDOW_MS },
    ]);
    expect(CREATION_PER_IP).toEqual([{ max: PER_IP, windowMs: LILA_IP_WINDOW_MS }]);
  });

  it("a 429 holds for at least the minute Lichess asks for, and at least lila's user window", () => {
    expect(CREATION_429_HOLD_MS).toBeGreaterThanOrEqual(LICHESS_DOCS_429_WAIT_MS);
    expect(CREATION_429_HOLD_MS).toBeGreaterThanOrEqual(LILA_USER_FAST_WINDOW_MS);
  });
});

describe("enqueueCreation — one request at a time (Lichess API docs: 'Only make one request at a time')", () => {
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
    const results = await Promise.all(keys.map((k) =>
      enqueueCreation({ key: k, challenger: `white-${k}` }, job(k))));
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
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      enqueueCreation({ key: `k${i}`, challenger: `w${i}` }, job())));
    expect(maxInFlight).toBe(1);
  });

  it("a failing job does not stall the queue — the next one still runs", async () => {
    await expect(create("w-bad", "error")).rejects.toThrow("no such user");
    await expect(create("w-good")).resolves.toMatch(/^created:/);
    expect(sent.map((s) => s.challenger)).toEqual(["w-bad", "w-good"]);
  });
});

describe("per challenger — lila's challenge.create.user", () => {
  it("a 32-board round — one create per White — sends every create, with no wait at all", async () => {
    const whites = Array.from({ length: 32 }, (_, i) => `white${i}`);
    const out = await Promise.allSettled(whites.map((w) => create(w)));
    expect(out.filter((o) => o.status === "fulfilled").length).toBe(32);
    expect(sent.length).toBe(32);
    // Nothing spaced and nothing slept: queue wait is claim time (§3.3).
    expect(t).toBe(0);
  });

  it("the sixth create by ONE challenger inside the minute is refused here, and no request leaves", async () => {
    for (let i = 0; i < PER_CHALLENGER_PER_MINUTE; i++) await create("w1");
    expect(sentBy("w1")).toBe(PER_CHALLENGER_PER_MINUTE);
    const sixth = create("w1");
    await expect(sixth).rejects.toBeInstanceOf(CreationRateLimited);
    // lila refuses while now <= clearAt (first charge + 1 minute), so the
    // first instant it would take this one is one ms after that.
    await expect(sixth).rejects.toMatchObject({
      reason: "challenger", retryAt: 0 + LILA_USER_FAST_WINDOW_MS + 1,
    });
    expect(sentBy("w1"), "a refused create still reached Lichess").toBe(PER_CHALLENGER_PER_MINUTE);
  });

  it("the window edge is lila's: refused AT first + 1 minute, sent one ms later", async () => {
    for (let i = 0; i < PER_CHALLENGER_PER_MINUTE; i++) await create("w1");
    t = LILA_USER_FAST_WINDOW_MS;
    await expect(create("w1")).rejects.toMatchObject({ reason: "challenger" });
    t = LILA_USER_FAST_WINDOW_MS + 1;
    await expect(create("w1")).resolves.toMatch(/^created:/);
    expect(sentBy("w1")).toBe(PER_CHALLENGER_PER_MINUTE + 1);
  });

  // Added for the mutation sweep (M4b survived round one of it): lila charges
  // when the request ARRIVES, which can be as late as the response. A stamp
  // taken at SEND opens the window up to one round trip early.
  it("a create is stamped when its response is back — a slow first response does not open the window early", async () => {
    const SLOW_MS = 10_000; // LICHESS_TIMEOUT_MS: the longest a response can take
    await enqueueCreation({ key: "slow-first", challenger: "w-slow" }, async () => {
      sent.push({ challenger: "w-slow", at: t });
      t += SLOW_MS; // lila may charge this one as late as t = SLOW_MS
      return "created";
    });
    for (let i = 1; i < PER_CHALLENGER_PER_MINUTE; i++) await create("w-slow");
    // lila's window opened no later than SLOW_MS, so it refuses until
    // SLOW_MS + 1 minute inclusive.
    t = LILA_USER_FAST_WINDOW_MS + 1;
    await expect(create("w-slow")).rejects.toMatchObject({
      reason: "challenger", retryAt: SLOW_MS + LILA_USER_FAST_WINDOW_MS + 1,
    });
    expect(sentBy("w-slow")).toBe(PER_CHALLENGER_PER_MINUTE);
  });

  it("40 creates a day, spaced past the minute, all go; the 41st is refused until the day is out", async () => {
    for (let i = 0; i < PER_CHALLENGER_PER_DAY; i++) {
      t = i * (LILA_USER_FAST_WINDOW_MS + 1);
      await create("w-day");
    }
    expect(sentBy("w-day")).toBe(PER_CHALLENGER_PER_DAY);
    t = PER_CHALLENGER_PER_DAY * (LILA_USER_FAST_WINDOW_MS + 1);
    await expect(create("w-day")).rejects.toMatchObject({
      reason: "challenger", retryAt: 0 + LILA_USER_SLOW_WINDOW_MS + 1,
    });
    t = LILA_USER_SLOW_WINDOW_MS + 1;
    await expect(create("w-day")).resolves.toMatch(/^created:/);
  });

  it("one exhausted challenger holds up nobody else", async () => {
    for (let i = 0; i < PER_CHALLENGER_PER_MINUTE; i++) await create("w1");
    await expect(create("w1")).rejects.toBeInstanceOf(CreationRateLimited);
    await expect(create("w2")).resolves.toMatch(/^created:/);
    expect(sentBy("w2")).toBe(1);
  });

  it("the challenger is keyed the way lila keys it — lowercased", async () => {
    const spellings = ["Ada", "ADA", "ada", "aDa", "AdA"];
    expect(spellings.length).toBe(PER_CHALLENGER_PER_MINUTE);
    for (const s of spellings) await create(s);
    await expect(create("ada")).rejects.toMatchObject({ reason: "challenger" });
    await expect(create("ADA")).rejects.toMatchObject({ reason: "challenger" });
  });

  it("every attempt is charged, whatever Lichess answered — the safe side of lila's rules", async () => {
    // lila does not charge a create that fails form validation; this module
    // cannot tell those apart, so it charges every attempt it sends.
    for (let i = 0; i < PER_CHALLENGER_PER_MINUTE; i++) {
      await expect(create("w-err", "error")).rejects.toThrow("no such user");
    }
    expect(sentBy("w-err")).toBe(PER_CHALLENGER_PER_MINUTE);
    await expect(create("w-err")).rejects.toMatchObject({ reason: "challenger" });
  });

  it("an empty challenger is refused before anything is sent — it would pool every create into one bucket", async () => {
    let checked = 0;
    for (const challenger of ["", "   "]) {
      await expect(create(challenger), JSON.stringify(challenger)).rejects.toThrow(/challenger/);
      checked++;
    }
    expect(checked).toBe(2);
    expect(sent.length).toBe(0);
  });

  // The module's central claim, against lila's own rules rather than against
  // its own constants: whatever the timing, latency and outcomes, nothing it
  // sends is a create lila's limiter would refuse.
  it("never sends a create lila's limiter would refuse (fast-check against RateLimit.scala)", async () => {
    let totalSent = 0;
    let totalRefusedHere = 0;
    let totalWindowRefusals = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            // Bursts, ordinary gaps, and the minute's own edges — a uniform
            // gap almost never lands a sixth create on the edge that matters.
            gapMs: fc.oneof(
              { arbitrary: fc.constantFrom(0, 50_000, 59_999, 60_000, 60_001), weight: 3 },
              { arbitrary: fc.integer({ min: 0, max: 2_000 }), weight: 3 },
              { arbitrary: fc.integer({ min: 0, max: 70_000 }), weight: 2 },
            ),
            // The round trip, inside LICHESS_TIMEOUT_MS; lila charges somewhere
            // inside it, and this module stamps at its end. The extremes are
            // where an early stamp opens a window early.
            latencyMs: fc.oneof(
              { arbitrary: fc.constantFrom(0, 10_000), weight: 2 },
              { arbitrary: fc.integer({ min: 0, max: 10_000 }), weight: 1 },
            ),
            chargeAt: fc.oneof(
              { arbitrary: fc.constantFrom(0, 1), weight: 2 },
              { arbitrary: fc.double({ min: 0, max: 1, noNaN: true }), weight: 1 },
            ),
            // Mostly accepted: a 429 holds the challenger a minute, and a run
            // full of holds never reaches the window it is meant to probe.
            outcome: fc.oneof(
              { arbitrary: fc.constant("ok" as const), weight: 8 },
              { arbitrary: fc.constant("error" as const), weight: 1 },
              { arbitrary: fc.constant("429" as const), weight: 1 },
            ),
          }),
          { minLength: 1, maxLength: 80 },
        ),
        async (steps) => {
          __resetCreationQueue();
          t = 0;
          __setCreationQueueDeps({ now: () => t });
          const lila = lilaCreateLimits();
          // Per run, so a shrink replays from zero.
          let violations = 0;
          for (const step of steps) {
            t += step.gapMs;
            let ran = false;
            try {
              await enqueueCreation({ key: `p${seq++}`, challenger: "solo" }, async () => {
                ran = true;
                const sendAt = t;
                if (!lila(sendAt + Math.floor(step.chargeAt * step.latencyMs))) violations++;
                totalSent++;
                t = sendAt + step.latencyMs;
                // A 429 here models one this process could not see coming
                // (another machine, the player on lichess.org).
                if (step.outcome === "429") throw new CreationRateLimited({ message: "429" });
                if (step.outcome === "error") throw new Error("refused");
                return true;
              });
            } catch (err) {
              if (!ran) {
                totalRefusedHere++;
                if (err instanceof CreationRateLimited && err.reason === "challenger") totalWindowRefusals++;
              }
            }
          }
          expect(violations).toBe(0);
        },
      ),
      { numRuns: 1000, seed: 20261009 },
    );
    // Anti-vacuity: the property must have SENT creates, REFUSED some, and
    // refused some on the WINDOW (not only on a 429 hold), or it proved
    // nothing about the limit it is named for.
    expect(totalSent).toBeGreaterThan(0);
    expect(totalRefusedHere).toBeGreaterThan(0);
    expect(totalWindowRefusals).toBeGreaterThan(0);
  });
});

describe("per IP — lila's challenge.create.ip", () => {
  it("500 creates in ten minutes go out; the 501st is refused here, whoever's it is", async () => {
    for (let i = 0; i < PER_IP; i++) await create(`ip-white${i}`);
    expect(sent.length).toBe(PER_IP);
    await expect(create("a-fresh-white")).rejects.toMatchObject({
      reason: "ip", retryAt: 0 + LILA_IP_WINDOW_MS + 1,
    });
    t = LILA_IP_WINDOW_MS;
    await expect(create("a-fresh-white")).rejects.toMatchObject({ reason: "ip" });
    t = LILA_IP_WINDOW_MS + 1;
    await expect(create("a-fresh-white")).resolves.toMatch(/^created:/);
    expect(sent.length).toBe(PER_IP + 1);
  });
});

describe("two limits at once", () => {
  // Added for the mutation sweep: nothing else made two limits refuse the same
  // create, so "which retryAt binds" was untested. A retry at the EARLIER of
  // the two would only be refused again.
  it("the LATER retryAt binds — the per-IP window's end, not the challenger's", async () => {
    for (let i = 0; i < PER_CHALLENGER_PER_MINUTE; i++) await create("w-both");
    for (let i = 0; i < PER_IP - PER_CHALLENGER_PER_MINUTE; i++) await create(`fill${i}`);
    expect(sent.length).toBe(PER_IP);
    await expect(create("w-both")).rejects.toMatchObject({
      reason: "ip", retryAt: 0 + LILA_IP_WINDOW_MS + 1,
    });
  });
});

describe("memory — a long-lived process forgets what no window can still see", () => {
  it("drops IP stamps after ten minutes, and a challenger only after the day", async () => {
    const whites = Array.from({ length: 50 }, (_, i) => `mem${i}`);
    for (const w of whites) await create(w);
    expect(__creationQueueTracked()).toEqual({ challengers: 50, ipStamps: 50 });
    t = LILA_IP_WINDOW_MS + 1;
    await create("late1");
    // The IP window no longer sees the first 50; the day window still does.
    expect(__creationQueueTracked()).toEqual({ challengers: 51, ipStamps: 1 });
    t = LILA_USER_SLOW_WINDOW_MS + 1;
    await create("late2");
    expect(__creationQueueTracked()).toEqual({ challengers: 2, ipStamps: 1 });
  });
});

describe("a 429 from Lichess", () => {
  it("comes back at once — never retried here, never slept on inside a claim", async () => {
    t = 1_000;
    const out = create("w429", "429");
    await expect(out).rejects.toBeInstanceOf(CreationRateLimited);
    await expect(out).rejects.toMatchObject({ reason: "lichess_429" });
    expect(sentBy("w429")).toBe(1);
    expect(t).toBe(1_000);
  });

  it("holds THAT challenger a full minute: nothing of theirs leaves before it", async () => {
    t = 1_000;
    const err = await create("w429", "429").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreationRateLimited);
    const retryAt = (err as CreationRateLimited).retryAt;
    expect(retryAt).not.toBeNull();
    expect(retryAt!).toBeGreaterThanOrEqual(1_000 + LICHESS_DOCS_429_WAIT_MS);
    t = 1_000 + LICHESS_DOCS_429_WAIT_MS - 1;
    await expect(create("w429")).rejects.toMatchObject({ reason: "lichess_429", retryAt });
    expect(sentBy("w429"), "a held create reached Lichess").toBe(1);
    t = retryAt!;
    await expect(create("w429")).resolves.toMatch(/^created:/);
    expect(sentBy("w429")).toBe(2);
  });

  it("holds nobody else: another White's create goes straight out", async () => {
    await expect(create("w429", "429")).rejects.toBeInstanceOf(CreationRateLimited);
    await expect(create("w-other")).resolves.toMatch(/^created:/);
    expect(t).toBe(0);
  });

  it("a NON-429 failure is not retried and holds nothing — a bad username must not be hammered", async () => {
    await expect(create("w-nr", "error")).rejects.toThrow("no such user");
    expect(sentBy("w-nr")).toBe(1);
    await expect(create("w-nr")).resolves.toMatch(/^created:/);
    expect(sentBy("w-nr")).toBe(2);
  });
});

describe("enqueueCreation — the key", () => {
  it("two concurrent enqueues of the SAME key share one run (Review Focus 2's shape)", async () => {
    let runs = 0;
    const job = async () => { runs++; await Promise.resolve(); return "once"; };
    const [a, b] = await Promise.all([
      enqueueCreation({ key: "same", challenger: "w" }, job),
      enqueueCreation({ key: "same", challenger: "w" }, job),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe("once");
    expect(b).toBe("once");
  });

  it("the SAME key enqueued again AFTER the first settled runs a second time", async () => {
    let runs = 0;
    const job = async () => { runs++; return runs; };
    expect(await enqueueCreation({ key: "seq", challenger: "w" }, job)).toBe(1);
    expect(await enqueueCreation({ key: "seq", challenger: "w" }, job)).toBe(2);
    expect(runs).toBe(2);
  });

  it("a shared key that REJECTS rejects both callers, and does not poison the key", async () => {
    const boom = async () => { throw new Error("boom"); };
    const [a, b] = await Promise.allSettled([
      enqueueCreation({ key: "shared", challenger: "w" }, boom),
      enqueueCreation({ key: "shared", challenger: "w" }, boom),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(await enqueueCreation({ key: "shared", challenger: "w" }, async () => "fine")).toBe("fine");
  });

  it("a key REFUSED by a limit is not poisoned: the same fixture is sent once the window opens", async () => {
    for (let i = 0; i < PER_CHALLENGER_PER_MINUTE; i++) await create("w-key");
    await expect(create("w-key", "ok", "fixture-9")).rejects.toMatchObject({ reason: "challenger" });
    t = LILA_USER_FAST_WINDOW_MS + 1;
    await expect(create("w-key", "ok", "fixture-9")).resolves.toBe("created:fixture-9");
  });

  it("different keys do not share — the empty case for dedupe", async () => {
    let runs = 0;
    const job = async () => { runs++; return runs; };
    await Promise.all([
      enqueueCreation({ key: "k1", challenger: "w1" }, job),
      enqueueCreation({ key: "k2", challenger: "w2" }, job),
    ]);
    expect(runs).toBe(2);
  });
});
