// resolveLogo's bounds (T22 review m9): a club can type any logo URL, and the sponsor invoice's PDF - a public, token-gated
// route - fetches it on every download. A slow logo costs at most the timeout and a huge one at most the byte cap; past either
// the document prints without it (null), never throws and never buffers the whole oversize body first.
//
// Where the expected values come from: the review's ruling (~5 s, ~2 MB), pinned on the DEFAULT (LOGO_LIMITS), and the cases
// run against small explicit limits so the suite does not wait 5 s or allocate 2 MB per case. No database, no network: `fetch`
// is a stand-in that honours its AbortSignal the way the platform's does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGO_LIMITS, resolveLogo } from "../doc-render";

afterEach(() => vi.unstubAllGlobals());

const URL_ = "https://cdn.test/logo.png";

/** A body that hands out `chunks` chunks of `size` bytes, counting how many the reader pulled. */
function countedBody(chunks: number, size: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (n >= chunks) return controller.close();
      n++;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
  });
  return { body, pulled: () => n };
}

describe("resolveLogo's bounds", () => {
  it("the defaults are the review's: 5 s and 2 MB", () => {
    expect(LOGO_LIMITS).toEqual({ timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024 });
  });

  it("a logo that never answers is dropped at the timeout (null, not a hang): the fetch gets a signal and the wait is bounded", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        // A server that never answers: settles only when aborted. (Without a signal it would never settle.)
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          // A late answer, long after the limit: a resolveLogo that ignored its signal would get this logo.
          setTimeout(() => _resolve(new Response(new Uint8Array(10))), 1_500);
        });
      }),
    );
    const started = Date.now();
    const got = await resolveLogo(URL_, { timeoutMs: 50, maxBytes: 1_000 });
    const took = Date.now() - started;
    expect(got).toBeNull();
    expect(signal, "the fetch carries a signal").toBeInstanceOf(AbortSignal);
    expect(took, `took ${took} ms`).toBeLessThan(1_000);
  });

  it("a body bigger than the cap is dropped (null) as it arrives - with no length, or a lying one - and is not read to its end (2 counted)", async () => {
    let checked = 0;
    for (const headers of [{}, { "content-length": "100" }] as Record<string, string>[]) {
      const { body, pulled } = countedBody(50, 100); // 5,000 bytes on offer
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers })));
      expect(await resolveLogo(URL_, { timeoutMs: 1_000, maxBytes: 1_000 }), JSON.stringify(headers)).toBeNull();
      expect(pulled(), "stopped soon after the cap, not at the end").toBeLessThan(20);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a declared length over the cap is dropped before any of the body is read", async () => {
    const { body, pulled } = countedBody(50, 100);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-length": "5000" } })));
    expect(await resolveLogo(URL_, { timeoutMs: 1_000, maxBytes: 1_000 })).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(1); // a stream may pre-pull one chunk to fill its queue
  });

  it("the positive pair: a logo exactly at the cap, and one under it, come back whole (2 counted)", async () => {
    let checked = 0;
    for (const chunks of [10, 3]) {
      const { body } = countedBody(chunks, 100);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      const got = await resolveLogo(URL_, { timeoutMs: 1_000, maxBytes: 1_000 });
      expect(got?.byteLength, `${chunks} chunks`).toBe(chunks * 100);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("empty case and failures: no path, a 404 and a network error are each null, never a throw (3 counted)", async () => {
    let checked = 0;
    expect(await resolveLogo(undefined)).toBeNull();
    checked++;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    expect(await resolveLogo(URL_)).toBeNull();
    checked++;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await resolveLogo(URL_)).toBeNull();
    checked++;
    expect(checked).toBe(3);
  });
});
