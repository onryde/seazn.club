// RT (lane-close fix, ruled 2026-09-29): the stream overlay's realtime KEY. A community org's OBS overlay gets
// real-time scores without the plan's `realtime`, and what earns it is a key the organiser's panel puts in the OBS URL
// it copies — not "a stream session happens to be up" (the predicate this replaced), and never a query flag a stranger
// can type. The token route (`/api/v1/public/fixtures/{id}/realtime-token`) mints on it only beside the declared
// overlay purpose and the org's `streaming.overlay`.
//
// Key = HMAC-SHA256(AUTH_SECRET, `overlay:{fixtureId}`), its first OVERLAY_KEY_BYTES as base64url. AUTH_SECRET because
// it is the server signing secret every environment already carries (relay/tokens.ts, usecases/checkin-token.ts) and a
// new env var is an owner-gated Fly secret. The `overlay:` prefix keeps the MAC out of every other message that secret
// signs — a JWT's signing input is `base64url(header).base64url(payload)` and never begins with it.
//
// Fixture-bound by construction, stable for the life of the secret (OBS keeps a browser source for months), and
// retired wholesale by rotating AUTH_SECRET. It grants only a subscriber token for a PUBLIC fixture's score channel:
// nothing a spectator of the public page could not already poll.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/** 128 bits — truncated for a short URL, never below a MAC's safe floor. Base64url of 16 bytes is 22 characters. */
export const OVERLAY_KEY_BYTES = 16;

function secret(): string | null {
  // No dev fallback (unlike lib/auth.ts): a publicly known key outside production would be a forgeable grant, and a
  // missing secret costs only the realtime upgrade — the overlay keeps its poll.
  const s = process.env.AUTH_SECRET;
  return s ? s : null;
}

function mac(key: string, fixtureId: string): string {
  return createHmac("sha256", key).update(`overlay:${fixtureId}`).digest().subarray(0, OVERLAY_KEY_BYTES).toString("base64url");
}

/** The key the panel appends to this fixture's OBS URL; null when the server has no signing secret (fail closed). */
export function overlayKeyFor(fixtureId: string): string | null {
  const s = secret();
  return s === null ? null : mac(s, fixtureId);
}

/** Does `key` verify for THIS fixture? Constant-time over equal-length bytes; anything else — absent, the wrong type,
 *  the wrong length, another fixture's key, no secret configured — is false, and nothing here throws. */
export function verifyOverlayKey(fixtureId: string, key: string | null | undefined): boolean {
  const s = secret();
  if (s === null || typeof key !== "string") return false;
  const want = Buffer.from(mac(s, fixtureId), "utf8");
  const got = Buffer.from(key, "utf8");
  // timingSafeEqual throws on a length mismatch; the length of a MAC is public, so refusing on it leaks nothing.
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}
