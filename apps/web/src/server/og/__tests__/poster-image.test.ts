import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { publicStorageUrl } from "@/lib/storage-url";
import {
  POSTER_IMAGE_MAX_BYTES,
  POSTER_IMAGE_TIMEOUT_MS,
  allowedPosterImageUrl,
  posterImageDataUrl,
} from "@/server/og/poster-image";

// The share image and the downloadable poster are PUBLIC routes, and satori
// fetches every `<img src>` it is handed, server-side, from inside our own
// network. `badge_url` is organiser-typed free text (api-v1/schemas.ts,
// `z.string().min(1).max(1000)`), so "draw this badge" was "make this request".
// Everything here is about what that fetcher will and will not do.

/** The project URL the app itself serves uploads from, as a test value. The
 *  real one comes from the environment; a badge is only ever fetched from the
 *  host `publicStorageUrl` builds. */
const STORAGE_ORIGIN = "https://projectref.supabase.co";

/** Derived, never typed: whatever shape `publicStorageUrl` gives an uploaded
 *  badge IS the shape the fetcher has to accept. If the URL builder moves, this
 *  moves with it instead of asserting yesterday's path. */
const uploadedBadge = () => publicStorageUrl("orgs/org-1/entrant-badges/abc123.png");

const png = (size = 64) =>
  sharp({
    create: { width: size, height: size, channels: 4, background: { r: 200, g: 30, b: 60, alpha: 1 } },
  })
    .png()
    .toBuffer();

const webp = () =>
  sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 40, b: 255, alpha: 1 } } })
    .webp()
    .toBuffer();

function imageResponse(bytes: Buffer, type: string, extra: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": type, ...extra },
  });
}

/** Installs a fetch spy and returns it, so every test can assert not just the
 *  answer but whether a request left the process at all. */
