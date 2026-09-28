// server/relay/crypto.ts — AES-256-GCM envelope (design §6.2), keyed by RELAY_KEK (stream keys) or DEVICE_LINK_KEK (device-link secrets, scorer sheets §4.1).
// The ONLY module that turns a plaintext credential into a *_enc column value and back
// (enc-boundary.test.ts holds every other file to that). Layout, one buffer:
//
//   [0]      version (0x01)
//   [1..13)  wrap IV (12)        — for wrapping the DEK under the named KEK
//   [13..45) wrapped DEK (32)
//   [45..61) wrap auth tag (16)
//   [61..73) data IV (12)
//   [73..89) data auth tag (16)
//   [89..)   ciphertext
//
// A per-row DEK means rotating RELAY_KEK is a re-wrap of 32 bytes per row, not
// a re-encryption of every stream key; GCM's tag means a flipped byte throws
// instead of decrypting to a plausible wrong key.
// Lane-A minors, Task 6 review m5: the lane-wide `server-only` gap. This module
// reads RELAY_KEK and DEVICE_LINK_KEK and holds the seal/open pair; a client import would pull the
// key read into a browser bundle, and this marker is what turns that into a
// build failure rather than a shipped secret. See tokens.ts for the same note.
import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { destinationIdentity } from "@/lib/stream-destinations";

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = 1 + IV_LEN + KEY_LEN + TAG_LEN + IV_LEN + TAG_LEN; // 89

/** A KEK is 32 bytes written as exactly 64 hex characters, matched WHOLE before decoding: Buffer.from(hex, "hex")
 *  stops at the first non-hex character, so a length check on the decoded key accepted 65 characters, a junk suffix
 *  or a pasted trailing newline. Neither message echoes the value. */
const KEK_HEX = /^[0-9a-f]{64}$/i;

/** The two envelope keys. Separate on purpose (scorer sheets §4.1): a leaked
 *  RELAY_KEK opens stream keys, a leaked DEVICE_LINK_KEK opens printed scoring
 *  QRs, and neither opens the other. */
export type KekName = "RELAY_KEK" | "DEVICE_LINK_KEK";

function kek(name: KekName): Buffer {
  const hex = process.env[name];
  if (!hex) throw new Error(`${name} is not set (32 bytes as 64 hex chars; a Fly secret in prod)`);
  if (!KEK_HEX.test(hex)) throw new Error(`${name} must be exactly 64 hex characters (32 bytes)`);
  return Buffer.from(hex, "hex");
}

/** True when `name` holds a usable key: the SAME `KEK_HEX` rule `kek()`
 *  enforces. It is exported so callers that must fail closed (device-links.ts,
 *  owner ruling Q1) check it without re-implementing the pattern. */
export function hasValidKek(name: KekName): boolean {
  return KEK_HEX.test(process.env[name] ?? "");
}

export function sealWith(name: KekName, plain: string): Buffer {
  const dek = randomBytes(KEY_LEN);
  const dataIv = randomBytes(IV_LEN);
  const data = createCipheriv("aes-256-gcm", dek, dataIv);
  const body = Buffer.concat([data.update(plain, "utf8"), data.final()]);
  const dataTag = data.getAuthTag();

  const wrapIv = randomBytes(IV_LEN);
  const wrap = createCipheriv("aes-256-gcm", kek(name), wrapIv);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), wrapIv, wrapped, wrapTag, dataIv, dataTag, body]);
}

export function openWith(name: KekName, enc: Uint8Array): string {
  const b = Buffer.from(enc);
  if (b.length < HEADER_LEN) throw new Error("relay envelope too short");
  if (b[0] !== VERSION) throw new Error(`relay envelope version ${b[0]} is not supported`);
  const wrapIv = b.subarray(1, 13);
  const wrapped = b.subarray(13, 45);
  const wrapTag = b.subarray(45, 61);
  const dataIv = b.subarray(61, 73);
  const dataTag = b.subarray(73, 89);
  const body = b.subarray(89);

  const unwrap = createDecipheriv("aes-256-gcm", kek(name), wrapIv);
  unwrap.setAuthTag(wrapTag);
  const dek = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);

  const data = createDecipheriv("aes-256-gcm", dek, dataIv);
  data.setAuthTag(dataTag);
  return Buffer.concat([data.update(body), data.final()]).toString("utf8");
}

/** The relay's envelope — RELAY_KEK. Unchanged contract for every stream caller. */
export function seal(plain: string): Buffer {
  return sealWith("RELAY_KEK", plain);
}

export function open(enc: Uint8Array): string {
  return openWith("RELAY_KEK", enc);
}

/** HKDF `info` for the fingerprint key. Versioned so a future change of what is fingerprinted is a new key, not a
 *  silent collision with rows written under the old definition. */
const FINGERPRINT_INFO = "seazn/stream-destination-fingerprint/v1";

/**
 * A destination's fingerprint (owner ruling A19 + A19b, 2026-09-28): HMAC-SHA256, 64 lower-hex, over the url's
 * IDENTITY form (`destinationIdentity` — the scheme-default port dropped) and the stream key, under a key DERIVED from
 * RELAY_KEK by HKDF. V421's `org_stream_targets (org_id, dest_fingerprint)` unique index compares it, so one
 * destination is one target row per org.
 *
 * Keyed, because the column is plaintext: a bare hash of (url, key) would let anyone holding the table test
 * stream-key guesses offline. Derived, not the KEK itself, so the envelope key is never used for a second purpose.
 * The two fields are JSON-encoded as a pair, so no character can move across the url/key boundary into a collision.
 *
 * A refused URL has no identity and is refused here with a message that names neither the URL nor the key (either
 * can carry the secret). Rotating RELAY_KEK changes every fingerprint — a rotation owes a re-fingerprint pass.
 */
export function fingerprintDestination(url: string, streamKey: string): string {
  const identity = destinationIdentity(url);
  if (identity === null) throw new Error("stream destination is not dialable; it has no fingerprint");
  const key = Buffer.from(hkdfSync("sha256", kek("RELAY_KEK"), Buffer.alloc(0), FINGERPRINT_INFO, KEY_LEN));
  return createHmac("sha256", key).update(JSON.stringify([identity, streamKey])).digest("hex");
}
