// Task 17 — a player's Lichess token, sealed the way the server seals it, so
// the walkthrough's players hold a token the server can OPEN and send to the
// Lichess fixture server. The runner cannot import src/server/relay/crypto.ts
// (it is `server-only`), so the envelope is written here, byte for byte the
// same layout (design §6.2): [0x01][wrap IV 12][wrapped DEK 32][wrap tag 16]
// [data IV 12][data tag 16][body], AES-256-GCM, a fresh DEK per row, the DEK
// wrapped under LICHESS_TOKEN_KEK — which the runner and the server must share
// (CI sets one value for both; e2e-local.md says so). src/server/external-play/
// __tests__/e2e-seams.test.ts proves the product's openPlayerToken opens it.
import { createCipheriv, randomBytes } from "node:crypto";

const VERSION = 0x01;
const KEK_HEX = /^[0-9a-f]{64}$/i;

export function sealLichessTokenForE2e(plain: string): Buffer {
  const hex = process.env.LICHESS_TOKEN_KEK ?? "";
  if (!KEK_HEX.test(hex)) {
    throw new Error(
      "sealLichessTokenForE2e: LICHESS_TOKEN_KEK must be 64 hex characters, and the SAME value the server under test " +
        "runs with — otherwise the server cannot open the token and every Lichess call fails as LICHESS_TOKEN_UNAVAILABLE",
    );
  }
  const dek = randomBytes(32);
  const dataIv = randomBytes(12);
  const data = createCipheriv("aes-256-gcm", dek, dataIv);
  const body = Buffer.concat([data.update(plain, "utf8"), data.final()]);
  const dataTag = data.getAuthTag();
  const wrapIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), wrapIv);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), wrapIv, wrapped, wrapTag, dataIv, dataTag, body]);
}
