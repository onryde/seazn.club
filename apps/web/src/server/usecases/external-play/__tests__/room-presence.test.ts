// T14 review I8 — the room's RealtimeKit presence calls must not scale with
// room reads. Every player polls GET room (every 3 s without a realtime
// channel, every 15 s with one) and each read used to cost the vendor two
// calls (active session + participants, realtimekit.ts hasLiveVideoPublisher).
// Cloudflare counts RealtimeKit calls toward the account token's GLOBAL API
// limit — 1,200 requests per 5 minutes, and over it EVERY API call is refused
// for the next 5 minutes (developers.cloudflare.com/fundamentals/api/reference/limits,
// /realtime/realtimekit/limits, read 2026-10-12). Seats, meeting creation and
// teardown share that token.
//
// So: one answer per (meeting, participant) per TTL, concurrent readers share
// one in-flight call, and a per-instance sliding-window budget makes the
// worst case a fixed number — independent of boards, players and reads. When
// the budget is spent a recent answer is served, and an old or absent one is
// "unknown" (no pill — review I4), never a guess.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IDLE_POLL_MS, LIVE_POLL_MS } from "@/components/public-site/match-room/use-room";
import {
  PRESENCE_BUDGET,
  PRESENCE_CALLS_PER_ASK,
  PRESENCE_STALE_MS,
  PRESENCE_TTL_MS,
  presenceCache,
} from "../room-presence";

