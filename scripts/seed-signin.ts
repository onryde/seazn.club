/**
 * Passwordless sign-in for the seed scripts.
 *
 * The product signs in by emailed link and Google only (password sign-in was
 * removed 2026-10-19), so a seeder signs in the way scripts/smoke.ts does:
 * request a magic link, then consume the token the server hands back in
 * `login_url`. An unknown email creates the account, and consuming the link
 * verifies it and starts a session, which `call` keeps in its cookie jar.
 *
 * The server only returns `login_url` when `mayExposeDevLink()` allows it
 * (apps/web/src/lib/dev-links.ts): a development server, or a production-mode
 * harness server started with AUTH_DEV_LINKS=1. Against any other server there
 * is no way to read the link, and this throws saying so instead of looking
 * like a bad email.
 *
 * Extracted so it can be tested: the seed scripts call `main()` at import, so
 * nothing inside them is reachable from a spec.
 */
import type { ApiCall } from "./seed-resume.ts";

export interface SignedIn {
  has_org: boolean;
  org_id: string;
  redirect: string;
}

/** The one-time token in a `/magic-link?token=…` URL, or a thrown reason. */
export function loginTokenFrom(loginUrl: string | undefined): string {
  if (!loginUrl) {
    throw new Error(
      "seed sign-in: /api/auth/magic-link returned no login_url. The server only returns it in development or " +
        "with AUTH_DEV_LINKS=1; point the seeder at such a server.",
    );
  }
  let token: string | null;
  try {
    token = new URL(loginUrl).searchParams.get("token");
  } catch {
    throw new Error(`seed sign-in: login_url is not a URL: ${loginUrl}`);
  }
  if (!token) throw new Error(`seed sign-in: login_url carries no token: ${loginUrl}`);
  return token;
}

/** Request a magic link for `email`, consume it, and leave the session on `call`'s cookie jar. */
export async function signInByMagicLink(call: ApiCall, email: string): Promise<SignedIn> {
  const asked = (await call("/api/auth/magic-link", "POST", { email })) as { login_url?: string };
  const token = loginTokenFrom(asked.login_url);
  return (await call("/api/auth/magic-link/consume", "POST", { token })) as SignedIn;
}
