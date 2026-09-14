import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicStorageUrl } from "@/lib/storage-url";
import { POSTER_IMAGE_TIMEOUT_MS, posterImageDataUrl } from "@/server/og/poster-image";

// `POSTER_IMAGE_TIMEOUT_MS` is documented as "a slow host must not stall a
// share preview or a download", but it used to bound the FETCH only: once the
// bytes were in hand, the decode and re-encode ran with no ceiling at all, and
// the timer was cleared regardless. A 4 Mpx canvas is a real amount of work on
// a public route, so the half of the budget nobody was watching is the half
// that costs. These tests are about the clock, not about sharp — so sharp is
// replaced wholesale and how long a decode takes becomes a dial.

const decode = vi.hoisted(() => ({ ms: 0, throws: false, timeouts: [] as unknown[] }));

vi.mock("sharp", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const make = (): Record<string, unknown> => {
    const pipeline: Record<string, unknown> = {
      metadata: async () => ({ format: "png", width: 64, height: 64 }),
      resize: () => pipeline,
      timeout: (opts: unknown) => {
        decode.timeouts.push(opts);
        return pipeline;
      },
      png: () => pipeline,
      toBuffer: () =>
        new Promise<Buffer>((resolve, reject) =>
          setTimeout(() => (decode.throws ? reject(new Error("vips: too slow")) : resolve(PNG)), decode.ms),
        ),
    };
    return pipeline;
  };
  return { default: () => make() };
});

const STORAGE_ORIGIN = "https://projectref.supabase.co";
const uploadedBadge = () => publicStorageUrl("orgs/org-1/entrant-badges/abc123.png");

beforeEach(() => {
  decode.ms = 0;
  decode.throws = false;
  decode.timeouts = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STORAGE_ORIGIN);
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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Starts the call and records what it answered, WITHOUT awaiting it — the
 *  whole question is whether it has answered yet, and awaiting a call that has
 *  not would simply hang. */
function start(): { answer: () => string | null | undefined } {
  let answer: string | null | undefined;
  void posterImageDataUrl(uploadedBadge()).then((v) => {
    answer = v;
  });
  return { answer: () => answer };
}

describe("posterImageDataUrl — the budget covers the decode, not just the fetch", () => {
  it("falls back at the budget when the decode outlives it", async () => {
    decode.ms = POSTER_IMAGE_TIMEOUT_MS * 10;
    const call = start();
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    // Not "eventually null": null BY the time the budget is spent. With the
    // fetch alone bounded this is still `undefined` — nothing has answered,
    // and the route is holding a connection open for another 13.5 seconds.
    expect(call.answer()).toBeNull();
  });

  it("still draws a decode that finishes inside the budget", async () => {
    // The anti-vacuous half: a bound that refused everything would pass the
    // test above and delete every badge from every share image.
    decode.ms = POSTER_IMAGE_TIMEOUT_MS - 1;
    const call = start();
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS - 1);
    expect(call.answer()?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("also hands libvips its OWN watchdog, set from the same budget", async () => {
    // The race above bounds what the ROUTE waits for; it cannot stop the work.
    // An abandoned decode would carry on burning a threadpool slot after we
    // have already answered, so the pipeline carries sharp's own timeout too.
    // Derived from the budget, not written down beside it.
    decode.ms = 0;
    const call = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(call.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    expect(decode.timeouts).toEqual([{ seconds: Math.ceil(POSTER_IMAGE_TIMEOUT_MS / 1000) }]);
  });

  it("falls back rather than throwing when the decode fails inside the budget", async () => {
    // The race must not swallow the ordinary failure path: a pipeline that
    // rejects is still a monogram, not a 500.
    decode.ms = 1;
    decode.throws = true;
    const call = start();
    await vi.advanceTimersByTimeAsync(1);
    expect(call.answer()).toBeNull();
  });
});
