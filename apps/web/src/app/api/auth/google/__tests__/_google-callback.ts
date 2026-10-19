// Shared harness for the Google callback suites. Only Google's HTTP is faked:
// `fetch` answers the token endpoint and the userinfo endpoint, and the
// callback route runs its own real decode (`await infoRes.json()`) over the
// body. The claims are therefore whatever a Google response could carry, not a
// hand-built `GoogleProfile` handed past the route's parsing.
import { vi } from "vitest";
import { GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, OAUTH_STATE_COOKIE } from "@/lib/oauth";

export const STATE = "state-from-the-start-hop";
export const NEXT_COOKIE = "seazn_oauth_next";
/** The cookie `createSession` writes. Not exported by lib/auth, so it is named
 *  here, and the verified-sign-in tests assert it IS present: a wrong name here
 *  would fail those, so the "no session" assertions cannot pass on a typo. */
export const SESSION_COOKIE = "seazn_session";

export type Claims = Record<string, unknown>;

/** A userinfo body for a Google account with the given address. */
export function claimsFor(sub: string, email: string | null, extra: Claims = {}): Claims {
  return {
    sub,
    ...(email === null ? {} : { email }),
    email_verified: true,
    name: "Gia Googler",
    picture: "https://lh3.googleusercontent.com/a/example",
    ...extra,
  };
}

/** Every shape of `email_verified` that is NOT the boolean `true`. Each one is
 *  something Google's response (or a proxy in front of it) could carry, and
 *  each must be refused — `Boolean(x)` / `x == "true"` style checks let several
 *  of these through. */
export const NOT_VERIFIED: { label: string; apply: (c: Claims) => Claims }[] = [
  { label: "false", apply: (c) => ({ ...c, email_verified: false }) },
  {
    label: "absent",
    apply: (c) => {
      const { email_verified: _drop, ...rest } = c;
      void _drop;
      return rest;
    },
  },
  { label: 'the string "true"', apply: (c) => ({ ...c, email_verified: "true" }) },
  { label: 'the string "false"', apply: (c) => ({ ...c, email_verified: "false" }) },
  { label: "null", apply: (c) => ({ ...c, email_verified: null }) },
  { label: "the number 1", apply: (c) => ({ ...c, email_verified: 1 }) },
  { label: "the number 0", apply: (c) => ({ ...c, email_verified: 0 }) },
  { label: "an empty string", apply: (c) => ({ ...c, email_verified: "" }) },
  { label: "an object", apply: (c) => ({ ...c, email_verified: {} }) },
];

/** Answer Google's two endpoints. Returns the URLs the route fetched. */
export function stubGoogle(claims: Claims): string[] {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      if (url === GOOGLE_TOKEN_URL) return Response.json({ access_token: "at-1", id_token: "not-read-by-the-route" });
      if (url === GOOGLE_USERINFO_URL) return Response.json(claims);
      throw new Error(`the callback fetched an unexpected URL: ${url}`);
    }),
  );
  return fetched;
}

/** Google's redirect back to us, carrying the code and the state the start hop minted. */
export const callbackRequest = () =>
  new Request(`http://localhost/api/auth/google/callback?code=auth-code&state=${STATE}`);

/** The state cookie the start hop would have left, planted into the test jar. */
export function plantState(jar: Map<string, string>): void {
  jar.set(OAUTH_STATE_COOKIE, STATE);
}

/** redirectLocal() emits a RELATIVE Location (lib/http.ts), so it needs a base to parse. */
export const locationOf = (res: Response): URL => new URL(res.headers.get("location") ?? "", "http://t");
