import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 §4.1 — 256 bits of entropy, base64url-encoded (43 chars, no
 *  padding). Kept in the OAuth-start verifier cookie and re-sent as
 *  `code_verifier` on the token exchange; the Lichess flow is a PUBLIC
 *  client (no `client_secret`), so this pairing with `pkceChallenge` below
 *  is the only proof the code exchange comes from the party that started
 *  the redirect. */
export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7636 §4.2 — S256: `code_challenge = BASE64URL(SHA256(verifier))`. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
