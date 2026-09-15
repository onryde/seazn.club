import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicStorageUrl } from "@/lib/storage-url";
import { __poisonDecodeQueueForTests, posterImageDataUrl } from "@/server/og/poster-image";

// `work` never rejects: that is the decode queue's contract
// (`afterEarlierDecodes`). An edit that broke it would leave the rejection in
// the queue, and every later share image on the machine would fall back to the
// monogram until a restart. That stays as it is. What must not happen is the
// same failure reported once per call: each call used to leave an unhandled
// rejection of its own behind, so a busy machine repeated it without end.
// A file of its own, because it poisons the module's queue for good.

const sharpBuilt = vi.hoisted(() => ({ count: 0 }));
vi.mock("sharp", () => ({
  default: () => {
    sharpBuilt.count += 1;
    throw new Error("nothing behind a poisoned queue reaches sharp");
  },
}));

const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://projectref.supabase.co");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A turn of the event loop: Node reports a rejection nobody handled once the
 *  microtasks queued before it have run. */
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("posterImageDataUrl — a poisoned decode queue", () => {
  it("is reported once, not once for every call that falls back behind it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const reason = new Error("a share-image decode's work rejected");
      __poisonDecodeQueueForTests(reason);
      const answers: (string | null)[] = [];
      for (let i = 0; i < 10; i += 1) {
        answers.push(await posterImageDataUrl(publicStorageUrl("orgs/org-1/entrant-badges/abc123.png")));
        await nextMacrotask();
      }
      await nextMacrotask();
      // Poisoning itself is unchanged: every call behind it falls back, and
      // none of them reaches sharp.
      expect(answers).toEqual(Array.from({ length: 10 }, () => null));
      expect(sharpBuilt.count).toBe(0);
      // Ten calls, one report.
      expect(unhandled).toEqual([]);
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(logMock.error).toHaveBeenCalledWith({ err: reason }, expect.stringMatching(/decode queue/));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
