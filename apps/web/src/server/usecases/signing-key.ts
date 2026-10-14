import "server-only";
// Shared HS256 signing key for stateless server-minted tokens (QR check-in,
// personal match-room links). Extracted from checkin-token.ts's secretKey()
// (PROMPT-53) so both token families sign/verify against the same key —
// behaviour-identical to the original, just no longer duplicated.
export function authSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("AUTH_SECRET environment variable is required in production");
    return new TextEncoder().encode("dev-insecure-secret-change-me");
  }
  return new TextEncoder().encode(secret);
}
