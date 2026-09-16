// The envelope (design §6.2): a per-row data key, wrapped by RELAY_KEK. Claims:
// round-trip; a flipped byte anywhere (wrapped key, tag, body) throws rather
// than returning garbage (GCM authenticates); two seals of one plaintext differ
// in BOTH nonces (fresh DEK + fresh IVs — a repeated envelope would tell a
// reader which rows share a stream key, and a repeated wrap IV under the one
// long-lived KEK is GCM nonce reuse); and RELAY_KEK is exactly 64 hex chars.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { open, seal } from "../crypto";

// The developer's KEK (from .env.local) is put back afterwards, or removed when there was none — never assigned
// `undefined`, which Node stores as the string "undefined". It is never printed: no assertion here reads it.
const saved = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (saved === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = saved;
});

/** Run `fn` with RELAY_KEK set to `value`, or removed, restoring the previous state even when `fn` throws. */
function withKek(value: string | undefined, fn: () => void): void {
  const keep = process.env.RELAY_KEK;
  if (value === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = value;
  try {
    fn();
  } finally {
    if (keep === undefined) delete process.env.RELAY_KEK;
    else process.env.RELAY_KEK = keep;
  }
}

function messageOf(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a throw, and the call returned");
}

describe("relay crypto — AES-256-GCM envelope", () => {
  it("round-trips a stream key, including non-ASCII", () => {
    const plain = "srt-passphrase-ÄÖÜ-🔑-" + randomBytes(8).toString("hex");
    expect(open(seal(plain))).toBe(plain);
  });

  it("two seals of one plaintext are different envelopes — a different wrap IV AND data IV — that both open", () => {
    const a = seal("same");
    const b = seal("same");
    expect(a.equals(b)).toBe(false);
    // Offsets from the envelope layout in crypto.ts: [1..13) wrap IV, [61..73) data IV. The whole-envelope inequality
    // above cannot see a constant wrap IV (the random DEK alone makes the envelopes differ), and a constant wrap IV
    // under the one long-lived KEK is GCM nonce reuse.
    expect(a.subarray(1, 13).equals(b.subarray(1, 13)), "wrap IV repeated").toBe(false);
    expect(a.subarray(61, 73).equals(b.subarray(61, 73)), "data IV repeated").toBe(false);
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
});

describe("RELAY_KEK — exactly 64 hex characters, checked whole", () => {
  const hex64 = () => randomBytes(32).toString("hex");

  it("unset or empty: seal and open both refuse with 'is not set'", () => {
    const env = seal("x");
    for (const value of [undefined, ""]) {
      withKek(value, () => {
        expect(() => seal("x"), `seal, ${JSON.stringify(value)}`).toThrow(/RELAY_KEK is not set/);
        expect(() => open(env), `open, ${JSON.stringify(value)}`).toThrow(/RELAY_KEK is not set/);
      });
    }
  });

  it("malformed — short, 65 chars, a junk suffix, a trailing newline, a non-hex char inside — is refused, and the message never echoes it", () => {
    // Buffer.from(hex, "hex") stops at the first non-hex character, so every one of these but "abcd" decodes to
    // 32 bytes: a length check on the DECODED key accepts them all.
    const malformed = {
      short: "abcd",
      "65 chars": hex64() + "a",
      "junk suffix": hex64() + "zz",
      "trailing newline": hex64() + "\n",
      "non-hex inside": hex64().slice(0, 40) + "g" + hex64().slice(0, 23),
    };
    for (const [name, value] of Object.entries(malformed)) {
      withKek(value, () => {
        const message = messageOf(() => seal("x"));
        expect(message, name).toMatch(/RELAY_KEK must be exactly 64 hex characters/);
        expect(message, name).not.toContain(value.trim());
      });
    }
  });

  it("the accepted twins: 64 lowercase and 64 UPPERCASE hex both seal and open; another KEK cannot open the envelope", () => {
    const lower = hex64();
    let env: Buffer = Buffer.alloc(0);
    withKek(lower, () => {
      env = seal("kek-twin");
      expect(open(env)).toBe("kek-twin");
    });
    withKek(lower.toUpperCase(), () => expect(open(env)).toBe("kek-twin"));
    withKek(hex64(), () => expect(() => open(env)).toThrow());
  });
});
