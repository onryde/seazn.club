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
import { lichessLanding, type LichessFlashCode } from "@/lib/lichess-link";
import { HttpError } from "@/lib/errors";
import { PLAY_SCOPES, upsertLichessLink } from "@/server/usecases/external-accounts";
import { LICHESS_TIMEOUT_MS } from "@/server/external-play/window";
import { playerTokenKeyUsable } from "@/server/external-play/secrets";
import { log } from "@/server/logger";

/** A failed flow lands where the start came from (lib/lichess-link.ts `lichessLanding`, shared with the start route's
 *  own refusal), carrying why. */
function fail(next: string | null, reason: LichessFlashCode) {
  return redirectLocal(lichessLanding(next, reason));
}

/** Exchange the Lichess OAuth code (PKCE, no client secret), read the
 *  account's identity, and KEEP the token sealed at rest (design §3.1 — our
 *  server submits this player's moves). The token is revoked here only when
 *  the link does NOT happen: an unusable grant must not be left live. */
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

  // Revoked on every exit path that does NOT end in a stored link. Set true
  // only after upsertLichessLink has returned.
  let linked = false;
  let accessToken: string | undefined;
  try {
    let tokenJson: { access_token?: string };
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
      tokenJson = (await tokenRes.json()) as { access_token?: string };
    } catch {
      // Network error / AbortSignal timeout — same outcome as a non-ok
      // response, not an uncaught 500.
      return fail(next, "token");
    }
    accessToken = tokenJson.access_token;
    if (!accessToken) return fail(next, "token");

    let account: LichessAccount;
    try {
      const accountRes = await fetch(LICHESS_ACCOUNT_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
      });
      if (!accountRes.ok) return fail(next, "account");
      account = (await accountRes.json()) as LichessAccount;
    } catch {
      // `accessToken` is already set, so the `finally` below still revokes it.
      return fail(next, "account");
    }
    if (!account.id || !account.username) return fail(next, "account");

    try {
      await upsertLichessLink(user.id, {
        externalUserId: account.id,
        username: account.username,
        // The grant we ASKED for: Lichess does not return the granted list on
        // this endpoint. assertLichessConsentForPlay (via lichessGrantPlays)
        // requires a consent timestamp and EVERY scope in PLAY_SCOPES on this
        // stored list, so a link made under a shorter list re-consents. A
        // grant the user narrowed at Lichess is not visible here: it surfaces
        // as a 401 at the first call that needs it, and T12 routes that to the
        // organiser queue.
        scopes: [...PLAY_SCOPES],
        token: accessToken,
      });
      linked = true;
    } catch (err) {
      // V451's second unique constraint: this Lichess account is already
      // linked to a DIFFERENT Seazn user — never steal the link. The token
      // is still revoked below, because this exit stored nothing.
      if (err instanceof HttpError && err.code === "LICHESS_ALREADY_LINKED") {
        return fail(next, "already_linked");
      }
      // T17B fix 2 (D6): the token cannot be sealed — LICHESS_TOKEN_KEK unset or malformed (the seal throws a plain
      // configuration Error). The same landing as every other exit, never a raw 500; the grant is revoked below.
      // Logged without the token or the error's text: the classification is what an operator acts on.
      if (!playerTokenKeyUsable()) {
        log.error({ userId: user.id, failure: "key_unavailable" }, "lichess callback: LICHESS_TOKEN_KEK unusable — the token cannot be sealed; nothing linked");
        return fail(next, "key_unavailable");
      }
      throw err;
    }

    return redirectLocal(lichessLanding(next, "linked"));
  } finally {
    // A grant we did not store is a grant nobody will ever use — revoke it.
    // Best-effort: a failed revoke leaves an orphan on Lichess's side, not a
    // hole on ours.
    if (accessToken && !linked) {
      await fetch(LICHESS_TOKEN_URL, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
      }).catch(() => undefined);
    }
  }
}
