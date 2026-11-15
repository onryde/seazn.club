// Revshare constants shared by the server (lib/revshare.ts, `server-only`) and the
// browser (components/revshare-capture.tsx). One home for the cookie name and the
// ref_code alphabet, so the half that writes the cookie and the half that reads it
// cannot drift. Deliberately NOT `server-only`.

export const REVSHARE_COOKIE = "rs_ref";
export const REVSHARE_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** URL-safe, 1-64 chars. The cookie is client-writable, so the server re-checks it. */
export const REF_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Master switch. `NEXT_PUBLIC_*` is inlined at build time (Dockerfile ARG, fly.toml
 * [build.args]), so this is the same answer in the browser bundle and on the server.
 * Anything but "1" is OFF — an unset var must never turn affiliate tracking on:
 * stg builds with "0", prod with "1", local dev unset.
 */
export function revshareEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REVSHARE_ENABLED === "1";
}

/** The `document.cookie` assignment for a captured ref_code, or null if it is not a valid code. */
export function revshareCookieString(code: unknown, protocol: string): string | null {
  if (typeof code !== "string" || !REF_CODE_RE.test(code)) return null;
  const secure = protocol === "https:" ? "; Secure" : "";
  return `${REVSHARE_COOKIE}=${code}; Max-Age=${REVSHARE_COOKIE_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
}
