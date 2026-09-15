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
  /** Per-decode dials, taken in call order; `ms`/`throws` once they run out.
   *  `never`: the decode does not settle until the test settles it (`stuck`). */
  plan: [] as { ms: number; throws?: boolean; never?: boolean }[],
  /** Per-pipeline header-read dials, in call order: `ms` delays it; `never`
   *  holds it until the test settles it (`stuck`). Immediate once they run out. */
  metadataPlan: [] as { ms?: number; never?: boolean }[],
  /** Settles each operation a `never` dial is holding, oldest first. */
  stuck: [] as (() => void)[],
  /** Pipelines built — i.e. decodes that actually STARTED. */
  started: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** sharp operations — header reads AND pipelines — not yet settled, as sharp
   *  itself would count them: the witness for the cap, kept apart from the
   *  module's own count. */
  unsettled: 0,
  maxUnsettled: 0,
  /** The buffer the latest decode resolved with, weakly: collectable once nothing holds it. */
  lastPng: undefined as WeakRef<Buffer> | undefined,
}));

vi.mock("sharp", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** An operation sharp is running, counted until it settles. */
  function watched<T>(op: Promise<T>): Promise<T> {
    decode.unsettled += 1;
    decode.maxUnsettled = Math.max(decode.maxUnsettled, decode.unsettled);
    const settled = (): void => {
      decode.unsettled -= 1;
    };
    void op.then(settled, settled);
    return op;
  }
  const make = (): Record<string, unknown> => {
    const pipeline: Record<string, unknown> = {
      metadata: () => {
        const dial = decode.metadataPlan.shift() ?? {};
        const header = { format: "png", width: 64, height: 64 };
        if (dial.never) return watched(new Promise((resolve) => decode.stuck.push(() => resolve(header))));
        if (dial.ms === undefined) return watched(Promise.resolve(header));
        return watched(new Promise((resolve) => setTimeout(() => resolve(header), dial.ms)));
      },
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
        if (dial.never) {
          return watched(
            new Promise<Buffer>((resolve) =>
              decode.stuck.push(() => {
                decode.inFlight -= 1;
                resolve(png);
              }),
            ),
          );
        }
        return watched(
          new Promise<Buffer>((resolve, reject) =>
            setTimeout(() => {
              decode.inFlight -= 1;
              if (dial.throws) reject(new Error("vips: too slow"));
              else resolve(png);
            }, dial.ms),
          ),
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

const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

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
  decode.metadataPlan = [];
  decode.stuck = [];
  decode.unsettled = 0;
  decode.maxUnsettled = 0;
  for (const fn of Object.values(logMock)) fn.mockClear();
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
  // Settle what a test left stuck, then let every decode a test left running
  // FINISH before the clock goes back to real: the slot and the count of
  // unsettled sharp operations are the whole module's, so an operation
  // abandoned here would hold them into the next test forever.
  for (const settle of decode.stuck.splice(0)) settle();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(decode.unsettled).toBe(0);
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

/** How long after it takes the slot a decode is given up as hung: its caller's
 *  budget, the sharp timeout the pipeline was really handed, and the valve's
 *  grace past that timeout — written down here as 500 ms rather than read from
 *  the module, so the grace cannot quietly shrink. */
function valveAfter(): number {
  const [{ seconds }] = decode.timeouts as [{ seconds: number }];
  return POSTER_IMAGE_TIMEOUT_MS + seconds * 1000 + 500;
}

/** The warnings the cap gave, apart from the valve's. */
function capWarnings(): unknown[][] {
  return logMock.warn.mock.calls.filter(([, message]) => /at the cap/.test(String(message)));
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

  it("gives the slot up, with one warning, when a decode never settles", async () => {
    // sharp's own timeout ends a running pipeline, but it cannot fire on work
    // libvips never schedules. Without a valve, one decode that never settled
    // would hold the slot for the life of the process, and every later share
    // image on the machine would fall back until a restart. So a decode that
    // has held the slot for its caller's whole budget, plus sharp's timeout on
    // top and a grace past that, is taken to be hung and let go.
    decode.plan = [{ ms: 0, never: true }];
    const hung = start();
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect(hung.answer()).toBeNull(); // its own caller still answers on time
    const hungAfter = valveAfter();

    // A call that arrives a second before the valve waits for it…
    await vi.advanceTimersByTimeAsync(hungAfter - 1000 - POSTER_IMAGE_TIMEOUT_MS);
    const waiting = start();
    await vi.advanceTimersByTimeAsync(1000 - 1);
    expect(waiting.answer()).toBeUndefined();
    expect(decode.started).toBe(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    // …starts the moment the slot is given up…
    await vi.advanceTimersByTimeAsync(1);
    expect(decode.started).toBe(2);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith({ heldMs: hungAfter }, expect.stringMatching(/never settled/));
    // …and draws inside its own budget. (The mock's zero-ms decode, scheduled
    // during a fake-timer tick, lands one millisecond later.)
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    // One line for one hung decode, however long it stays hung.
    await vi.advanceTimersByTimeAsync(hungAfter * 4);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it("does not give up, or log as never settled, a decode sharp's own timeout ends a little late", async () => {
    // sharp checks its timeout from libvips' progress callback, so a pipeline
    // it kills settles AFTER the timeout, not at it. A valve with no margin
    // over that timeout would release — and report as hung — a decode that
    // was already ending.
    const sharpTimeoutMs = Math.ceil(POSTER_IMAGE_TIMEOUT_MS / 1000) * 1000;
    // The header read lands a millisecond inside its caller's deadline, so the
    // pipeline starts as late after taking the slot as it can…
    decode.metadataPlan = [{ ms: POSTER_IMAGE_TIMEOUT_MS - 1 }];
    // …and sharp ends it 50 ms past its own timeout.
    decode.plan = [{ ms: sharpTimeoutMs + 50, throws: true }];
    const killed = start();
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect(killed.answer()).toBeNull();
    expect(decode.inFlight).toBe(1); // the pipeline is running, past its caller
    expect(decode.timeouts).toEqual([{ seconds: sharpTimeoutMs / 1000 }]);
    const endsAt = POSTER_IMAGE_TIMEOUT_MS - 1 + sharpTimeoutMs + 50;

    // A call that arrives a second before sharp's kill lands waits for it…
    await vi.advanceTimersByTimeAsync(endsAt - 1000 - POSTER_IMAGE_TIMEOUT_MS);
    const waiting = start();
    await vi.advanceTimersByTimeAsync(1000 - 1);
    expect(decode.started).toBe(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    // …starts when the kill settles the decode, and not before…
    await vi.advanceTimersByTimeAsync(1);
    expect(decode.started).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    // …and nothing ever says the killed decode never settled.
    await vi.advanceTimersByTimeAsync(valveAfter() * 2);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("bounds the header read as well: a metadata() that never settles monograms on time and frees the slot then", async () => {
    // sharp's timeout is attached to the output pipeline only, and
    // `metadata()` has none. A header read allocates no canvas, so abandoning
    // one at its caller's deadline frees the slot without breaking the bound.
    decode.metadataPlan = [{ never: true }];
    const stuck = start();
    await vi.advanceTimersByTimeAsync(1000);
    const next = start(); // its own budget runs a second past the first's
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS - 1000 - 1);
    expect([stuck.answer(), next.answer()]).toEqual([undefined, undefined]);
    expect(decode.started).toBe(1);
    // At the first call's deadline it has answered, and the slot is free.
    await vi.advanceTimersByTimeAsync(1);
    expect(stuck.answer()).toBeNull();
    expect(decode.started).toBe(2);
    // The next draws inside its own budget (its zero-ms mock decode lands a
    // millisecond later, as a timer scheduled during a fake-timer tick does).
    await vi.advanceTimersByTimeAsync(1);
    expect(next.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    // The header bound freed the slot, not the valve.
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

// The valve and the header bound free the SLOT, not the work: a decode given up
// as hung, or a header read abandoned at its caller's deadline, is still running
// in libvips. Freeing the slot without a ceiling admits one more stuck operation
// every time it happens — one per request for a hung header read, silently —
// until the threadpool is gone. So the number of sharp operations still
// unsettled is capped, and a call over the cap is answered with the monogram at
// once.

/** Leaves two header reads hung and the slot free, at the second caller's
 *  deadline: the first read was abandoned at its own, and the second started
 *  then. */
async function twoHeaderReadsStuck(): Promise<void> {
  decode.metadataPlan.push({ never: true }, { never: true });
  start();
  await vi.advanceTimersByTimeAsync(1000);
  start();
  await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
  expect(decode.unsettled).toBe(2);
}

describe("posterImageDataUrl — at most two sharp operations unsettled", () => {
  it("admits no third, however many decodes hang: each later call is refused at once, with one warning", async () => {
    const hangs = 6;
    decode.plan = Array.from({ length: hangs }, () => ({ ms: 0, never: true }));
    const calls = [start()];
    await vi.advanceTimersByTimeAsync(0);
    const held = valveAfter();
    // Every later call arrives a second before whichever decode holds the slot
    // is given up, so the valve alone would start it.
    await vi.advanceTimersByTimeAsync(held - 1000);
    for (let i = 1; i < hangs; i += 1) {
      const call = start();
      calls.push(call);
      await vi.advanceTimersByTimeAsync(0);
      // The first two are the cap. Every call past it answers now, not at its
      // deadline and not after waiting for the slot.
      if (i >= 2) expect(call.answer()).toBeNull();
      await vi.advanceTimersByTimeAsync(held);
      expect(decode.maxUnsettled).toBeLessThanOrEqual(2);
    }
    expect(decode.maxUnsettled).toBe(2);
    expect(decode.started).toBe(2);
    expect(calls.map((call) => call.answer())).toEqual(Array.from({ length: hangs }, () => null));
    expect(capWarnings()).toHaveLength(1);
  });

  it("counts a header read toward the cap, refusing at its turn a call admitted while it waited, and at once a call arriving over it", async () => {
    decode.metadataPlan = [{ never: true }, { never: true }, { never: true }];
    const first = start(); // its header read hangs: one unsettled
    await vi.advanceTimersByTimeAsync(1000);
    const second = start(); // admitted, waits for the slot
    await vi.advanceTimersByTimeAsync(200);
    const third = start(); // admitted, waits behind the second
    // The first is abandoned at its deadline and the second's read starts, and
    // hangs: two unsettled. The second is abandoned at ITS deadline, and the
    // third's turn comes 200 ms inside its own budget.
    await vi.advanceTimersByTimeAsync(300 + 1000);
    expect([first.answer(), second.answer()]).toEqual([null, null]);
    expect(third.answer()).toBeNull();
    expect(decode.started).toBe(2);
    expect(decode.maxUnsettled).toBe(2);
    // Arriving over the cap: no fetch, no wait for the slot, no sharp.
    const fourth = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fourth.answer()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(decode.started).toBe(2);
    expect(capWarnings()).toHaveLength(1);
  });

  it("warns once per episode at the cap, not once per refused call", async () => {
    await twoHeaderReadsStuck();
    const refused = [start(), start(), start()];
    await vi.advanceTimersByTimeAsync(0);
    expect(refused.map((call) => call.answer())).toEqual([null, null, null]);
    expect(capWarnings()).toHaveLength(1);
    // One settles, which ends the episode; a third hang fills the cap again,
    // and the next refusal is a new episode.
    decode.stuck.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    decode.metadataPlan.push({ never: true });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(decode.unsettled).toBe(2);
    const again = [start(), start()];
    await vi.advanceTimersByTimeAsync(0);
    expect(again.map((call) => call.answer())).toEqual([null, null]);
    expect(capWarnings()).toHaveLength(2);
  });

  it("admits a call again the moment a stuck operation settles, and only as many as it freed", async () => {
    await twoHeaderReadsStuck();
    const refused = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refused.answer()).toBeNull();
    decode.stuck.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    const next = start();
    // Its zero-ms mock decode lands a millisecond later, as a timer scheduled
    // during a fake-timer tick does.
    await vi.advanceTimersByTimeAsync(1);
    expect(next.answer()?.startsWith("data:image/png;base64,")).toBe(true);
    expect(decode.started).toBe(3);
    // Room for exactly one more stuck operation: one settling freed one place.
    decode.metadataPlan.push({ never: true });
    start();
    await vi.advanceTimersByTimeAsync(0);
    const over = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(over.answer()).toBeNull();
    expect(decode.started).toBe(4);
    expect(decode.maxUnsettled).toBe(2);
  });
});
