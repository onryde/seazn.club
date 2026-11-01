// server/sponsors/report-token.ts - R4 sponsors on stream: the report link's token (spec §4, §5.2). Its own module, with no
// database, so the scrub suites can mint REAL tokens without loading the report's readers.
import { createHash, randomBytes } from "node:crypto";

/** Spec §4: "Token: 32 random bytes". base64url, so it sits in a path segment as is (43 characters). */
const TOKEN_BYTES = 32;

/** A new report link token. Shown once, as `/r/sponsor/<token>`; only its hash is stored. */
export function mintReportToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** sha256 over the token's UTF-8: what `sponsor_report_links.token_hash` holds, and what S14 looks a visitor's token up by. */
export function hashReportToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
