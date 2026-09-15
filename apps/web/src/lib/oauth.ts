import "server-only";

export const OAUTH_STATE_COOKIE = "seazn_oauth_state";
/** Dedicated state cookie for Lichess link flow — must NOT share Google's
 *  `OAUTH_STATE_COOKIE` or a concurrent Google login steals/invalidates the
 *  Lichess callback (and vice versa). */
export const LICHESS_OAUTH_STATE_COOKIE = "seazn_lichess_oauth_state";
export const LICHESS_OAUTH_NEXT_COOKIE = "seazn_lichess_oauth_next";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

/** True when Google OAuth env vars are present. */
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * The app's external base URL. Prefers an explicit override so the redirect URI
 * always matches what is registered in the Google Cloud console; otherwise it
 * is derived from the incoming request's origin.
 */
export function baseUrl(req: Request): string {
  const override =
    process.env.OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (override) return override.replace(/\/$/, "");

  // Behind a reverse proxy (Fly.io), req.url is the internal binding
  // (http://0.0.0.0:3000). Reconstruct from forwarded headers instead.
  const headers = req instanceof Request ? new Headers((req as Request).headers) : new Headers();
  const forwardedHost = headers.get("x-forwarded-host");
  const forwardedProto = headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;

  return new URL(req.url).origin;
}

/** The Google redirect URI (must be registered in the Google console). */
export function googleRedirectUri(req: Request): string {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}/api/auth/google/callback`;
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
}

// --- Lichess (external play link; not sign-in) --------------------------------

export const LICHESS_AUTH_URL = "https://lichess.org/oauth";
export const LICHESS_TOKEN_URL = "https://lichess.org/api/token";
export const LICHESS_ACCOUNT_URL = "https://lichess.org/api/account";
/** challenge:write — create challenges as White; preference:read — account id. */
export const LICHESS_OAUTH_SCOPES = "challenge:write preference:read";

export function lichessConfigured(): boolean {
  return Boolean(process.env.LICHESS_CLIENT_ID && process.env.LICHESS_CLIENT_SECRET);
}

export function lichessRedirectUri(req: Request): string {
  return process.env.LICHESS_REDIRECT_URI || `${baseUrl(req)}/api/auth/lichess/callback`;
}

export interface LichessAccount {
  id: string;
  username: string;
}
