// `/.well-known/assetlinks.json` (spec 2026-11-25 §5.2). Staging trusts the stock React Native debug keystore, which
// anyone can sign with, so the one thing that must never happen is that key (or the `.dev` package) on production. The
// fingerprint and package names are typed here from the spec, never read from the module under test. No sport is read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { assetLinksFor } from "@/lib/assetlinks";
import { GET, dynamic } from "@/app/.well-known/assetlinks.json/route";
import { proxy } from "@/proxy";

const DEBUG_SHA =
  "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C";
/** A stand-in for the Play app-signing SHA-256 the owner still owes. */
const FAKE_PLAY_SHA = Array.from({ length: 32 }, () => "AB").join(":");
const STAGING_LINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "com.seazn.capture.dev", sha256_cert_fingerprints: [DEBUG_SHA] },
  },
];

describe("assetLinksFor", () => {
  it("production never lists the debug key or the dev package", () => {
    const s = JSON.stringify(assetLinksFor("https://seazn.club"));
    expect(s).not.toContain("FA:C6:17");
    expect(s).not.toContain("com.seazn.capture.dev");
  });

  it("production is [] while the Play app-signing fingerprint is not supplied", () => {
    expect(assetLinksFor("https://seazn.club")).toEqual([]);
  });

  it("production, once the fingerprint is supplied, lists exactly the Play app and nothing of staging's", () => {
    const links = assetLinksFor("https://seazn.club", FAKE_PLAY_SHA);
    expect(links).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.seazn.capture", sha256_cert_fingerprints: [FAKE_PLAY_SHA] },
      },
    ]);
    expect(JSON.stringify(links)).not.toContain("FA:C6:17");
    expect(JSON.stringify(links)).not.toContain("com.seazn.capture.dev");
  });

  it("staging lists exactly the dev twin", () => {
    expect(assetLinksFor("https://stg.seazn.club")).toEqual(STAGING_LINKS);
    // A Play fingerprint changes production only.
    expect(assetLinksFor("https://stg.seazn.club", FAKE_PLAY_SHA)).toEqual(STAGING_LINKS);
  });

  it("any other origin gets [], even with the Play fingerprint supplied", () => {
    const others = [
      "http://localhost:3000",
      "https://seazn.club.evil.test",
      "not a url",
      "",
      "https://www.seazn.club",
      "https://games.seazn.club",
      "https://evilseazn.club",
      "https://xstg.seazn.club",
      "https://stg.seazn.club.evil.test",
      "https://seazn.club@evil.test",
    ];
    let checked = 0;
    for (const origin of others) {
      expect(assetLinksFor(origin), origin).toEqual([]);
      expect(assetLinksFor(origin, FAKE_PLAY_SHA), origin).toEqual([]);
      checked++;
    }
    expect(checked).toBe(10);
  });
});

describe("GET /.well-known/assetlinks.json", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("route answers 200 json with assetLinksFor(siteOrigin()), read on each request", async () => {
    vi.stubEnv("OAUTH_BASE_URL", "https://stg.seazn.club");
    const staging = GET();
    expect(staging.status).toBe(200);
    expect(staging.headers.get("content-type")).toContain("application/json");
    expect(staging.headers.get("location")).toBeNull();
    expect(await staging.json()).toEqual(STAGING_LINKS);

    // Second call, another origin: nothing is held over from the first.
    vi.stubEnv("OAUTH_BASE_URL", "https://seazn.club");
    const production = GET();
    expect(production.status).toBe(200);
    expect(production.headers.get("content-type")).toContain("application/json");
    expect(await production.json()).toEqual([]);
  });

  it("is dynamic, so a build-time origin is never baked into the response", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("the proxy, which runs on this path, neither redirects, rewrites nor refuses it", () => {
    const hosts = ["seazn.club", "stg.seazn.club", "games.seazn.club"];
    let checked = 0;
    for (const host of hosts) {
      const res = proxy(new NextRequest(`https://${host}/.well-known/assetlinks.json`, { headers: { host } }));
      expect(res.status, host).toBe(200);
      expect(res.headers.get("location"), host).toBeNull();
      expect(res.headers.get("x-middleware-rewrite"), host).toBeNull();
      expect(res.headers.get("x-middleware-next"), host).toBe("1");
      checked++;
    }
    expect(checked).toBe(3);
  });
});
