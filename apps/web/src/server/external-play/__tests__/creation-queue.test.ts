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
});

// The module's central claim, against lila's own rules rather than against its own constants: whatever the timing,
// latency, outcomes and challengers, nothing it sends is a create lila's limiter would refuse.
//
// Final review M-6 (parked 1): one property over one challenger could not reach its claim — fast-check's default size
// keeps an array to ~12 steps, so lila's day and IP limits were never met. Now three properties, each a fixed number
// of runs: long random runs over several challengers (size "max"), and two that open with a PREFIX ending on the
// limit they are named for — a challenger's 41st create in a day, the IP's 501st create in ten minutes — then wander
// on. Each counts what it reached, per run.
type Step = { challenger: string; gapMs: number; latencyMs: number; chargeAt: number; outcome: "ok" | "error" | "429" };
type Tally = { runs: number; sent: number; minute: number; day: number; ip: number; held: number; otherWentOn: number };
const tally = (): Tally => ({ runs: 0, sent: 0, minute: 0, day: 0, ip: 0, held: 0, otherWentOn: 0 });

/** lila's apiCreate, every challenger at once: the IP limiter, then that challenger's composite user limiter (keyed
 *  lowercased, userId.scala), whose fold stops charging at its first refusal. */
function lilaLimitsByChallenger() {
  const ip = lilaRateLimit(LILA_IP_CREDITS, LILA_IP_WINDOW_MS);
  const users = new Map<string, { fast: ReturnType<typeof lilaRateLimit>; slow: ReturnType<typeof lilaRateLimit> }>();
  return (now: number, challenger: string) => {
    const id = challenger.toLowerCase();
    let u = users.get(id);
    if (!u) {
      u = { fast: lilaRateLimit(LILA_USER_FAST_CREDITS, LILA_USER_FAST_WINDOW_MS), slow: lilaRateLimit(LILA_USER_SLOW_CREDITS, LILA_USER_SLOW_WINDOW_MS) };
      users.set(id, u);
    }
    return ip(now, LILA_IP_COST) && u.fast(now, LILA_USER_COST) && u.slow(now, LILA_USER_COST);
  };
}

/** Plays `steps` through the queue from a fresh state: the creates it sent that lila would refuse, and what became of
 *  each step — sent, or refused here. */
async function playAgainstLila(steps: readonly Step[], into: Tally): Promise<{ violations: number; outcomes: ("sent" | "refused")[] }> {
  const outcomes: ("sent" | "refused")[] = [];
  __resetCreationQueue();
  t = 0;
  __setCreationQueueDeps({ now: () => t });
  const lila = lilaLimitsByChallenger();
  let violations = 0;
  /** Lowercased challengers refused here since the last send, so a send by ANOTHER counts as "went on". */
  const refused = new Set<string>();
  /** When each challenger's creates were answered (lowercased): which of its two windows refused it. */
  const answeredAt = new Map<string, number[]>();
  into.runs += 1;
  for (const step of steps) {
    t += step.gapMs;
    let ran = false;
    try {
      await enqueueCreation({ key: `p${seq++}`, challenger: step.challenger }, async () => {
        ran = true;
        const sendAt = t;
        if (!lila(sendAt + Math.floor(step.chargeAt * step.latencyMs), step.challenger)) violations++;
        into.sent++;
        if ([...refused].some((c) => c !== step.challenger.toLowerCase())) into.otherWentOn++;
        t = sendAt + step.latencyMs;
        answeredAt.set(step.challenger.toLowerCase(), [...(answeredAt.get(step.challenger.toLowerCase()) ?? []), t]);
        // A 429 here models one this process could not see coming (another machine, the player on lichess.org).
        if (step.outcome === "429") throw new CreationRateLimited({ message: "429" });
        if (step.outcome === "error") throw new Error("refused");
        return true;
      });
    } catch (err) {
      if (!ran && err instanceof CreationRateLimited) {
        outcomes.push("refused");
        refused.add(step.challenger.toLowerCase());
        if (err.reason === "ip") into.ip++;
        else if (err.reason === "lichess_429") into.held++;
        // The challenger's two windows, told apart by its own answers: a full minute is the minute's refusal.
        else if ((answeredAt.get(step.challenger.toLowerCase()) ?? []).filter((at) => at >= t - LILA_USER_FAST_WINDOW_MS).length >= PER_CHALLENGER_PER_MINUTE) into.minute++;
        else into.day++;
        continue;
      }
    }
    outcomes.push(ran ? "sent" : "refused");
  }
  return { violations, outcomes };
}

