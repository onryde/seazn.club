// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md): the two guest credentials.
//
//  - The HOME TOKEN (`qm_…`) opens one quick match's home page. Stored twice, the device-link way: its sha256 (the
//    lookup key) and its sealed envelope under DEVICE_LINK_KEK (so the page link can be shown again, C19).
//  - The VISITOR KEY (`qv_…`) rides in an HttpOnly cookie minted on the first create; only its sha256 is stored. It
//    counts a visitor's alive quick matches against the cap and is never a credential to a match on its own.
//
// Import-light on purpose: no database, no session — every helper is pure or reads its KEK from process.env per call.
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "@/lib/errors";
import { hasValidKek, isWellFormedEnvelope, openWith, sealWith, type KekName } from "@/server/relay/crypto";

export const QUICK_MATCH_TOKEN_PREFIX = "qm_";
export const QUICK_MATCH_VISITOR_COOKIE = "seazn_qm_visitor";
/** 400 days: the most a browser keeps a cookie (RFC 6265bis caps Max-Age there). */
export const QUICK_MATCH_VISITOR_COOKIE_MAX_AGE_S = 400 * 24 * 3600;

const VISITOR_KEY_PREFIX = "qv_";
/** 32 random bytes as unpadded base64url: always 43 characters. */
const BODY = "[A-Za-z0-9_-]{43}";
const HOME_TOKEN_SHAPE = new RegExp(`^${QUICK_MATCH_TOKEN_PREFIX}${BODY}$`);
const VISITOR_KEY_SHAPE = new RegExp(`^${VISITOR_KEY_PREFIX}${BODY}$`);

/** The same fail-closed refusal device links answer with (device-links.ts, owner ruling Q1): a server without the key
 *  is a configuration gap the guest can report, never a bare 500 and never an unsealed token. */
const KEK_MISSING = "Quick matches are not configured on this server (DEVICE_LINK_KEK missing or malformed)";

/** The home token rides on the device-link key (C19): the one name every seal, open and refusal below reads. */
const HOME_TOKEN_KEK: KekName = "DEVICE_LINK_KEK";

function assertKekConfigured(): void {
  if (!hasValidKek(HOME_TOKEN_KEK)) {
    throw new HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING");
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function mintHomeToken(): string {
  return QUICK_MATCH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** sha256 hex — the same recipe as hashDeviceLinkToken. */
export function hashHomeToken(secret: string): string {
  return sha256Hex(secret);
}

export function sealHomeToken(secret: string): Buffer {
  assertKekConfigured();
  return sealWith(HOME_TOKEN_KEK, secret);
}

/** The THROWING open, for a caller whose whole answer is the token. The KEK is checked BEFORE openWith (pre-flight A6),
 *  so a missing or malformed key is the 503 DEVICE_LINK_KEK_MISSING rather than crypto's plain Error; a damaged or
 *  wrong-key envelope throws openWith's own Error. A page that only rebuilds `/q/<token>` as an extra (the pad's back
 *  link, the recent strip, the account list) must never 500 on it: it calls `tryOpenHomeToken` below instead
 *  (controller ruling 2026-11-08). */
export function openHomeToken(enc: Uint8Array): string {
  assertKekConfigured();
  return openWith(HOME_TOKEN_KEK, enc);
}

export type HomeTokenOpenRefusal = "kek_missing" | "malformed" | "rejected";
export type HomeTokenOpen = { ok: true; token: string } | { ok: false; reason: HomeTokenOpenRefusal };

/** The NON-throwing open (controller ruling 2026-11-08): the token, or why not, decided in this order.
 *  - `kek_missing`: no usable DEVICE_LINK_KEK (unset or malformed), a configuration gap. Checked first, so under no key
 *    the key is the answer whatever the row holds.
 *  - `malformed`: the stored bytes are not an envelope (too short, or a version this envelope never had): a damaged row.
 *  - `rejected`: a sound envelope that does not authenticate: the key is not the one that sealed it (a KEK rotated
 *    without re-sealing) or the bytes were altered. AES-GCM cannot tell those two apart.
 *  Decided by `hasValidKek` and `isWellFormedEnvelope`, never by an error's message. */
export function tryOpenHomeToken(enc: Uint8Array): HomeTokenOpen {
  if (!hasValidKek(HOME_TOKEN_KEK)) return { ok: false, reason: "kek_missing" };
  if (!isWellFormedEnvelope(enc)) return { ok: false, reason: "malformed" };
  try {
    return { ok: true, token: openWith(HOME_TOKEN_KEK, enc) };
  } catch {
    return { ok: false, reason: "rejected" };
  }
}

export function mintVisitorKey(): string {
  return VISITOR_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** sha256 hex (64 chars): the only form of the visitor key the database ever sees. */
export function hashVisitorKey(key: string): string {
  return sha256Hex(key);
}

export function isHomeTokenShaped(s: string): boolean {
  return HOME_TOKEN_SHAPE.test(s);
}

/** A cookie that fails this is re-minted, never trusted (pre-flight B2a). */
export function isVisitorKeyShaped(s: string): boolean {
  return VISITOR_KEY_SHAPE.test(s);
}
