import "server-only";
// The player's Lichess OAuth token at rest (design §3.1). The envelope is
// server/relay/crypto.ts's — V417 gave the device link exactly this shape —
// under its OWN key, LICHESS_TOKEN_KEK. This module is the only place that
// names that key. (The email outbox seals queued email bodies under a key of
// its own, EMAIL_OUTBOX_KEK, so rotating this one never strands queued mail.)
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
