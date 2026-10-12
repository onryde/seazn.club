// T14 review m4 — the match room's camera tile joins RealtimeKit from the
// browser (camera-loader.ts → @cloudflare/realtimekit), so the page's CSP
// connect-src must admit the SDK's own hosts. The list is Cloudflare's
// "Network allowlist" for RealtimeKit Core (developers.cloudflare.com/
// realtime/realtimekit/network-allowlist, read 2026-10-12); the Web UI Kit
// asset hosts and chat storage are not used here. Media (STUN/TURN) is
// WebRTC, which connect-src does not govern.
import { describe, expect, it } from "vitest";
import { cspHeader } from "../proxy";

const connectSrc = () => cspHeader("n").value.split("; ").find((d) => d.startsWith("connect-src "))!.split(" ").slice(1);

/** CSP host-source matching (CSP3 §6.7.2.6), enough for scheme + host:
 *  `scheme://host`, with a leading `*.` matching any subdomain. */
function allows(sources: string[], url: string): boolean {
  const u = new URL(url);
  return sources.some((src) => {
    const m = /^([a-z]+):\/\/(\*\.)?([^/:]+)$/.exec(src);
    if (!m || `${m[1]}:` !== u.protocol) return false;
    return m[2] ? u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3];
  });
}

describe("CSP connect-src for RealtimeKit (review m4)", () => {
  it("admits every RealtimeKit Core SDK host Cloudflare lists, signalling over wss", () => {
    const want = [
      "https://api.realtime.cloudflare.com/v2/meetings",
      "https://api-silos.realtime.cloudflare.com/logs",
      "https://da-collector.realtime.cloudflare.com/stats",
      "https://location.realtime.cloudflare.com/",
      "wss://socket-edge.realtime.cloudflare.com/ws",
    ];
    let checked = 0;
    for (const url of want) {
      expect(allows(connectSrc(), url), url).toBe(true);
      checked += 1;
    }
    expect(checked, "anti-vacuity: hosts").toBe(5);
  });

  it("and no wider: another Cloudflare host, or plain http, is still refused", () => {
    expect(allows(connectSrc(), "https://api.cloudflare.com/client/v4")).toBe(false);
    expect(allows(connectSrc(), "http://api.realtime.cloudflare.com/")).toBe(false);
  });
});
