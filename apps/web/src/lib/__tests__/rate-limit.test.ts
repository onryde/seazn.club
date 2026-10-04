// Unit coverage for the Upstash-only rate limiter (lib/rate-limit.ts): under
// the cap passes, over the cap throws 429, and when Redis is unavailable
// (incrWindow → null) the failClosed policy decides deny-vs-allow. No DB: the
// Postgres fallback was removed, so incrWindow is the only backend and we mock
// it directly.
//
// W1, 2026-09-21: a second group at the bottom drives the limiter through
// `__setRateLimitCounterForTests` instead of the incrWindow mock. The two
// groups exercise DIFFERENT seams and neither replaces the other — the mock
// proves the production backend is wired and the failClosed policy holds; the
// injector proves counting BEHAVIOUR runs at all, which is what Task 3's
// limiter-placement test depends on.
import { afterEach, describe, expect, it, vi } from "vitest";

const cacheMock = vi.hoisted(() => ({ incrWindow: vi.fn(), peekWindow: vi.fn(), cacheEnabled: vi.fn(() => true) }));
vi.mock("@/lib/cache", () => ({
  incrWindow: cacheMock.incrWindow,
  peekWindow: cacheMock.peekWindow,
  cacheEnabled: cacheMock.cacheEnabled,
}));

import { HttpError } from "@/lib/errors";
import {
  rateLimit,
  rateLimitPeek,
  AUTH_LIMIT,
  EMAIL_LIMIT,
  WEBHOOK_LIMIT,
  MUTATION_LIMIT,
  CAPTURE_CODE_LIMIT,
  CAPTURE_FAIL_LIMIT,
  CAPTURE_START_LIMIT,
  __setRateLimitCounterForTests,
} from "@/lib/rate-limit";

const CFG = { max: 3, windowSeconds: 60 };

afterEach(() => {
  cacheMock.incrWindow.mockReset();
  cacheMock.peekWindow.mockReset();
  cacheMock.cacheEnabled.mockReset();
  cacheMock.cacheEnabled.mockReturnValue(true); // Redis configured by default
  // Must clear, or the injector leaks into the incrWindow-backed group above
  // and silently bypasses the backend those tests exist to pin. The "prefixes
  // the key with rl:" case asserts on incrWindow directly, so a leak reds it
  // rather than passing quietly.
  __setRateLimitCounterForTests(null);
});