const T0 = 1_760_000_000_000;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("presenceCache", () => {
  it("the empty case: the first read of a key asks once and answers what the vendor said", async () => {
    const c = presenceCache();
    const ask = vi.fn(async () => true);
    expect(await c.get("m1:p1", T0, ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("N concurrent reads of one key make ONE vendor call, and every reader gets its answer; another key asks for itself", async () => {
    const c = presenceCache();
    const gate = deferred<boolean | null>();
    const ask = vi.fn(() => gate.promise);
    const N = 25;
    const reads = Array.from({ length: N }, () => c.get("m1:p1", T0, ask));
    const other = vi.fn(async () => false);
    const theirs = c.get("m1:p2", T0, other);
    expect(ask, "one call in flight for the key").toHaveBeenCalledTimes(1);
    gate.resolve(true);
    const got = await Promise.all(reads);
    expect(got.length, "anti-vacuity: readers").toBe(N);
    expect(new Set(got)).toEqual(new Set([true]));
    expect(await theirs).toBe(false);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("within the TTL nothing is asked; at the TTL it asks again (both sides of the edge)", async () => {
    const c = presenceCache();
    const ask = vi.fn(async () => true);
    await c.get("k", T0, ask);
    await c.get("k", T0 + PRESENCE_TTL_MS - 1, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    await c.get("k", T0 + PRESENCE_TTL_MS, ask);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("an unknown answer (the vendor did not answer ⇒ null) is cached like any other — an outage is not hammered", async () => {
    const c = presenceCache();
    const ask = vi.fn(async () => null);
    expect(await c.get("k", T0, ask)).toBeNull();
    expect(await c.get("k", T0 + 1_000, ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a call that THROWS (not a vendor answer) propagates, is not cached, and leaves no call stuck in flight", async () => {
    const c = presenceCache();
    const boom = vi.fn(async () => {
      throw new Error("db gone");
    });
    await expect(c.get("k", T0, boom)).rejects.toThrow("db gone");
    const ask = vi.fn(async () => true);
    expect(await c.get("k", T0 + 1, ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("the TTL is at least the room's poll interval (both cadences): a poll never re-asks the vendor by itself", () => {
    expect(PRESENCE_TTL_MS).toBeGreaterThanOrEqual(LIVE_POLL_MS);
    expect(PRESENCE_TTL_MS).toBeGreaterThanOrEqual(IDLE_POLL_MS);
    expect(PRESENCE_STALE_MS).toBeGreaterThan(PRESENCE_TTL_MS);
  });

  it("the budget: a big round polled flat out for 30 minutes never spends more than the budget in ANY 5-minute window; when spent, a recent answer is served, an old or absent one is unknown — and nothing is asked", async () => {
    const c = presenceCache();
    const asks: number[] = [];
    let denied = 0;
    let servedStale = 0;
    let unknown = 0;
    let reads = 0;
    let maxGap = 0;
    // 50 boards × 2 players = 100 keys, every key read every 3 s (the
    // fastest poll), for 30 minutes.
    const keys = Array.from({ length: 100 }, (_, i) => `m${Math.floor(i / 2)}:p${i}`);
    const lastAnswerAt = new Map<string, number>();
    for (let t = T0; t < T0 + 30 * 60_000; t += LIVE_POLL_MS) {
      for (const k of keys) {
        let asked = false;
        const v = await c.get(k, t, async () => {
          asked = true;
          asks.push(t);
          return true;
        });
        reads += 1;
        if (asked) {
          const prev = lastAnswerAt.get(k);
          if (prev !== undefined) maxGap = Math.max(maxGap, t - prev);
          lastAnswerAt.set(k, t);
          continue;
        }
        const at = lastAnswerAt.get(k);
        if (at !== undefined && t - at < PRESENCE_TTL_MS) continue; // a fresh hit
        denied += 1;
        if (at !== undefined && t - at < PRESENCE_STALE_MS) {
          expect(v, "a recent answer is served while the budget is spent").toBe(true);
          servedStale += 1;
        } else {
          expect(v, "an old or absent answer is unknown, never a guess").toBeNull();
          unknown += 1;
        }
      }
    }
    // Every sliding 5-minute window, at every ask.
    let windows = 0;
    for (const start of asks) {
      const inWindow = asks.filter((a) => a >= start && a < start + PRESENCE_BUDGET.windowMs).length;
      expect(inWindow * PRESENCE_CALLS_PER_ASK, `window at +${start - T0} ms`).toBeLessThanOrEqual(PRESENCE_BUDGET.calls);
      windows += 1;
    }
    expect(reads, "anti-vacuity: reads").toBe(100 * 600);
    expect(windows, "anti-vacuity: windows checked").toBeGreaterThan(50);
    expect(denied, "the budget was actually reached").toBeGreaterThan(1_000);
    expect(servedStale, "stale answers were served").toBeGreaterThan(0);
    expect(unknown, "unknown answers were given").toBeGreaterThan(0);
    // Shared out, not won by whoever reads first: every key was answered, and
    // none waits more than twice its fair share of the budget between asks
    // (100 keys over 50 asks per window ⇒ one ask per key per 2 windows).
    expect(lastAnswerAt.size, "every board's players got an answer").toBe(100);
    const fairShare = (100 * PRESENCE_BUDGET.windowMs) / (PRESENCE_BUDGET.calls / PRESENCE_CALLS_PER_ASK);
    expect(maxGap, "no key starves").toBeGreaterThan(0);
    expect(maxGap).toBeLessThanOrEqual(2 * fairShare);
    // Without the budget the same round would have asked once per key per TTL.
    expect(asks.length).toBeLessThan((100 * 30 * 60_000) / PRESENCE_TTL_MS / 10);
  });

  it("a round that shrinks gets the TTL cadence back: keys nobody reads any more stop counting toward the share", async () => {
    const c = presenceCache();
    const ask = vi.fn(async () => true);
    // 100 keys read once (most boards finish), then one board plays on.
    for (let i = 0; i < 100; i += 1) await c.get(`k${i}`, T0, ask);
    const start = T0 + PRESENCE_BUDGET.windowMs; // the opening burst has left the window
    const before = ask.mock.calls.length;
    for (let t = start; t < start + PRESENCE_BUDGET.windowMs; t += LIVE_POLL_MS) await c.get("k0", t, ask);
    const asked = ask.mock.calls.length - before;
    // Alone, k0 is asked once per TTL across the window (and no more).
    expect(asked).toBe(PRESENCE_BUDGET.windowMs / PRESENCE_TTL_MS);
  });

  it("the worst case is a fixed number well under Cloudflare's 1,200 per 5 minutes: the budget times the production machine ceiling leaves three quarters for seats, meetings and teardown", () => {
    // fly.toml states the production ceiling as a `fly scale count` (it has
    // no max_machines key); every machine keeps its own cache and budget.
    const fly = readFileSync(join(__dirname, "../../../../../../../fly.toml"), "utf8");
    const machines = Number(/fly scale count (\d+)/.exec(fly)?.[1]);
    expect(machines, "premise: fly.toml states its machine ceiling").toBeGreaterThan(0);
    const CLOUDFLARE_API_LIMIT_PER_5_MIN = 1_200;
    expect(PRESENCE_BUDGET.windowMs).toBe(5 * 60_000);
    expect(PRESENCE_BUDGET.calls * machines).toBeLessThanOrEqual(CLOUDFLARE_API_LIMIT_PER_5_MIN / 4);
    // hasLiveVideoPublisher's own cost: the active session, then the participants.
    expect(PRESENCE_CALLS_PER_ASK).toBe(2);
  });
});
