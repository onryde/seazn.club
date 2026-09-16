// The envelope (design §6.2): a per-row data key, wrapped by RELAY_KEK. Three
// claims: round-trip; a flipped byte anywhere (wrapped key, tag, body) throws
// rather than returning garbage (GCM authenticates); two seals of one
// plaintext differ (fresh DEK + fresh IVs — a repeated envelope would tell a
// reader which rows share a stream key).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { open, seal } from "../crypto";

const saved = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => { process.env.RELAY_KEK = saved; });

describe("relay crypto — AES-256-GCM envelope", () => {
  it("round-trips a stream key, including non-ASCII", () => {
    const plain = "srt-passphrase-ÄÖÜ-🔑-" + randomBytes(8).toString("hex");
    expect(open(seal(plain))).toBe(plain);
  });

  it("two seals of one plaintext are different envelopes that both open", () => {
    const a = seal("same");
    const b = seal("same");
    expect(a.equals(b)).toBe(false);
    expect(open(a)).toBe("same");
    expect(open(b)).toBe("same");
  });

  it("a flipped byte in the wrapped key, the tag or the body throws; the untouched twin opens", () => {
    const env = seal("hold-this");
    expect(open(env)).toBe("hold-this");
    // Offsets from the envelope layout in crypto.ts: [0]=version, [1..13)=wrap
    // iv, [13..45)=wrapped DEK, [45..61)=wrap tag, [61..73)=data iv,
    // [73..89)=data tag, [89..)=body.
    for (const at of [20, 50, 80, env.length - 1]) {
      const bad = Buffer.from(env);
      bad[at] = bad[at]! ^ 0x01;
      expect(() => open(bad), `byte ${at}`).toThrow();
    }
  });

  it("refuses an unknown version byte and a short buffer", () => {
    const env = seal("v");
    const wrong = Buffer.from(env);
    wrong[0] = 9;
    expect(() => open(wrong)).toThrow(/version/);
    expect(() => open(env.subarray(0, 40))).toThrow(/short/);
  });

  it("refuses to run without a 32-byte RELAY_KEK", () => {
    const keep = process.env.RELAY_KEK;
    process.env.RELAY_KEK = "abcd";
    expect(() => seal("x")).toThrow(/RELAY_KEK/);
    process.env.RELAY_KEK = keep;
  });
});
