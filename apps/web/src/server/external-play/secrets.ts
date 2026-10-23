import "server-only";
// The player's Lichess OAuth token at rest (design §3.1). The envelope is
// server/relay/crypto.ts's — V417 gave the device link exactly this shape —
// under its OWN key, LICHESS_TOKEN_KEK. This module is the only place that
// names that key FOR LICHESS TOKENS; since the email outbox (spec 2026-10-19,
// "Credentials at rest") server/email-outbox/seal.ts also seals under it, for the
// body of a sign-in or invite email. Two uses of one key that already ships on
// stg and prod, not a second key: a leaked LICHESS_TOKEN_KEK opens both.
//
// base64, not Buffer, because the declared interface is Promise<string>; the
// column is bytea, and external-accounts.ts converts at the SQL boundary. The
// async signature matches the authoritative interface — the crypto is sync.
import { hasValidKek, openWith, sealWith } from "@/server/relay/crypto";

/** Whether LICHESS_TOKEN_KEK is set and well-formed (64 hex). False is the
 *  `key_unavailable` case: a seal or an open under it throws a configuration
 *  error, never a crypto one. */
export function playerTokenKeyUsable(): boolean {
  return hasValidKek("LICHESS_TOKEN_KEK");
}

export async function sealPlayerToken(plain: string): Promise<string> {
  return sealWith("LICHESS_TOKEN_KEK", plain).toString("base64");
}

export async function openPlayerToken(sealed: string): Promise<string> {
  return openWith("LICHESS_TOKEN_KEK", Buffer.from(sealed, "base64"));
}
