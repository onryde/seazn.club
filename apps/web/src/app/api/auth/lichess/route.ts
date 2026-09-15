import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  LICHESS_AUTH_URL,
  LICHESS_OAUTH_SCOPES,
  OAUTH_STATE_COOKIE,
  lichessConfigured,
  lichessRedirectUri,
} from "@/lib/oauth";
import { requireUser } from "@/lib/auth";
import { redirectLocal } from "@/lib/http";

/** Start Lichess OAuth to link an account (requires signed-in Seazn user). */
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
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const next = new URL(req.url).searchParams.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    jar.set("seazn_oauth_next", next, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600,
    });
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LICHESS_CLIENT_ID as string,
    redirect_uri: lichessRedirectUri(req),
    scope: LICHESS_OAUTH_SCOPES,
    state,
  });

  return NextResponse.redirect(`${LICHESS_AUTH_URL}?${params.toString()}`);
}
