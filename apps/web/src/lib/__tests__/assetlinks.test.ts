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
/** The Play app-signing SHA-256s of `com.seazn.capture`, from the owner (2026-11-25), in this order. */
const PLAY_SHAS = [
  // current classic app signing key
  "C9:CA:20:3F:00:1D:66:32:A9:05:F7:BA:32:76:38:6F:95:38:28:E5:27:CD:F1:8C:AA:4E:2B:B1:8A:D1:5F:2E",
  // previous app signing key; the one in Play's asset links JSON
  "FA:51:ED:4F:3D:D9:E0:90:97:0F:86:21:BE:56:7B:2B:9C:B5:6C:21:4F:41:04:68:AA:0F:74:17:F3:A0:D1:3C",
  // post-quantum app signing key
  "7A:02:CF:5F:5F:3F:B4:45:D2:42:D1:B6:D8:CF:05:01:DD:52:FB:05:8A:74:62:C7:37:04:45:4B:10:33:C6:DD",
];
const PRODUCTION_LINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "com.seazn.capture", sha256_cert_fingerprints: PLAY_SHAS },
  },
];
/** An override list no real entry holds, to show what the override can and cannot change. */
const FAKE_PLAY_SHAS = [Array.from({ length: 32 }, () => "AB").join(":")];
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

  it("production lists exactly the Play app with exactly the three Play signing fingerprints", () => {
    expect(assetLinksFor("https://seazn.club")).toEqual(PRODUCTION_LINKS);
  });

  it("every production fingerprint is 32 uppercase colon-separated bytes, none twice", () => {
    const served = assetLinksFor("https://seazn.club").flatMap((link) => link.target.sha256_cert_fingerprints);
    let checked = 0;
    for (const fingerprint of served) {
      expect(fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
      checked++;
    }
    expect(checked).toBe(3);
    expect(new Set(served).size).toBe(3);
  });

  it("production is [] when the fingerprint list is empty", () => {
    expect(assetLinksFor("https://seazn.club", [])).toEqual([]);
    // The call after it is back on the real list.
    expect(assetLinksFor("https://seazn.club")).toEqual(PRODUCTION_LINKS);
  });

  it("staging lists exactly the dev twin", () => {
    expect(assetLinksFor("https://stg.seazn.club")).toEqual(STAGING_LINKS);
    // The Play list changes production only.
    expect(assetLinksFor("https://stg.seazn.club", FAKE_PLAY_SHAS)).toEqual(STAGING_LINKS);
    expect(assetLinksFor("https://stg.seazn.club", [])).toEqual(STAGING_LINKS);
  });

  it("any other origin gets [], with the real Play list or an overriding one", () => {
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
      expect(assetLinksFor(origin, FAKE_PLAY_SHAS), origin).toEqual([]);
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
    expect(await production.json()).toEqual(PRODUCTION_LINKS);
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