const ok = (challenger: string, gapMs: number): Step => ({ challenger, gapMs, latencyMs: 0, chargeAt: 0, outcome: "ok" });

/** A challenger's day, spent: 40 creates a minute and a second apart (never the minute's limit) from t = 0, then the
 *  41st inside the day — refused on the DAY window — then one AT the day's end (lila's edge is inclusive: still
 *  refused) and one a millisecond past it (sent). */
const DAY_41ST_AT_MS = (PER_CHALLENGER_PER_DAY - 1) * 61_000 + 1_000;
const DAY_PREFIX: readonly Step[] = [
  ...Array.from({ length: PER_CHALLENGER_PER_DAY }, (_, i) => ok("day-w", i === 0 ? 0 : 61_000)),
  ok("day-w", 1_000),
  ok("day-w", LILA_USER_SLOW_WINDOW_MS - DAY_41ST_AT_MS),
  ok("day-w", 1),
];
/** The IP's ten minutes, spent at t = 0: 500 creates by 100 challengers, five each (never a challenger's limit), then
 *  a fresh challenger's create — refused on the IP window — then one AT the window's end (refused) and one a
 *  millisecond past it (sent). */
const IP_PREFIX: readonly Step[] = [
  ...Array.from({ length: PER_IP }, (_, i) => ok(`ip-w${i % (PER_IP / PER_CHALLENGER_PER_MINUTE)}`, 0)),
  ok("ip-fresh", 0),
  ok("ip-fresh", LILA_IP_WINDOW_MS),
  ok("ip-fresh", 1),
];

/** One step of a wander: bursts, ordinary gaps, the minute's own edges — a uniform gap almost never lands a create on
 *  the edge that matters — and the IP's and the day's windows, which clear what came before. */
const stepArb = (challengers: readonly string[]): fc.Arbitrary<Step> =>
  fc.record({
    challenger: fc.constantFrom(...challengers),
    gapMs: fc.oneof(
      { arbitrary: fc.constantFrom(0, 50_000, 59_999, 60_000, 60_001), weight: 3 },
      { arbitrary: fc.integer({ min: 0, max: 2_000 }), weight: 3 },
      { arbitrary: fc.integer({ min: 0, max: 70_000 }), weight: 2 },
      { arbitrary: fc.constantFrom(LILA_IP_WINDOW_MS, LILA_IP_WINDOW_MS + 1), weight: 1 },
      { arbitrary: fc.constantFrom(LILA_USER_SLOW_WINDOW_MS, LILA_USER_SLOW_WINDOW_MS + 1), weight: 1 },
    ),
    // The round trip, inside LICHESS_TIMEOUT_MS; lila charges somewhere inside it, and this module stamps at its
    // end. The extremes are where an early stamp opens a window early.
    latencyMs: fc.oneof(
      { arbitrary: fc.constantFrom(0, 10_000), weight: 2 },
      { arbitrary: fc.integer({ min: 0, max: 10_000 }), weight: 1 },
    ),
    chargeAt: fc.oneof(
      { arbitrary: fc.constantFrom(0, 1), weight: 2 },
      { arbitrary: fc.double({ min: 0, max: 1, noNaN: true }), weight: 1 },
    ),
    // Mostly accepted: a 429 holds the challenger a minute, and a run full of holds never reaches a window.
    outcome: fc.oneof(
      { arbitrary: fc.constant("ok" as const), weight: 8 },
      { arbitrary: fc.constant("error" as const), weight: 1 },
      { arbitrary: fc.constant("429" as const), weight: 1 },
    ),
  });

