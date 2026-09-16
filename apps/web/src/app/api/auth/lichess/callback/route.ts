import { cookies } from "next/headers";
import {
  LICHESS_ACCOUNT_URL,
  LICHESS_OAUTH_NEXT_COOKIE,
  LICHESS_OAUTH_STATE_COOKIE,
  LICHESS_OAUTH_VERIFIER_COOKIE,
  LICHESS_TOKEN_URL,
  lichessConfigured,
  lichessRedirectUri,
  type LichessAccount,
} from "@/lib/oauth";
import { requireUser, safeNextPath } from "@/lib/auth";
import { redirectLocal } from "@/lib/http";
import { upsertLichessLink } from "@/server/usecases/external-accounts";
import { LICHESS_TIMEOUT_MS } from "@/server/external-play/window";

/** Where a linked / failed flow lands: the validated `next` it started from,
 *  or `/me` (the player home — design §12) when there was none. `next` may
 *  already carry its own query string (e.g. `/settings?tab=account`), so the
 *  separator is chosen rather than always `?`. */
function landing(next: string | null, query: string): string {
  const base = next ?? "/me";
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

function fail(next: string | null, reason: string) {
  return redirectLocal(landing(next, `lichess=${reason}`));
}

/** Exchange the Lichess OAuth code (PKCE, no client secret), read the
 *  account's identity, revoke the token immediately, and store id + username
 *  only — never the token itself. */
export async function GET(req: Request) {
  if (!lichessConfigured()) return fail(null, "not_configured");

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
  const expectedState = jar.get(LICHESS_OAUTH_STATE_COOKIE)?.value;
  const verifier = jar.get(LICHESS_OAUTH_VERIFIER_COOKIE)?.value;
  // Re-validated here too (not just at the start route) — a guard another
  // guard covers for is a guard nothing tests (see safe-next-path.test.ts).
  const next = safeNextPath(jar.get(LICHESS_OAUTH_NEXT_COOKIE)?.value ?? null);
  jar.delete(LICHESS_OAUTH_STATE_COOKIE);
  jar.delete(LICHESS_OAUTH_VERIFIER_COOKIE);
  jar.delete(LICHESS_OAUTH_NEXT_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return fail(next, "oauth_state");
  }

  // Set as soon as the token exchange succeeds, so the `finally` below can
  // revoke it on EVERY exit path from here on — including the account read
  // failing — not only the happy path.
  let accessToken: string | undefined;
  try {
    const tokenRes = await fetch(LICHESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: lichessRedirectUri(req),
        client_id: process.env.LICHESS_CLIENT_ID as string,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return fail(next, "token");

    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    accessToken = tokenJson.access_token;
    if (!accessToken) return fail(next, "token");

    const accountRes = await fetch(LICHESS_ACCOUNT_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    if (!accountRes.ok) return fail(next, "account");

    const account = (await accountRes.json()) as LichessAccount;
    if (!account.id || !account.username) return fail(next, "account");

    await upsertLichessLink(user.id, {
      externalUserId: account.id,
      username: account.username,
    });

    return redirectLocal(landing(next, "lichess=linked"));
  } finally {
    // Identity only, never the token (design §5, §6). Best-effort: a revoke
    // that fails leaves an orphaned grant on Lichess's side, not a security
    // hole on ours, since nothing here ever persists the token to reuse it.
    if (accessToken) {
      await fetch(LICHESS_TOKEN_URL, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
      }).catch(() => undefined);
    }
  }
}
