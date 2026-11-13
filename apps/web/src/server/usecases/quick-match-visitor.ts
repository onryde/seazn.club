import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.2; plan 2 Task 3): the visitor key's
// cookie, read from the request and minted when it is absent or malformed.
//
// The key counts a visitor's alive quick matches against the cap and lists their recent ones; it is never a credential
// to a match on its own (quick-match-tokens.ts). Read from the REQUEST's cookies (pre-flight B3a), never `next/headers`,
// so the create route's test feeds the real Set-Cookie value back as a Cookie header.
import {
  hashVisitorKey,
  isVisitorKeyShaped,
  mintVisitorKey,
  QUICK_MATCH_VISITOR_COOKIE,
  QUICK_MATCH_VISITOR_COOKIE_MAX_AGE_S,
} from "./quick-match-tokens";

export interface Visitor {
  /** The key in the clear: it goes back in the cookie, and nowhere else. */
  key: string;
  /** sha256 hex of the key: the only form the database sees. */
  hash: string;
  /** True when this request had no usable key, so the response must set the cookie. */
  minted: boolean;
}

/** The visitor this request names, or a fresh one. A cookie that is not a visitor key's shape (`isVisitorKeyShaped`) is
 *  never trusted and never hashed into a row: it is replaced (pre-flight B2a, B3b). */
export function readOrMintVisitor(cookies: { get(name: string): { value: string } | undefined }): Visitor {
  const held = cookies.get(QUICK_MATCH_VISITOR_COOKIE)?.value;
  if (held !== undefined && isVisitorKeyShaped(held)) return { key: held, hash: hashVisitorKey(held), minted: false };
  const key = mintVisitorKey();
  return { key, hash: hashVisitorKey(key), minted: true };
}

/** HttpOnly (no script reads it), SameSite=Lax, site-wide, for the 400 days a browser keeps a cookie at most. Secure in
 *  production, as the referral cookie is (`app/refer/[code]/route.ts`), so a plain-http dev server still keeps it. */
export function visitorCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: QUICK_MATCH_VISITOR_COOKIE_MAX_AGE_S,
  } as const;
}