describe("property: never sends a create lila's limiter would refuse (fast-check against RateLimit.scala)", () => {
  // `w1` and `W1` are one challenger as lila keys it.
  const POOL = ["w0", "w1", "W1", "w2"];
  const RANDOM_RUNS = 400;
  const PREFIX_RUNS = 40;

  it(`random runs over ${POOL.length} challenger names, up to 120 steps each: every window but the day's and the IP's is met, and one challenger's refusal holds up nobody else`, async () => {
    const seen = tally();
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb(POOL), { minLength: 1, maxLength: 120, size: "max" }), async (steps) => {
        expect((await playAgainstLila(steps, seen)).violations).toBe(0);
      }),
      { numRuns: RANDOM_RUNS, seed: 20261009 },
    );
    // Anti-vacuity: the runs SENT creates, were REFUSED on the minute's window (not only on a 429 hold), held after
    // a 429, and let ANOTHER challenger go on after a refusal.
    expect(seen.runs, "fast-check ran every run").toBe(RANDOM_RUNS);
    expect(seen.sent).toBeGreaterThan(0);
    expect(seen.minute, "the minute's window refused").toBeGreaterThan(0);
    expect(seen.held, "a 429 held its challenger").toBeGreaterThan(0);
    expect(seen.otherWentOn, "another challenger sent after one was refused").toBeGreaterThan(0);
  });

  it(`a challenger's DAY spent, then a wander: the 41st create of the day, and the day's last millisecond, are refused in every run (${PREFIX_RUNS} runs)`, async () => {
    const seen = tally();
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb([...POOL, "day-w"]), { minLength: 1, maxLength: 60, size: "max" }), async (tail) => {
        const day = seen.day;
        const played = await playAgainstLila([...DAY_PREFIX, ...tail], seen);
        expect(played.violations).toBe(0);
        expect(played.outcomes.slice(0, DAY_PREFIX.length), "the day's 40 sent, the 41st and the end refused, one past sent").toEqual([
          ...Array<"sent">(PER_CHALLENGER_PER_DAY).fill("sent"), "refused", "refused", "sent",
        ]);
        expect(seen.day - day, "both refusals were the day's").toBeGreaterThanOrEqual(2);
      }),
      { numRuns: PREFIX_RUNS, seed: 20261014 },
    );
    expect(seen.runs).toBe(PREFIX_RUNS);
    expect(seen.day, "two day refusals per run, at least").toBeGreaterThanOrEqual(2 * PREFIX_RUNS);
  });

  it(`the IP's ten minutes spent by 100 challengers, then a wander: the 501st create, and the window's last millisecond, are refused in every run (${PREFIX_RUNS} runs)`, async () => {
    const seen = tally();
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb([...POOL, "ip-w0", "ip-fresh"]), { minLength: 1, maxLength: 60, size: "max" }), async (tail) => {
        const ip = seen.ip;
        const played = await playAgainstLila([...IP_PREFIX, ...tail], seen);
        expect(played.violations).toBe(0);
        expect(played.outcomes.slice(0, IP_PREFIX.length), "the 500 sent, the 501st and the end refused, one past sent").toEqual([
          ...Array<"sent">(PER_IP).fill("sent"), "refused", "refused", "sent",
        ]);
        expect(seen.ip - ip, "both refusals were the IP's").toBeGreaterThanOrEqual(2);
      }),
      { numRuns: PREFIX_RUNS, seed: 20261015 },
    );
    expect(seen.runs).toBe(PREFIX_RUNS);
    expect(seen.ip, "two IP refusals per run, at least").toBeGreaterThanOrEqual(2 * PREFIX_RUNS);
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
