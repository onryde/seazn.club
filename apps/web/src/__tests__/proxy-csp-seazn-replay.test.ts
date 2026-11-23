// Seazn-hosted video, Phase 2 Task 25: the match page plays a replay host's copy in an <iframe> on the host's embed origin. The
// policy gains exactly that: `frame-src https://iframe.mediadelivery.net` (the brief's ruling, typed here), plus the fake host's
// `https://embed.fake.invalid` ONLY under the fake replay driver (local and CI), so the report names what the page will load there
// and a real deployment's policy carries no fake origin. Nothing else moves: no other directive names either host.
//
// The ONE value read from the code is the origin of a REAL signed address from each adapter (BunnyReplayHost / FakeReplayHost
// `signedEmbed`), to prove the policy allows what the frame will actually load.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { cspHeader, proxy } from "../proxy";
import { BunnyReplayHost } from "@/server/video/replay-bunny";
import { FakeReplayHost } from "@/server/video/replay-fake";

afterEach(() => vi.unstubAllEnvs());

const BUNNY = "https://iframe.mediadelivery.net";
const FAKE = "https://embed.fake.invalid";
const NOW = new Date("2026-11-22T10:00:00.000Z");
const directives = (csp: string): Map<string, string[]> =>
  new Map(csp.split("; ").map((d) => { const [name, ...values] = d.replace(/'nonce-[^']+'/g, "'nonce-*'").split(" "); return [name!, values] as const; }));
const policy = () => directives(cspHeader("n").value);
/** frame-src as it was before Task 25 (proxy-csp tests pin those origins); the replay hosts are what follows them. */
const BEFORE = ["'self'", "https://js.stripe.com", "https://*.stripe.com", "https://hooks.stripe.com", "https://www.youtube-nocookie.com", "https://youtube-nocookie.com", "https://challenges.cloudflare.com"];

function bunnyOrigin(): string {
  const host = new BunnyReplayHost(
    { libraryId: "424242", apiKey: "k", readOnlyKey: "r", cdnHost: "vz-test0001.b-cdn.net", tokenKey: "t" },
    { fetchImpl: (async () => new Response("{}")) as typeof fetch, now: () => NOW, videoOrigins: () => ["stg.seazn.club"] },
  );
  return new URL(host.signedEmbed("3f1c2a9e-0b7d-4c55-9a61-2d8e4f7b1c03", NOW, 3600).src).origin;
}

describe("CSP for the Seazn replay frame (Task 25)", () => {
  it("a real deployment (REPLAY_DRIVER=bunny): frame-src gains exactly the host's embed origin, and no fake one", () => {
    vi.stubEnv("REPLAY_DRIVER", "bunny");
    expect(policy().get("frame-src")).toEqual([...BEFORE, BUNNY]);
  });

  it("the fake driver (local and CI): frame-src also names the fake's embed origin", () => {
    vi.stubEnv("REPLAY_DRIVER", "fake");
    vi.stubEnv("ENV_NAME", "ci");
    expect(policy().get("frame-src")).toEqual([...BEFORE, BUNNY, FAKE]);
  });

  it("a replay driver setting that throws (unset under a live relay, a typo) never takes the page down: the real origin stays, no fake one", () => {
    let checked = 0;
    for (const env of [{ RELAY_DRIVERS: "live", REPLAY_DRIVER: "" }, { REPLAY_DRIVER: "bunnny" }, { REPLAY_DRIVER: "fake", ENV_NAME: "production" }]) {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(() => cspHeader("n"), JSON.stringify(env)).not.toThrow();
      expect(policy().get("frame-src"), JSON.stringify(env)).toEqual([...BEFORE, BUNNY]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("allows what the frame will actually load: each adapter's REAL signed address has its origin in frame-src", () => {
    vi.stubEnv("REPLAY_DRIVER", "fake");
    vi.stubEnv("ENV_NAME", "local");
    const fake = new URL(new FakeReplayHost().signedEmbed("fake-video-1", NOW, 3600).src).origin;
    expect(fake, "premise: the fake signs on its own host").toBe(FAKE);
    expect(bunnyOrigin(), "premise: the adapter signs on the host's embed origin").toBe(BUNNY);
    expect(policy().get("frame-src")).toContain(fake);
    expect(policy().get("frame-src")).toContain(bunnyOrigin());
  });

  it("no other directive moves: neither embed origin appears anywhere but frame-src", () => {
    vi.stubEnv("REPLAY_DRIVER", "fake");
    vi.stubEnv("ENV_NAME", "ci");
    let checked = 0;
    for (const [name, values] of policy()) {
      checked++;
      if (name === "frame-src") continue;
      expect(values.filter((v) => v.includes("mediadelivery") || v.includes("embed.fake")), name).toEqual([]);
    }
    expect(checked, "anti-vacuity: every directive was inspected").toBeGreaterThanOrEqual(10);
  });

  it("review m1: the proxy imports no replay adapter — the hosts come from config.ts (import-free), never from server/video", () => {
    const source = readFileSync(join(__dirname, "..", "proxy.ts"), "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]!);
    expect(imports, "PREMISE: the proxy's imports were read").toContain("@/server/relay/config");
    expect(imports.filter((i) => i.includes("server/video")), "no adapter in the proxy").toEqual([]);
  });

  it("the real response carries it: the public match page through proxy() (report-only)", () => {
    vi.stubEnv("REPLAY_DRIVER", "bunny");
    const route = "/live/riverside/summer-league/open/fixtures/8c4f7a52-1f3e-4b9a-9d2c-3e5f6a7b8c9d";
    const res = proxy(new NextRequest(`http://localhost:3000${route}`));
    const csp = res.headers.get("Content-Security-Policy") ?? res.headers.get("Content-Security-Policy-Report-Only") ?? "";
    expect(directives(csp).get("frame-src")).toContain(BUNNY);
  });
});