function spyFetch(impl: (url: URL | string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STORAGE_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("allowedPosterImageUrl — the only host is the one this app serves its own uploads from", () => {
  it("accepts the storage URL the app's own uploader builds", () => {
    const url = allowedPosterImageUrl(uploadedBadge());
    expect(url).not.toBeNull();
    expect(url?.hostname).toBe(new URL(STORAGE_ORIGIN).hostname);
  });

  it("refuses any other host, however plausible", () => {
    expect(allowedPosterImageUrl("https://cdn.example.com/a.png")).toBeNull();
    // The allow-list is an exact host match, not a suffix one: a look-alike
    // that merely ENDS with the real host is a different host.
    expect(allowedPosterImageUrl("https://evil-projectref.supabase.co/a.png")).toBeNull();
    expect(allowedPosterImageUrl("https://projectref.supabase.co.evil.test/a.png")).toBeNull();
  });

  it("refuses plain http even on the allow-listed host", () => {
    expect(allowedPosterImageUrl(uploadedBadge().replace("https://", "http://"))).toBeNull();
  });

  it("refuses an internal address even when the CONFIGURED storage host is one", () => {
    // Defence in depth: a misconfigured or injected NEXT_PUBLIC_SUPABASE_URL
    // must not turn the allow-list itself into a hole pointed at the host's
    // own loopback or metadata service.
    for (const origin of ["https://127.0.0.1:54321", "https://localhost:54321", "https://[::1]:54321"]) {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin);
      expect(allowedPosterImageUrl(`${origin}/storage/v1/object/public/assets/a.png`)).toBeNull();
    }
  });

  it("refuses what is not an absolute URL at all", () => {
    expect(allowedPosterImageUrl(null)).toBeNull();
    expect(allowedPosterImageUrl("")).toBeNull();
    expect(allowedPosterImageUrl("/uploads/b.png")).toBeNull();
    expect(allowedPosterImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(allowedPosterImageUrl("not a url")).toBeNull();
  });

  it("refuses everything when no storage host is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(allowedPosterImageUrl("https://projectref.supabase.co/a.png")).toBeNull();
  });
});

describe("posterImageDataUrl — satori is handed bytes, never a URL", () => {
  it("returns an allow-listed badge as a data: URI carrying real PNG bytes", async () => {
    const spy = spyFetch(async () => imageResponse(await png(), "image/png"));
    const out = await posterImageDataUrl(uploadedBadge());
    expect(out?.startsWith("data:image/png;base64,")).toBe(true);
    const bytes = Buffer.from(out!.slice("data:image/png;base64,".length), "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0]!;
    // A redirect is a second, unchecked destination. Refuse to follow one.
    expect(init?.redirect).toBe("manual");
  });

  it("never makes the request at all for a host that is not allow-listed", async () => {
    const spy = spyFetch(async () => imageResponse(await png(), "image/png"));
    expect(await posterImageDataUrl("https://cdn.example.com/a.png")).toBeNull();
    expect(await posterImageDataUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(await posterImageDataUrl("/uploads/b.png")).toBeNull();
    expect(await posterImageDataUrl(null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("converts webp to png, which is the format the app stores its own logos in", async () => {
    // Measured through a real ImageResponse: satori renders remote webp as an
    // EMPTY box (and throws outright on a `data:image/webp` URI), while
    // orgLogoPath/divisionLogoPath both end `.webp` and the badge uploader
    // accepts `image/webp` verbatim. Conversion is why sharp is used here.
    spyFetch(async () => imageResponse(await webp(), "image/webp"));
    const out = await posterImageDataUrl(uploadedBadge());
    expect(out?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("gives up on a host that never answers, at the timeout rather than never", async () => {
    vi.useFakeTimers();
    let aborted = false;
    spyFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = posterImageDataUrl(uploadedBadge());
    await vi.advanceTimersByTimeAsync(POSTER_IMAGE_TIMEOUT_MS);
    expect(aborted).toBe(true);
    expect(await pending).toBeNull();
  });

  it("refuses a body that DECLARES itself over the cap without draining it", async () => {
    // A `ReadableStream` pulls once to prefill its queue before anyone reads,
    // so "was pull called" cannot witness this. What can: the body is dropped
    // after that one prefill, and cancelled rather than drained.
    let pulls = 0;
    let cancelled = false;
    spyFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(POSTER_IMAGE_MAX_BYTES + 1),
            },
          },
        ),
    );
    expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });

  it("stops reading a body that lies about its length once it passes the cap", async () => {
    const CHUNK = 256 * 1024;
    let pulls = 0;
    spyFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(CHUNK));
            },
          }),
          { status: 200, headers: { "content-type": "image/png", "content-length": "512" } },
        ),
    );
    expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
    // Bounded by the cap, not by the sender: a stream that never ends would
    // otherwise buffer the whole of whatever it feels like sending.
    expect(pulls).toBeLessThanOrEqual(POSTER_IMAGE_MAX_BYTES / CHUNK + 2);
  });

  it("refuses a response that is not one of the image types we draw", async () => {
    for (const type of ["text/html", "application/json", "", "image/svg+xml"]) {
      spyFetch(async () => imageResponse(await png(), type));
      expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
    }
  });

  it("refuses a redirect rather than following it to a second, unchecked host", async () => {
    const spy = spyFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/a.png" } }),
    );
    expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses an error response", async () => {
    spyFetch(async () => new Response("nope", { status: 404, headers: { "content-type": "image/png" } }));
    expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
  });

  it("returns null rather than throwing when the bytes are not really an image", async () => {
    // A corrupt JPEG THROWS inside satori ("Invalid JPEG"), which on these two
    // routes is a 500 where a monogram tile would do.
    spyFetch(async () => imageResponse(Buffer.from([255, 216, 255, 1, 2, 3, 4, 5]), "image/jpeg"));
    expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
  });

  it("returns null rather than throwing when the fetch itself fails", async () => {
    spyFetch(async () => {
      throw new TypeError("network down");
    });
    expect(await posterImageDataUrl(uploadedBadge())).toBeNull();
  });
});
