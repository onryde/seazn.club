import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  LICHESS_AUTH_URL,
  LICHESS_OAUTH_NEXT_COOKIE,
  LICHESS_OAUTH_SCOPES,
  LICHESS_OAUTH_STATE_COOKIE,
  LICHESS_OAUTH_VERIFIER_COOKIE,
  lichessConfigured,
  lichessRedirectUri,
} from "@/lib/oauth";
import { requireUser, safeNextPath } from "@/lib/auth";
import { redirectLocal } from "@/lib/http";
import { pkceChallenge, pkceVerifier } from "@/server/external-play/pkce";

/** Short-lived cookies that only need to survive the round trip to Lichess
 *  and back — same shape as the Google flow's state cookie. */
const OAUTH_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 600,
};

/** Start Lichess OAuth (PKCE, public client) to link an account (requires a
 *  signed-in Seazn user). */
export async function GET(req: Request) {
  try {
    await requireUser();
  } catch {
    return redirectLocal("/login?next=/api/auth/lichess");
  }

  if (!lichessConfigured()) {
    return redirectLocal("/settings?tab=account&lichess=not_configured");
  }

  const state = crypto.randomUUID();
  const verifier = pkceVerifier();
  const jar = await cookies();
  jar.set(LICHESS_OAUTH_STATE_COOKIE, state, OAUTH_COOKIE_OPTS);
  jar.set(LICHESS_OAUTH_VERIFIER_COOKIE, verifier, OAUTH_COOKIE_OPTS);

  // Same rule as Google: same-origin path only. Reuses `safeNextPath` — the
  // only origin check in this repo (lib/auth.ts) — rather than a second,
  // parallel prefix check.
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  if (next) {
    jar.set(LICHESS_OAUTH_NEXT_COOKIE, next, OAUTH_COOKIE_OPTS);
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LICHESS_CLIENT_ID as string,
    redirect_uri: lichessRedirectUri(req),
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  // Reading /api/account (the only thing this token is ever used for) needs
  // no scope — see lib/oauth.ts. Omit the param entirely rather than send an
  // empty one.
  if (LICHESS_OAUTH_SCOPES) params.set("scope", LICHESS_OAUTH_SCOPES);

  return NextResponse.redirect(`${LICHESS_AUTH_URL}?${params.toString()}`);
}
