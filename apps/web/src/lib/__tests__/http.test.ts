// Non-versioned route wrapper (lib/http.ts's handler()): unlike /api/v1's
// v1(), no requestId rides in the response envelope, so the only way to
// prove the request-context ALS is wired is to observe it from inside fn().
import { describe, expect, it, vi } from "vitest";
import { getRequestContext } from "@/server/request-context";
import { log } from "@/server/logger";
import { handler, HttpError } from "../http";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

describe("handler (lib/http.ts)", () => {
  it("runs fn inside a request-context scope with a generated requestId", async () => {
    let seenDuringHandler: string | undefined;
    await handler(async () => {
      seenDuringHandler = getRequestContext().requestId;
      return { ok: true };
    });
    expect(seenDuringHandler).toBeDefined();
    expect(typeof seenDuringHandler).toBe("string");
  });

  it("gives two calls distinct requestIds", async () => {
    const ids: (string | undefined)[] = [];
    await handler(async () => {
      ids.push(getRequestContext().requestId);
      return { ok: true };
    });
    await handler(async () => {
      ids.push(getRequestContext().requestId);
      return { ok: true };
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  // Same pairing as api-v1/http.ts's v1(): a 500 pages (Sentry) AND logs
  // (pino) — a 4xx the caller can fix does neither.
  it("log.error fires alongside Sentry.captureException on every 500 path, and only 500s", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    try {
      await handler(async () => {
        throw new HttpError(404, "not found");
      });
      expect(logged).not.toHaveBeenCalled();
      expect(sentry.captureException).not.toHaveBeenCalled();

      await handler(async () => {
        throw new HttpError(500, "db is down");
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledTimes(1);

      await handler(async () => {
        throw new Error("unhandled");
      });
      expect(logged).toHaveBeenCalledTimes(2);
      expect(sentry.captureException).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  // Capture QR v2 §10.4 / A15: the limiter's Retry-After rides HttpError.headers; handler() must put them on the wire.
  it("copies HttpError.headers onto the response (the limiter's Retry-After); an HttpError with none sets none", async () => {
    const limited = await handler(async () => {
      throw new HttpError(429, "slow down", undefined, undefined, { "Retry-After": "17" });
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    const plain = await handler(async () => {
      throw new HttpError(409, "conflict");
    });
    expect(plain.status).toBe(409);
    expect(plain.headers.get("retry-after")).toBeNull();
  });
});
