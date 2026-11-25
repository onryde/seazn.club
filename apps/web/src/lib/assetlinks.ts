// lib/assetlinks.ts — which Android app may take an origin's `/app/*` links (spec 2026-11-25 §5.2). Client-safe.

export type AssetLink = {
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
};

/** The Play APP-SIGNING SHA-256 of `com.seazn.capture` (Play Console, App integrity — not the upload key). Owed by the
 *  owner; production answers `[]` until it is set. */
const PLAY_SIGNING_SHA256: string | null = null;

/** The stock React Native debug keystore, which anyone can sign with: STAGING ONLY, never on production. */
const DEBUG_SIGNING_SHA256 =
  "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C";

const linkTo = (packageName: string, sha256: string): AssetLink => ({
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: [sha256] },
});

const hostnameOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
};

/** Exact hostnames only; every other origin gets `[]`. `playSha256` is passed by tests alone, so the production entry is
 *  proven before the real fingerprint exists. */
export function assetLinksFor(origin: string, playSha256: string | null = PLAY_SIGNING_SHA256): AssetLink[] {
  switch (hostnameOf(origin)) {
    case "seazn.club":
      return playSha256 ? [linkTo("com.seazn.capture", playSha256)] : [];
    case "stg.seazn.club":
      return [linkTo("com.seazn.capture.dev", DEBUG_SIGNING_SHA256)];
    default:
      return [];
  }
}