describe("rateLimit (Upstash-only)", () => {
  it("passes when the count is within the cap", async () => {
    cacheMock.incrWindow.mockResolvedValue({ count: 3, ttlMs: 30_000 });
    await expect(rateLimit("login:1.2.3.4", CFG)).resolves.toBeUndefined();
  });

  it("throws 429 once the count exceeds the cap", async () => {
    cacheMock.incrWindow.mockResolvedValue({ count: 4, ttlMs: 30_000 });
    await expect(rateLimit("login:1.2.3.4", CFG)).rejects.toMatchObject(
      new HttpError(429, "Too many requests — slow down and try again.", undefined, undefined, { "Retry-After": "30" }),
    );
  });

  it("prefixes the key with rl: and forwards the window", async () => {
    cacheMock.incrWindow.mockResolvedValue({ count: 1, ttlMs: 60_000 });
    await rateLimit("login:1.2.3.4", CFG);
    expect(cacheMock.incrWindow).toHaveBeenCalledWith("rl:login:1.2.3.4", 60);
  });

  describe("when Redis is configured but unreachable (incrWindow → null)", () => {
    it("fails open by default — allows the request", async () => {
      cacheMock.incrWindow.mockResolvedValue(null);
      await expect(rateLimit("pub:1.2.3.4", CFG)).resolves.toBeUndefined();
    });

    it("fails closed when configured — throws 429", async () => {
      cacheMock.incrWindow.mockResolvedValue(null);
      cacheMock.cacheEnabled.mockReturnValue(true);
      await expect(
        rateLimit("login:1.2.3.4", { ...CFG, failClosed: true }),
      ).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("when Redis is not configured at all (local dev / e2e)", () => {
    it("is inert — allows even a failClosed limit so auth flows work", async () => {
      cacheMock.incrWindow.mockResolvedValue(null);
      cacheMock.cacheEnabled.mockReturnValue(false);
      await expect(
        rateLimit("login:1.2.3.4", { ...CFG, failClosed: true }),
      ).resolves.toBeUndefined();
    });
  });

  describe("preset policies", () => {
    it("auth + email fail closed (abuse-sensitive)", () => {
      expect(AUTH_LIMIT.failClosed).toBe(true);
      expect(EMAIL_LIMIT.failClosed).toBe(true);
    });

    it("webhook + mutation fail open (availability first)", () => {
      expect(WEBHOOK_LIMIT.failClosed).toBeUndefined();
      expect(MUTATION_LIMIT.failClosed).toBeUndefined();
    });
  });
});

// ─── The test-only counter injection (W1, 2026-09-21) ────────────────────────

function countingWindow() {
  const counts = new Map<string, number>();
  return async (key: string, windowSeconds: number) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return { count: next, ttlMs: windowSeconds * 1000 };
  };
}

describe("rateLimit (injected counter)", () => {
  it("allows up to max and throws 429 on the one past it", async () => {
    __setRateLimitCounterForTests(countingWindow());
    for (let i = 0; i < 3; i++) {
      await expect(rateLimit("t:a", { max: 3, windowSeconds: 1 })).resolves.toBeUndefined();
    }
    await expect(rateLimit("t:a", { max: 3, windowSeconds: 1 })).rejects.toMatchObject({
      status: 429,
    });
  });

  // The positive pair for the negative above: separate keys must NOT share a
  // bucket, or "throws past max" could pass with a global counter.
  it("counts per key, not globally", async () => {
    __setRateLimitCounterForTests(countingWindow());
    for (let i = 0; i < 3; i++) await rateLimit("t:a", { max: 3, windowSeconds: 1 });
    await expect(rateLimit("t:b", { max: 3, windowSeconds: 1 })).resolves.toBeUndefined();
  });

  // A null count from the INJECTED counter must obey the same failClosed
  // policy as a null from incrWindow — nothing else pins that the injector
  // branch of `rate-limit.ts:51-53` is not special-cased on null, which is the
  // one thing the two incrWindow-backed null cases above cannot see.
  //
  // `failClosed: true` is load-bearing, and its absence is what made the
  // earlier version of this case decoration: with failClosed omitted, `:60`'s
  // `failClosed && cacheEnabled()` short-circuits at `failClosed` and
  // cacheEnabled() is never evaluated, so that version pinned nothing the
  // "fails open by default" case above did not already pin, under a title
  // ("is inert when no counter is configured") that described a counter it
  // was in fact configuring.
  it("a null count from the injected counter still obeys failClosed", async () => {
    __setRateLimitCounterForTests(async () => null);

    // Redis configured but yielding no count → the failClosed policy denies.
    cacheMock.cacheEnabled.mockReturnValue(true);
    await expect(
      rateLimit("t:c", { max: 1, windowSeconds: 1, failClosed: true }),
    ).rejects.toMatchObject({ status: 429 });

    // Redis not configured at all → inert, even for a failClosed limit.
    cacheMock.cacheEnabled.mockReturnValue(false);
    await expect(
      rateLimit("t:c", { max: 1, windowSeconds: 1, failClosed: true }),
    ).resolves.toBeUndefined();
  });
});

// `http.ts:239` builds the envelope code as `err.code ?? statusCode(err.status)`,
// and `statusCode` (http.ts:75) is module-private to a `server-only` module, so
// what this suite can pin is the two INPUTS that decide it: no explicit code,
// and a 429. Together they are what makes the wire read RATE_LIMITED
// (http.ts:83) rather than a code the pad would have to learn. The earlier
// version asserted only the first of the two and named the second in its title.
it("the limiter's HttpError is a bare 429, so the envelope code is RATE_LIMITED", async () => {
  __setRateLimitCounterForTests(async () => ({ count: 99, ttlMs: 1_000 }));
  const err = await rateLimit("t:d", { max: 1, windowSeconds: 1 }).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(429);
  expect((err as HttpError).code).toBeUndefined();
});

// ─── Retry-After (capture QR v2 §10.4, amended §17.4 R4; A15) ────────────────
//
// The 429 carries the window's TRUE remaining seconds, read from the counter key's TTL in the same Lua script as the
// increment: an integer, rounded UP, never 0 (a 0 makes a client hammer). Every expected value below is derived from the
// `ttlMs` the test hands the seam, never from the limiter.
const retryAfterOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "the limiter refused").toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(429);
  return (err as HttpError).headers?.["Retry-After"];
};
const ceilSeconds = (ttlMs: number) => String(Math.ceil(ttlMs / 1000));

describe("Retry-After (R4)", () => {
  it("the limiter's 429 carries the window's remaining seconds, rounded up: ttlMs 42 500 → \"43\"", async () => {
    __setRateLimitCounterForTests(async () => ({ count: 4, ttlMs: 42_500 }));
    expect(await retryAfterOf(rateLimit("t:r1", CFG))).toBe(ceilSeconds(42_500));
    expect(ceilSeconds(42_500)).toBe("43");
  });

  it("the boundary: a TTL under one second (400 ms) answers \"1\", never \"0\"", async () => {
    __setRateLimitCounterForTests(async () => ({ count: 4, ttlMs: 400 }));
    expect(await retryAfterOf(rateLimit("t:r2", CFG))).toBe("1");
  });

  it("the production backend (incrWindow) carries the same header: ttlMs 7 001 → \"8\"", async () => {
    cacheMock.incrWindow.mockResolvedValue({ count: 4, ttlMs: 7_001 });
    expect(await retryAfterOf(rateLimit("t:r3", CFG))).toBe(ceilSeconds(7_001));
  });

  it("a key with no TTL to read (PTTL -1 / -2: a guard, the Lua sets one on the first hit) answers the FULL window, never 0", async () => {
    for (const ttlMs of [-1, -2, 0]) {
      __setRateLimitCounterForTests(async () => ({ count: 4, ttlMs }));
      expect(await retryAfterOf(rateLimit("t:r4", { max: 3, windowSeconds: 90 })), `ttlMs ${ttlMs}`).toBe("90");
    }
  });

  it("fail-closed (Redis configured but unreachable): no window to read, so Retry-After is the FULL windowSeconds", async () => {
    __setRateLimitCounterForTests(async () => null);
    cacheMock.cacheEnabled.mockReturnValue(true);
    expect(await retryAfterOf(rateLimit("t:r5", { max: 3, windowSeconds: 300, failClosed: true }))).toBe("300");
  });

  it("the positive pairs: Redis NOT configured is inert even for failClosed, a fail-open limit allows a null count, and a count within the cap passes — no 429 in any", async () => {
    __setRateLimitCounterForTests(async () => null);
    cacheMock.cacheEnabled.mockReturnValue(false);
    await expect(rateLimit("t:r6", { max: 3, windowSeconds: 300, failClosed: true })).resolves.toBeUndefined();
    cacheMock.cacheEnabled.mockReturnValue(true);
    await expect(rateLimit("t:r6", { max: 3, windowSeconds: 300 })).resolves.toBeUndefined();
    __setRateLimitCounterForTests(async () => ({ count: 3, ttlMs: 400 }));
    await expect(rateLimit("t:r6", CFG)).resolves.toBeUndefined();
  });
});

describe("rateLimitPeek (capture QR v2 §10.4: an IP over its failed-401 budget is refused before anything is read)", () => {
  it("asks the counter to PEEK — never to spend — and refuses once the window holds `max`, with the window's Retry-After", async () => {
    const ops: string[] = [];
    let count = 0;
    __setRateLimitCounterForTests(async (_key, _w, op) => { ops.push(op ?? "incr"); return { count, ttlMs: 12_300 }; });
    for (count = 0; count < 3; count++) await expect(rateLimitPeek("t:p1", CFG)).resolves.toBeUndefined();
    count = 3;
    expect(await retryAfterOf(rateLimitPeek("t:p1", CFG))).toBe(ceilSeconds(12_300));
    expect(ops).toEqual(["peek", "peek", "peek", "peek"]);
  });

  it("the production backend: peekWindow, never incrWindow; Redis not configured is inert", async () => {
    cacheMock.peekWindow.mockResolvedValue({ count: 3, ttlMs: 5_000 });
    expect(await retryAfterOf(rateLimitPeek("t:p2", CFG))).toBe("5");
    expect(cacheMock.peekWindow).toHaveBeenCalledWith("rl:t:p2");
    expect(cacheMock.incrWindow).not.toHaveBeenCalled();
    cacheMock.peekWindow.mockResolvedValue(null);
    cacheMock.cacheEnabled.mockReturnValue(false);
    await expect(rateLimitPeek("t:p2", { ...CFG, failClosed: true })).resolves.toBeUndefined();
  });

  it("Redis configured but unreachable: fail-open by default; a failClosed peek refuses with the FULL window (R4) — the same policy as rateLimit", async () => {
    cacheMock.peekWindow.mockResolvedValue(null);
    cacheMock.cacheEnabled.mockReturnValue(true);
    await expect(rateLimitPeek("t:p3", CFG)).resolves.toBeUndefined();
    expect(await retryAfterOf(rateLimitPeek("t:p3", { max: 3, windowSeconds: 240, failClosed: true }))).toBe("240");
  });
});

describe("the capture presets (spec §10.4)", () => {
  it("CAPTURE_CODE_LIMIT 120 / 60 s, CAPTURE_FAIL_LIMIT 30 / 60 s, CAPTURE_START_LIMIT 6 / 60 s — all fail OPEN: a Redis blip must not stop a broadcast's beats", () => {
    expect(CAPTURE_CODE_LIMIT).toEqual({ max: 120, windowSeconds: 60 });
    expect(CAPTURE_FAIL_LIMIT).toEqual({ max: 30, windowSeconds: 60 });
    expect(CAPTURE_START_LIMIT).toEqual({ max: 6, windowSeconds: 60 });
  });
});
