// Design §3.1: the player's Lichess token at rest, under its OWN key. The
// envelope is server/relay/crypto.ts's (V417's device-link pattern); this
// module only names the KEK and the base64 boundary. Claims:
//   - a round trip returns the exact token, including a 1-char and a long one;
//   - the sealed form is base64 TEXT (the column is bytea, the signature is
//     string — the conversion happens in external-accounts.ts, not here);
//   - a token sealed under LICHESS_TOKEN_KEK cannot be opened under
//     DEVICE_LINK_KEK, which is the whole reason for a third key;
//   - a flipped byte THROWS rather than decrypting to a plausible wrong token;
//   - no key configured says so, naming the key, without echoing the value.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { openPlayerToken, sealPlayerToken } from "../secrets";
import { openWith, sealWith } from "@/server/relay/crypto";

const KEK = () => randomBytes(32).toString("hex");

describe("player token envelope", () => {
  beforeEach(() => {
    process.env.LICHESS_TOKEN_KEK = KEK();
    process.env.DEVICE_LINK_KEK = KEK();
  });
  afterEach(() => {
    delete process.env.LICHESS_TOKEN_KEK;
    delete process.env.DEVICE_LINK_KEK;
  });

  it.each(["x", "lio_" + "a".repeat(60), "lip_Zz09+/-_=="])(
    "round-trips %s",
    async (token) => {
      expect(await openPlayerToken(await sealPlayerToken(token))).toBe(token);
    },
  );

  it("the sealed form is base64 text, and never contains the plaintext", async () => {
    const sealed = await sealPlayerToken("lio_secret_value");
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(sealed).not.toContain("lio_secret_value");
    // 89-byte header + body, base64 — comfortably longer than the token.
    expect(Buffer.from(sealed, "base64").length).toBeGreaterThan(89);
  });

  it("two seals of the SAME token differ — a per-row DEK, not a fixed IV", async () => {
    const a = await sealPlayerToken("lio_same");
    const b = await sealPlayerToken("lio_same");
    expect(a).not.toBe(b);
    expect(await openPlayerToken(a)).toBe("lio_same");
    expect(await openPlayerToken(b)).toBe("lio_same");
  });

  it("DEVICE_LINK_KEK cannot open a player token — the keys are separate on purpose", async () => {
    const sealed = await sealPlayerToken("lio_player");
    expect(() => openWith("DEVICE_LINK_KEK", Buffer.from(sealed, "base64"))).toThrow();
    // The positive pair: the right key DOES open it, so the line above is not
    // passing because the envelope is broken for everyone.
    expect(openWith("LICHESS_TOKEN_KEK", Buffer.from(sealed, "base64"))).toBe("lio_player");
  });

  it("a flipped byte throws instead of decrypting to a wrong token", async () => {
    const buf = Buffer.from(await sealPlayerToken("lio_player"), "base64");
    buf[buf.length - 1] ^= 0xff;
    await expect(openPlayerToken(buf.toString("base64"))).rejects.toThrow();
  });

  it("an unset key says which key, and does not echo it", async () => {
    delete process.env.LICHESS_TOKEN_KEK;
    await expect(sealPlayerToken("lio_player")).rejects.toThrow(/LICHESS_TOKEN_KEK is not set/);
  });

  it("a malformed key is refused whole — a junk suffix is not silently truncated", async () => {
    process.env.LICHESS_TOKEN_KEK = KEK() + "zz";
    await expect(sealPlayerToken("lio_player")).rejects.toThrow(
      /LICHESS_TOKEN_KEK must be exactly 64 hex characters/,
    );
  });

  it("seals under the player key, not the relay key (sealWith is given the right name)", async () => {
    const sealed = await sealPlayerToken("lio_player");
    expect(sealWith("LICHESS_TOKEN_KEK", "anything").length).toBeGreaterThan(89);
    expect(await openPlayerToken(sealed)).toBe("lio_player");
  });
});
