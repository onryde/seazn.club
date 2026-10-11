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
import { LICHESS_LINK_ORG_PARAM } from "@/lib/lichess-link";
import { pkceChallenge, pkceVerifier } from "@/server/external-play/pkce";
import { orgBySlug } from "@/server/slug-resolve";
import {
  ONLINE_CHESS_DISABLED_CODE,
  onlineChessOffered,
} from "@/server/usecases/external-play/online-chess-flag";

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
  const url = new URL(req.url);
  let user: { id: string };
  try {
    user = await requireUser();
  } catch {
    // The whole start, query included: the club it names (T20) and its `next` must survive the login round trip, or
    // the start the user comes back to names no club and is refused.
    return redirectLocal(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  // T20: linking is how online chess STARTS for a player, and online chess is offered per club (the PostHog flag
  // `online-chess`). The start names its club (lib/lichess-link.ts); a start naming none, an unknown or renamed slug,
  // or a club not offered online chess is refused before anything is stored. Ahead of the configuration check: a
  // club without the feature is told it is unavailable, not that Lichess is unconfigured.
  const slug = url.searchParams.get(LICHESS_LINK_ORG_PARAM);
  const org = slug ? await orgBySlug(slug) : null;
  if (!org || !("id" in org) || !(await onlineChessOffered({ orgId: org.id, userId: user.id }))) {
    return NextResponse.json(
      { ok: false, error: "Online chess is not available for this organisation", code: ONLINE_CHESS_DISABLED_CODE },
      { status: 403 },
    );
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
  const next = safeNextPath(url.searchParams.get("next"));
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
  // §3.1: the grant is what lets our server submit this player's moves.
  params.set("scope", LICHESS_OAUTH_SCOPES);

  return NextResponse.redirect(`${LICHESS_AUTH_URL}?${params.toString()}`);
}
