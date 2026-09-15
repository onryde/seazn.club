import { cookies } from "next/headers";
import {
  LICHESS_ACCOUNT_URL,
  LICHESS_OAUTH_NEXT_COOKIE,
  LICHESS_OAUTH_STATE_COOKIE,
  LICHESS_TOKEN_URL,
  lichessConfigured,
  lichessRedirectUri,
  type LichessAccount,
} from "@/lib/oauth";
import { requireUser } from "@/lib/auth";
import { redirectLocal } from "@/lib/http";
import { upsertLichessLink } from "@/server/usecases/external-accounts";

function fail(reason: string) {
  return redirectLocal(`/settings?tab=account&lichess=${reason}`);
}

/** Exchange Lichess OAuth code and store the linked account on the signed-in user. */
export async function GET(req: Request) {
  if (!lichessConfigured()) return fail("not_configured");

  let user;
  try {
    user = await requireUser();
  } catch {
    return redirectLocal("/login?error=lichess_session");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const expected = jar.get(LICHESS_OAUTH_STATE_COOKIE)?.value;
  jar.delete(LICHESS_OAUTH_STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return fail("oauth_state");
  }

  const tokenRes = await fetch(LICHESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: lichessRedirectUri(req),
      client_id: process.env.LICHESS_CLIENT_ID as string,
      client_secret: process.env.LICHESS_CLIENT_SECRET as string,
    }),
  });
  if (!tokenRes.ok) return fail("token");

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokenJson.access_token) return fail("token");

  const accountRes = await fetch(LICHESS_ACCOUNT_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!accountRes.ok) return fail("account");

  const account = (await accountRes.json()) as LichessAccount;
  if (!account.id || !account.username) return fail("account");

  const expiresAt =
    typeof tokenJson.expires_in === "number"
      ? new Date(Date.now() + tokenJson.expires_in * 1000)
      : undefined;

  await upsertLichessLink(user.id, {
    externalUserId: account.id,
    username: account.username,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    tokenExpiresAt: expiresAt,
  });

  const next = jar.get(LICHESS_OAUTH_NEXT_COOKIE)?.value;
  jar.delete(LICHESS_OAUTH_NEXT_COOKIE);
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return redirectLocal(next.includes("?") ? `${next}&lichess=linked` : `${next}?lichess=linked`);
  }
  return redirectLocal("/settings?tab=account&lichess=linked");
}
