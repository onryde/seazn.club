// lib/assetlinks.ts — which Android app may take an origin's `/app/*` links (spec 2026-11-25 §5.2). Client-safe.

export type AssetLink = {
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
};

/** The Play APP-SIGNING SHA-256s of `com.seazn.capture` (Play Console, App integrity — not the upload key), supplied
 *  by the owner 2026-11-25. Public values. An empty list makes production answer `[]`. */
const PLAY_SIGNING_SHA256S: readonly string[] = [
  // Current classic app signing key.
  "C9:CA:20:3F:00:1D:66:32:A9:05:F7:BA:32:76:38:6F:95:38:28:E5:27:CD:F1:8C:AA:4E:2B:B1:8A:D1:5F:2E",
  // Previous app signing key; the one in Play's asset links JSON.
  "FA:51:ED:4F:3D:D9:E0:90:97:0F:86:21:BE:56:7B:2B:9C:B5:6C:21:4F:41:04:68:AA:0F:74:17:F3:A0:D1:3C",
  // Post-quantum app signing key.
  "7A:02:CF:5F:5F:3F:B4:45:D2:42:D1:B6:D8:CF:05:01:DD:52:FB:05:8A:74:62:C7:37:04:45:4B:10:33:C6:DD",
];

/** The stock React Native debug keystore, which anyone can sign with: STAGING ONLY, never on production. */
const DEBUG_SIGNING_SHA256 =
  "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C";

const linkTo = (packageName: string, sha256s: readonly string[]): AssetLink => ({
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: [...sha256s] },
});

const hostnameOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
};

/** Exact hostnames only; every other origin gets `[]`. `playSha256s` is passed by tests alone, to reach the empty list. */
export function assetLinksFor(origin: string, playSha256s: readonly string[] = PLAY_SIGNING_SHA256S): AssetLink[] {
  switch (hostnameOf(origin)) {
    case "seazn.club":
      return playSha256s.length > 0 ? [linkTo("com.seazn.capture", playSha256s)] : [];
    case "stg.seazn.club":
      return [linkTo("com.seazn.capture.dev", [DEBUG_SIGNING_SHA256])];
    default:
      return [];
  }
}
