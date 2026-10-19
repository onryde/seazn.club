import "server-only";

export const OAUTH_STATE_COOKIE = "seazn_oauth_state";
/** Dedicated state cookie for Lichess link flow — must NOT share Google's
 *  `OAUTH_STATE_COOKIE` or a concurrent Google login steals/invalidates the
 *  Lichess callback (and vice versa). */
export const LICHESS_OAUTH_STATE_COOKIE = "seazn_lichess_oauth_state";
export const LICHESS_OAUTH_NEXT_COOKIE = "seazn_lichess_oauth_next";
/** PKCE code_verifier, round-tripped through the OAuth-start redirect the same
 *  way as state — see server/external-play/pkce.ts. */
export const LICHESS_OAUTH_VERIFIER_COOKIE = "seazn_lichess_oauth_verifier";

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

/** The only profile a sign-in may act on: Google vouches for the address, and
 *  there is one. The callback's `isVerified` is the sole producer. */
export type VerifiedGoogleProfile = GoogleProfile & { email: string; email_verified: true };

/** `/login?google=<code>` — why Google sign-in sent the person back. The login
 *  page maps the code to a sentence; an unknown code shows nothing. */
export const GOOGLE_FLASH_PARAM = "google";
export const GOOGLE_FLASH_EMAIL_UNVERIFIED = "email_unverified";

// --- Lichess (external play link; not sign-in) --------------------------------

export const LICHESS_AUTH_URL = "https://lichess.org/oauth";
export const LICHESS_TOKEN_URL = "https://lichess.org/api/token";
export const LICHESS_ACCOUNT_URL = "https://lichess.org/api/account";
/** Design §3.1 (2026-10-09, amended 2026-10-10): our server submits both
 *  players' moves with their own tokens, so the grant must carry `board:play`
 *  (submit a move, resign, offer a draw, abort), `challenge:write` (White's
 *  token challenges Black) and `challenge:read` (crash recovery lists White's
 *  outgoing challenges before deciding whether to re-create — without it that
 *  lookup is a measured 403; Task 9, I2). This REVERSES the identity-only flow
 *  this constant was empty for. Growing the list makes every existing link
 *  re-consent: the play gate demands EVERY scope here.
 *
 *  The literal lives HERE, and `server/usecases/external-accounts.ts` derives
 *  its `PLAY_SCOPES` from it — one source of truth, and this is the safe side
 *  of the boundary: external-accounts.ts already imports this module for
 *  `LICHESS_TOKEN_URL`, so importing PLAY_SCOPES back would close a cycle
 *  whose top-level `.join(" ")` runs before that module is initialised. */
export const LICHESS_OAUTH_SCOPES = "board:play challenge:write challenge:read";

/** True iff a Lichess client id is configured. PKCE public clients have no
 *  secret (design §4.5) — `LICHESS_CLIENT_SECRET` is not read here or anywhere
 *  in the OAuth flow. */
export function lichessConfigured(): boolean {
  return Boolean(process.env.LICHESS_CLIENT_ID);
}

export function lichessRedirectUri(req: Request): string {
  return process.env.LICHESS_REDIRECT_URI || `${baseUrl(req)}/api/auth/lichess/callback`;
}

export interface LichessAccount {
  id: string;
  username: string;
}
