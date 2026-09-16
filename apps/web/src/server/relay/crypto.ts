// server/relay/crypto.ts — AES-256-GCM envelope (design §6.2). The ONLY module
// that turns a plaintext credential into a *_enc column value and back
// (enc-boundary.test.ts holds every other file to that). Layout, one buffer:
//
//   [0]      version (0x01)
//   [1..13)  wrap IV (12)        — for wrapping the DEK under RELAY_KEK
//   [13..45) wrapped DEK (32)
//   [45..61) wrap auth tag (16)
//   [61..73) data IV (12)
//   [73..89) data auth tag (16)
//   [89..)   ciphertext
//
// A per-row DEK means rotating RELAY_KEK is a re-wrap of 32 bytes per row, not
// a re-encryption of every stream key; GCM's tag means a flipped byte throws
// instead of decrypting to a plausible wrong key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = 1 + IV_LEN + KEY_LEN + TAG_LEN + IV_LEN + TAG_LEN; // 89

function kek(): Buffer {
  const hex = process.env.RELAY_KEK;
  if (!hex) throw new Error("RELAY_KEK is not set (32 bytes as 64 hex chars; a Fly secret in prod)");
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_LEN) throw new Error("RELAY_KEK must be exactly 32 bytes of hex");
  return key;
}

export function seal(plain: string): Buffer {
  const dek = randomBytes(KEY_LEN);
  const dataIv = randomBytes(IV_LEN);
  const data = createCipheriv("aes-256-gcm", dek, dataIv);
  const body = Buffer.concat([data.update(plain, "utf8"), data.final()]);
  const dataTag = data.getAuthTag();

  const wrapIv = randomBytes(IV_LEN);
  const wrap = createCipheriv("aes-256-gcm", kek(), wrapIv);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), wrapIv, wrapped, wrapTag, dataIv, dataTag, body]);
}

export function open(enc: Uint8Array): string {
  const b = Buffer.from(enc);
  if (b.length < HEADER_LEN) throw new Error("relay envelope too short");
  if (b[0] !== VERSION) throw new Error(`relay envelope version ${b[0]} is not supported`);
  const wrapIv = b.subarray(1, 13);
  const wrapped = b.subarray(13, 45);
  const wrapTag = b.subarray(45, 61);
  const dataIv = b.subarray(61, 73);
  const dataTag = b.subarray(73, 89);
  const body = b.subarray(89);

  const unwrap = createDecipheriv("aes-256-gcm", kek(), wrapIv);
  unwrap.setAuthTag(wrapTag);
  const dek = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);

  const data = createDecipheriv("aes-256-gcm", dek, dataIv);
  data.setAuthTag(dataTag);
  return Buffer.concat([data.update(body), data.final()]).toString("utf8");
}
