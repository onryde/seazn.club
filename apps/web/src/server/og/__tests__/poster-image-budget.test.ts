import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicStorageUrl } from "@/lib/storage-url";
import { POSTER_IMAGE_TIMEOUT_MS, posterImageDataUrl } from "@/server/og/poster-image";

// `POSTER_IMAGE_TIMEOUT_MS` is documented as "a slow host must not stall a
// share preview or a download", but it used to bound the FETCH only: once the
// bytes were in hand, the decode and re-encode ran with no ceiling at all, and
// the timer was cleared regardless. A canvas at the pixel ceiling — a 50 MP
// frame, `POSTER_IMAGE_MAX_PIXELS` — is a real amount of work on a public
// route, so the half of the budget nobody was watching is the half that costs.
// These tests are about the clock, not about sharp — so sharp is replaced
// wholesale and how long a decode takes becomes a dial.

const decode = vi.hoisted(() => ({
  ms: 0,
  throws: false,
  timeouts: [] as unknown[],
  /** Per-decode dials, taken in call order; `ms`/`throws` once they run out. */
  plan: [] as { ms: number; throws?: boolean }[],
  /** Pipelines built — i.e. decodes that actually STARTED. */
  started: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** The buffer the latest decode resolved with, weakly: collectable once nothing holds it. */
  lastPng: undefined as WeakRef<Buffer> | undefined,
}));

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
      toBuffer: () => {
        const dial = decode.plan.shift() ?? { ms: decode.ms, throws: decode.throws };
        decode.inFlight += 1;
        decode.maxInFlight = Math.max(decode.maxInFlight, decode.inFlight);
        // A fresh buffer per decode, watched but not held, so a test can ask
        // whether anything still holds the last one.
        const png = Buffer.from(PNG);
        decode.lastPng = new WeakRef(png);
        return new Promise<Buffer>((resolve, reject) =>
          setTimeout(() => {
            decode.inFlight -= 1;
            if (dial.throws) reject(new Error("vips: too slow"));
            else resolve(png);
          }, dial.ms),
        );
      },
    };
    return pipeline;
  };
  return {
    default: () => {
      decode.started += 1;
      return make();
    },
  };
});

const STORAGE_ORIGIN = "https://projectref.supabase.co";
const uploadedBadge = () => publicStorageUrl("orgs/org-1/entrant-badges/abc123.png");

beforeEach(() => {
  decode.ms = 0;
  decode.throws = false;
  decode.timeouts = [];
  decode.plan = [];
  decode.started = 0;
  decode.inFlight = 0;
  decode.maxInFlight = 0;
  decode.lastPng = undefined;
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

afterEach(async () => {
  // Let every decode a test left running FINISH before the clock goes back to
  // real: decodes are serialized for the whole module, so a fake-timer decode
  // abandoned here would hold the slot into the next test forever.
  await vi.runAllTimersAsync();
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

// Memory, not time, is why these exist. A PNG gets no shrink-on-load: sharp
// streams it at FULL input width, so what one decode holds grows with the
// canvas — and a match poster draws three images. Decoded in parallel their
// peaks add; decoded one at a time, share images never hold more than one
// decode's worth between them, for one render and across concurrent renders
// alike. The queue is this fetcher's, not the process's: Next's
// `/_next/image` optimizer decodes with sharp in the same process, outside it.
describe("posterImageDataUrl — one share-image decode at a time", () => {
  it("never runs two decodes together, so a render's three images never hold their canvases at once", async () => {
    decode.ms = 400;
    const calls = [start(), start(), start()];
    await vi.advanceTimersByTimeAsync(3 * 400);
    expect(calls.map((call) => call.answer()?.startsWith("data:image/png;base64,"))).toEqual([true, true, true]);
    expect(decode.maxInFlight).toBe(1);
  });

  it("spends the wait for the slot from the call's own budget", async () => {
    decode.plan = [{ ms: POSTER_IMAGE_TIMEOUT_MS - 100 }, { ms: 200 }];
    const first = start();
    const second = start();
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect(first.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    // In parallel the second would have drawn at 200ms. Queued behind the
    // first, it cannot finish inside its budget — so it falls back, on time.
    expect(second.answer()).toBeNull();
  });

  it("never starts the decode of a call whose budget ran out while it waited, and gives its place up", async () => {
    // Abandoned-but-queued work must not allocate: nobody is waiting for it.
    decode.plan = [{ ms: POSTER_IMAGE_TIMEOUT_MS * 2 }];
    const first = start();
    const second = start();
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect([first.answer(), second.answer()]).toEqual([null, null]);
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS); // the first decode ends; the slot is free
    expect(decode.started).toBe(1);
    // Not starting is half of it. A waiter that skipped its decode but kept its
    // place would wedge every later share image, so the queue is checked HERE,
    // not left for whichever test happens to run next: a fresh call goes
    // straight in, and draws.
    const third = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(third.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    expect(decode.started).toBe(2);
  });

  it("hands the slot on after a decode that fails", async () => {
    // A failure that escaped the decode would poison the queue: every later
    // image on the machine would fall back, silently, until a restart.
    decode.plan = [{ ms: 1, throws: true }, { ms: 1 }];
    const first = start();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.answer()).toBeNull();
    const second = start();
    await vi.advanceTimersByTimeAsync(1);
    expect(second.answer()?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not hold the last decoded image once its caller has answered", async () => {
    // The queue's tail outlives every call. If it held the value a decode
    // resolved with, the last share image drawn — up to 1024² of PNG — would
    // stay in memory until the next decode came along, however long that is.
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    const call = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(call.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    // The anti-vacuous half: the probe really watched a decoded buffer.
    expect(decode.lastPng).toBeDefined();
    // A WeakRef keeps its target alive until the current job ends; the async
    // tick yields to the real event loop first, then a full collection runs.
    await vi.advanceTimersByTimeAsync(0);
    gc();
    expect(decode.lastPng?.deref()).toBeUndefined();
  });
});
