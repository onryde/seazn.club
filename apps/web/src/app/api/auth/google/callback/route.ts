import { cookies } from "next/headers";
import { sql } from "@/lib/db";
import { createSession, postAuthLanding, invalidateUser, safeNextPath } from "@/lib/auth";
import { stampTermsAcceptance } from "@/lib/legal";
import {
  GOOGLE_FLASH_EMAIL_UNVERIFIED,
  GOOGLE_FLASH_PARAM,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  OAUTH_STATE_COOKIE,
  googleConfigured,
  googleRedirectUri,
  type GoogleProfile,
  type VerifiedGoogleProfile,
} from "@/lib/oauth";
import { redirectLocal } from "@/lib/http";

// RELATIVE, so there is no origin to get wrong. This comment used to say
// "redirect against the external base URL, not req.url", and its diagnosis was
// right — req.url is the internal binding (http://0.0.0.0:3000), which sends
// the browser to an unreachable address — but `baseUrl(req)` only escapes that
// behind a proxy that actually sets x-forwarded-host; otherwise it falls back
// to `new URL(req.url).origin` and lands on the binding again. `req` is kept
// in the signature so every call site reads the same; it is deliberately
// unused now.
function fail(_req: Request, reason: string) {
  return redirectLocal(`/login?error=${reason}`);
}

const NEXT_COOKIE = "seazn_oauth_next";

/**
 * Google must itself vouch for the address before we act on it. A Google
 * account can carry an address Google never confirmed, and everything below
 * this gate trusts the address: it matches an existing Seazn account by it,
 * links the account to this Google identity and marks the email verified. So
 * the claim has to be exactly the boolean `true` — not truthy, so the string
 * "true", `1` and a missing claim are all refused — and there has to be an
 * address to vouch for.
 */
function isVerified(p: Partial<GoogleProfile>): p is VerifiedGoogleProfile {
  return p.email_verified === true && typeof p.email === "string" && p.email !== "";
}

/** No session, no account, no link: back to /login, saying why. The invite
 *  destination (if any, re-validated) rides along so the email-link alternative
 *  the notice offers still lands where the person was going. */
function refuseUnverifiedEmail(jar: Awaited<ReturnType<typeof cookies>>) {
  const next = safeNextPath(jar.get(NEXT_COOKIE)?.value);
  jar.delete(NEXT_COOKIE);
  const query = new URLSearchParams({ [GOOGLE_FLASH_PARAM]: GOOGLE_FLASH_EMAIL_UNVERIFIED });
  if (next) query.set("next", next);
  return redirectLocal(`/login?${query.toString()}`);
}

/** Handle Google's redirect: verify state, exchange code, upsert user, sign in. */
export async function GET(req: Request) {
  if (!googleConfigured()) return fail(req, "google_not_configured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return fail(req, "oauth_state");
  }

  // 1. Exchange the authorization code for tokens.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return fail(req, "oauth_token");
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return fail(req, "oauth_token");

  // 2. Fetch the user's profile.
  const infoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return fail(req, "oauth_userinfo");
  const profile = (await infoRes.json()) as Partial<GoogleProfile>;
  if (!profile.sub) return fail(req, "oauth_userinfo");

  // 3. Refuse an address Google has not verified — BEFORE any lookup, so the
  //    same gate covers a new account, an email match and a google_sub match
  //    (an account already linked whose Google address has since gone
  //    unverified is refused too).
  if (!isVerified(profile)) return refuseUnverifiedEmail(jar);

  // 4. Resolve to a user: by google_sub, then by email, else create one.
  const userId = await upsertGoogleUser(profile);
  // upsert may refresh display_name/avatar for an existing user.
  await invalidateUser(userId);
  // "Continue with Google" sits under the clickwrap notice (GDPR spec
  // 2026-07-14) — record acceptance; no-op if already stamped.
  await stampTermsAcceptance(userId);

  // 5. Sign in.
  await createSession(userId);

  // 6. Honor a saved destination (invite link); otherwise ensure the user has
  //    an org (auto-provisioned if none) and land on the dashboard.
  const next = jar.get(NEXT_COOKIE)?.value;
  jar.delete(NEXT_COOKIE);
  const landing = await postAuthLanding(userId, next);
  return redirectLocal(landing.redirect);
}

async function upsertGoogleUser(p: VerifiedGoogleProfile): Promise<string> {
  // The sub is the stable key and is looked up FIRST: an account already linked
  // to this Google identity signs in as itself, whatever address Google now
  // reports, and is never re-pointed at another Seazn account that happens to
  // own that address. (Unverified addresses never get this far — see isVerified.)
  const bySub = await sql<{ id: string }[]>`
    select id from users where google_sub = ${p.sub} limit 1`;
  if (bySub[0]) {
    // Refresh display name / avatar opportunistically.
    await sql`
      update users set
        display_name = coalesce(${p.name ?? null}, display_name),
        avatar_url   = coalesce(${p.picture ?? null}, avatar_url)
      where id = ${bySub[0].id}`;
    return bySub[0].id;
  }

  const byEmail = await sql<{ id: string }[]>`
    select id from users where email = ${p.email} limit 1`;
  if (byEmail[0]) {
    // Google verified the email (isVerified), so trust it here too.
    await sql`
      update users set
        google_sub = ${p.sub},
        email_verified = true,
        avatar_url = coalesce(${p.picture ?? null}, avatar_url)
      where id = ${byEmail[0].id}`;
    return byEmail[0].id;
  }

  const displayName = p.name || p.email.split("@")[0] || "Member";
  const [created] = await sql<{ id: string }[]>`
    insert into users
      (email, display_name, email_verified, google_sub, avatar_url)
    values (
      ${p.email},
      ${displayName},
      true,
      ${p.sub},
      ${p.picture ?? null}
    )
    returning id`;
  return created.id;
}
