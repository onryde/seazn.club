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

const cacheMock = vi.hoisted(() => ({ incrWindow: vi.fn(), cacheEnabled: vi.fn(() => true) }));
vi.mock("@/lib/cache", () => ({
  incrWindow: cacheMock.incrWindow,
  cacheEnabled: cacheMock.cacheEnabled,
}));

import { HttpError } from "@/lib/errors";
import {
  rateLimit,
  AUTH_LIMIT,
  EMAIL_LIMIT,
  WEBHOOK_LIMIT,
  MUTATION_LIMIT,
  __setRateLimitCounterForTests,
} from "@/lib/rate-limit";

const CFG = { max: 3, windowSeconds: 60 };

afterEach(() => {
  cacheMock.incrWindow.mockReset();
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
    cacheMock.incrWindow.mockResolvedValue(3);
    await expect(rateLimit("login:1.2.3.4", CFG)).resolves.toBeUndefined();
  });

  it("throws 429 once the count exceeds the cap", async () => {
    cacheMock.incrWindow.mockResolvedValue(4);
    await expect(rateLimit("login:1.2.3.4", CFG)).rejects.toMatchObject(
      new HttpError(429, "Too many requests — slow down and try again."),
    );
  });

  it("prefixes the key with rl: and forwards the window", async () => {
    cacheMock.incrWindow.mockResolvedValue(1);
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
  return async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
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

  // Defeats the guard: with the injector absent the limiter is inert, so a
  // test that never injects proves nothing. This asserts the inert path is
  // reachable AND distinguishable, so a future change that makes the real
  // path inert cannot hide behind a green suite.
  //
  // NOT a duplicate of "is inert — allows even a failClosed limit" above: that
  // one pins the PRODUCTION inert path (cacheEnabled() false, failClosed true).
  // This one pins the fail-open default when a configured counter yields no
  // count. The two `count === null` routes are told apart only by
  // cacheEnabled(), so both need their own case.
  it("is inert when no counter is configured", async () => {
    __setRateLimitCounterForTests(async () => null);
    for (let i = 0; i < 50; i++) {
      await expect(rateLimit("t:c", { max: 1, windowSeconds: 1 })).resolves.toBeUndefined();
    }
  });
});

it("HttpError from the limiter carries no explicit code, so http.ts maps 429", async () => {
  __setRateLimitCounterForTests(async () => 99);
  const err = await rateLimit("t:d", { max: 1, windowSeconds: 1 }).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBeUndefined();
});
