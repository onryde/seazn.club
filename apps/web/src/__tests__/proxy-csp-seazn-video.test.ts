// Seazn-hosted video, Phase 1 Task 15: the public match page's player loads a signed HLS manifest and its segments from the Stream
// customer host (`STREAM_PLAYBACK_HOST`, server/relay/config.ts `streamPlaybackHost`). hls.js fetches them with XHR / fetch
// (`connect-src`) and feeds a MediaSource through a `blob:` URL (`media-src`); Safari's native HLS loads the manifest into the
// <video> itself (`media-src`). The policy gains exactly that and nothing else:
//   connect-src  the playback host
//   media-src    NEW: 'self', blob:, the playback host (`default-src 'self'` covered media before; a directive of its own must
//                restate 'self')
// The expected policy is typed from the ruling. The ONE value read from the code is the origin of a REAL signed address (the
// server's own signer over a fake token), to prove the policy allows what the player will actually request: a URL builder and a
// policy that drifted apart would be a page that signs and a player that is refused.
//
// The page this protects is on a cacheable public path, so its policy is report-only whatever CSP_MODE says
// (proxy-csp.test.ts); the declaration is what a later enforcement, and the console report today, rest on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cspHeader, proxy } from "../proxy";
import { FAKE_PLAYBACK_HOST } from "@/server/relay/config";
import { createPlaybackTokenCache, signLivePlayback } from "@/server/video/cf-playback";

afterEach(() => vi.unstubAllEnvs());

const HOST = "customer-q7x2k9m4.cloudflarestream.com";
const directives = (csp: string): Map<string, string[]> =>
  new Map(csp.split("; ").map((d) => { const [name, ...values] = d.replace(/'nonce-[^']+'/g, "'nonce-*'").split(" "); return [name!, values] as const; }));
const policy = (pathname?: string) => directives(cspHeader("n", pathname === undefined ? {} : { pathname }).value);

describe("CSP for the Seazn player", () => {
  it("a deployment with a Stream customer host: connect-src and media-src name exactly it, and media-src is 'self', blob: and the host", () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", HOST);
    expect(policy().get("media-src")).toEqual(["'self'", "blob:", `https://${HOST}`]);
    expect(policy().get("connect-src")).toContain(`https://${HOST}`);
  });

  it("the fake driver's host is the fallback where none is configured (local and CI), so the report names what the page will request", () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", "");
    expect(policy().get("media-src")).toEqual(["'self'", "blob:", `https://${FAKE_PLAYBACK_HOST}`]);
    expect(policy().get("connect-src")).toContain(`https://${FAKE_PLAYBACK_HOST}`);
  });

  it("EMPTY CASE: a live deployment with no host configured (nothing is signed there) adds nothing: media-src is 'self' and blob: alone", () => {
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("STREAM_PLAYBACK_HOST", "");
    expect(policy().get("media-src")).toEqual(["'self'", "blob:"]);
    expect(policy().get("connect-src")!.filter((v) => /cloudflarestream|fake\.invalid/.test(v))).toEqual([]);
  });

  it("a malformed host never takes the page down and never reaches the policy (the signer refuses it by name; the proxy only skips it)", () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", "https://evil.example/path");
    expect(() => cspHeader("n")).not.toThrow();
    expect(policy().get("media-src")).toEqual(["'self'", "blob:"]);
    expect(cspHeader("n").value).not.toContain("evil.example");
  });

  it("allows what the player will actually request: the origin of a REAL signed address is in connect-src and media-src", async () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", HOST);
    const ingest = { playbackToken: async () => "tok-0123456789abcdef" };
    const signed = await signLivePlayback({ ingest, tokenCache: createPlaybackTokenCache() }, "input-uid-1", new Date("2026-11-21T10:00:00Z"));
    const origin = new URL(signed.src).origin;
    expect(origin, "premise: the signer built the address on the configured host").toBe(`https://${HOST}`);
    expect(policy().get("connect-src")).toContain(origin);
    expect(policy().get("media-src")).toContain(origin);
    // The positive pair of "nothing else": a host the page does not request is not in the policy.
    expect(policy().get("media-src")).not.toContain("https://evil.example");
    expect(policy().get("connect-src")).not.toContain("https://evil.example");
  });

  it("no other directive moves: the host appears in connect-src and media-src only, and script-src/frame-src/img-src carry nothing of it", () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", HOST);
    let checked = 0;
    for (const [name, values] of policy()) {
      checked++;
      if (name === "connect-src" || name === "media-src") continue;
      expect(values.filter((v) => v.includes(HOST)), `${name} must not carry the playback host`).toEqual([]);
    }
    expect(checked, "anti-vacuity: every directive was inspected").toBeGreaterThanOrEqual(10);
  });

  it("the real response carries it: the public match page through proxy() (report-only), and an app page enforced", () => {
    vi.stubEnv("STREAM_PLAYBACK_HOST", HOST);
    const headerOf = (res: Response) =>
      res.headers.get("Content-Security-Policy") ?? res.headers.get("Content-Security-Policy-Report-Only") ?? "";
    const media = (csp: string) => directives(csp).get("media-src") ?? [];
    const route = "/live/riverside/summer-league/open/fixtures/8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
    const matchPage = proxy(new NextRequest(`http://localhost:3000${route}`));
    expect(matchPage.headers.get("Content-Security-Policy"), "the cacheable tree is report-only").toBeNull();
    expect(media(headerOf(matchPage))).toContain(`https://${HOST}`);
    vi.stubEnv("CSP_MODE", "enforce");
    expect(media(headerOf(proxy(new NextRequest("http://localhost:3000/dashboard")))), "enforce mode, an app page").toContain(`https://${HOST}`);
  });
});
