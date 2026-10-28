// YouTube Connect T16 (owner ruling O4): the public match page embeds a replay behind a click-to-play facade. The policy gains
// exactly what that needs and nothing else:
//   frame-src  the privacy-enhanced embed host, www.youtube-nocookie.com and youtube-nocookie.com
//   img-src    the video's public thumbnail host, i.ytimg.com (the broad `https:` already covers it today; the explicit origin is
//              the declaration, so a later tightening of `https:` cannot silently break the facade)
// No other directive moves, and no `youtube.com` origin (the cookie-setting embed host) appears anywhere.
//
// Expected policies are typed from the ruling. The one declared source read from the code is lib/youtube.ts's embed and
// thumbnail origins, to prove the policy allows what the component will actually request (a URL builder and a policy that
// drifted apart would be a facade that loads and a player that does not).
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cspHeader, proxy } from "../proxy";
import { youtubeEmbedUrl, youtubeThumbnailUrl } from "../lib/youtube";

afterEach(() => vi.unstubAllEnvs());

const directives = (csp: string): Map<string, string[]> =>
  new Map(csp.split("; ").map((d) => { const [name, ...values] = d.replace(/'nonce-[^']+'/g, "'nonce-*'").split(" "); return [name!, values] as const; }));
const policy = () => directives(cspHeader("n").value);

describe("CSP for the replay player", () => {
  it("frame-src is exactly the existing origins plus the two privacy-enhanced embed hosts", () => {
    expect(policy().get("frame-src")).toEqual([
      "'self'", "https://js.stripe.com", "https://*.stripe.com", "https://hooks.stripe.com",
      "https://www.youtube-nocookie.com", "https://youtube-nocookie.com",
    ]);
  });

  it("img-src names the thumbnail host explicitly, beside what it already allowed", () => {
    expect(policy().get("img-src")).toEqual(["'self'", "blob:", "data:", "https:", "https://i.ytimg.com"]);
  });

  it("no other directive carries a YouTube or Google origin, and no policy anywhere names the cookie-setting youtube.com host", () => {
    let checked = 0;
    const csp = cspHeader("n").value;
    for (const [name, values] of policy()) {
      checked++;
      if (name === "frame-src" || name === "img-src") continue;
      expect(values.filter((v) => /youtube|ytimg|google/i.test(v)), `${name} must not move`).toEqual([]);
    }
    expect(checked, "anti-vacuity: every directive was inspected").toBeGreaterThanOrEqual(10);
    // `youtube-nocookie.com` contains "youtube"; the cookie-setting host is `youtube.com` with the dot boundary.
    expect(csp).not.toMatch(/youtube\.com/i);
    expect(csp).not.toMatch(/googlevideo|google\.com|googleapis/i);
  });

  it("script-src and connect-src are untouched: the player needs no script and no request from the page", () => {
    const p = policy();
    expect(p.get("script-src")!.join(" ")).not.toMatch(/youtube|ytimg|google/i);
    expect(p.get("connect-src")!.join(" ")).not.toMatch(/youtube|ytimg|google/i);
  });

  it("allows what the component will actually request: the embed's origin is in frame-src, the thumbnail's in img-src", () => {
    const id = "dQw4w9WgXcQ";
    const embedOrigin = new URL(youtubeEmbedUrl(id, "https://seazn.club")).origin;
    const thumbOrigin = new URL(youtubeThumbnailUrl(id)).origin;
    expect(policy().get("frame-src")).toContain(embedOrigin);
    expect(policy().get("img-src")).toContain(thumbOrigin);
    // The positive pair of "nothing else": a host the page does not request is not in the policy.
    expect(policy().get("frame-src")).not.toContain("https://www.youtube.com");
    expect(policy().get("frame-src")).not.toContain("https://evil.example");
  });

  it("the public match page's real response carries it (through proxy(), the real call site), report-only and enforced", () => {
    const route = "/shared/riverside/summer-league/open/fixtures/8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
    const headerOf = (res: Response) =>
      res.headers.get("Content-Security-Policy") ?? res.headers.get("Content-Security-Policy-Report-Only") ?? "";
    const frame = (csp: string) => directives(csp).get("frame-src") ?? [];
    expect(frame(headerOf(proxy(new NextRequest(`http://localhost:3000${route}`)))), "report-only mode").toContain("https://www.youtube-nocookie.com");
    vi.stubEnv("CSP_MODE", "enforce");
    expect(frame(headerOf(proxy(new NextRequest(`http://localhost:3000${route}`)))), "enforce mode").toContain("https://www.youtube-nocookie.com");
    expect(frame(headerOf(proxy(new NextRequest("http://localhost:3000/dashboard")))), "an app page").toContain("https://youtube-nocookie.com");
  });
});
