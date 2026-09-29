// The envelope (design §6.2): a per-row data key, wrapped by RELAY_KEK. Claims:
// round-trip; a flipped byte anywhere (wrapped key, tag, body) throws rather
// than returning garbage (GCM authenticates); two seals of one plaintext differ
// in BOTH nonces (fresh DEK + fresh IVs — a repeated envelope would tell a
// reader which rows share a stream key, and a repeated wrap IV under the one
// long-lived KEK is GCM nonce reuse); and RELAY_KEK is exactly 64 hex chars.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { fingerprintDestination, hasValidKek, type KekName, open, openWith, seal, sealWith } from "../crypto";

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

// Scorer sheets §4.1 — the device-link secret is sealed under its OWN key. One
// leaked KEK must not open both the stream keys and every printed scoring QR.
describe("sealWith/openWith — DEVICE_LINK_KEK (scorer sheets §4.1)", () => {
  const savedDl = process.env.DEVICE_LINK_KEK;
  beforeAll(() => { process.env.DEVICE_LINK_KEK = randomBytes(32).toString("hex"); });
  afterAll(() => {
    if (savedDl === undefined) delete process.env.DEVICE_LINK_KEK;
    else process.env.DEVICE_LINK_KEK = savedDl;
  });

  it("round-trips a dl_ secret", () => {
    const secret = "dl_" + randomBytes(32).toString("base64url");
    expect(openWith("DEVICE_LINK_KEK", sealWith("DEVICE_LINK_KEK", secret))).toBe(secret);
  });

  it("a blob sealed under DEVICE_LINK_KEK does not open under RELAY_KEK, and vice versa", () => {
    expect(() => openWith("RELAY_KEK", sealWith("DEVICE_LINK_KEK", "dl_x"))).toThrow();
    expect(() => openWith("DEVICE_LINK_KEK", seal("rtmps://x"))).toThrow();
    // Positive pair: each key opens its own blob.
    expect(open(sealWith("RELAY_KEK", "rtmps://x"))).toBe("rtmps://x");
  });

  it("a flipped byte in the body throws instead of returning a plausible wrong secret", () => {
    const blob = sealWith("DEVICE_LINK_KEK", "dl_abc");
    blob[blob.length - 1] ^= 0x01;
    expect(() => openWith("DEVICE_LINK_KEK", blob)).toThrow();
  });

  it("names DEVICE_LINK_KEK when it is missing or malformed — never RELAY_KEK", () => {
    const keep = process.env.DEVICE_LINK_KEK;
    try {
      delete process.env.DEVICE_LINK_KEK;
      expect(() => sealWith("DEVICE_LINK_KEK", "dl_x")).toThrow(/DEVICE_LINK_KEK is not set/);
      expect(messageOf(() => sealWith("DEVICE_LINK_KEK", "dl_x")), "missing").not.toContain("RELAY_KEK");
      process.env.DEVICE_LINK_KEK = "abcd";
      expect(() => sealWith("DEVICE_LINK_KEK", "dl_x")).toThrow(/DEVICE_LINK_KEK must be exactly 64 hex/);
      expect(messageOf(() => sealWith("DEVICE_LINK_KEK", "dl_x")), "malformed").not.toContain("RELAY_KEK");
    } finally {
      process.env.DEVICE_LINK_KEK = keep;
    }
  });
});

/** Run `fn` with `name` set to `value`, or removed, restoring the previous state even when `fn` throws. */
function withKey(name: KekName, value: string | undefined, fn: () => void): void {
  const keep = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (keep === undefined) delete process.env[name];
    else process.env[name] = keep;
  }
}

// hasValidKek is the probe device-links.ts fails closed on (owner ruling Q1). It must say exactly what kek() says: a
// looser probe waves a mint through to a throw inside sealWith, a stricter one refuses a server whose key works.
describe("hasValidKek — kek()'s own whole-string rule, for the key it is asked about", () => {
  const hex64 = () => randomBytes(32).toString("hex");

  it("agrees with sealWith on every accepted and every refused value", () => {
    const cases: Record<string, string | undefined> = {
      unset: undefined,
      empty: "",
      short: "abcd",
      "65 chars": hex64() + "a",
      "junk suffix": hex64() + "zz",
      "trailing newline": hex64() + "\n",
      "non-hex inside": hex64().slice(0, 40) + "g" + hex64().slice(0, 23),
      "64 lowercase": hex64(),
      "64 UPPERCASE": hex64().toUpperCase(),
    };
    const accepted = ["64 lowercase", "64 UPPERCASE"];
    for (const [label, value] of Object.entries(cases)) {
      withKey("DEVICE_LINK_KEK", value, () => {
        const seals = (() => {
          try {
            sealWith("DEVICE_LINK_KEK", "dl_x");
            return true;
          } catch {
            return false;
          }
        })();
        expect(seals, `${label}: sealWith`).toBe(accepted.includes(label));
        expect(hasValidKek("DEVICE_LINK_KEK"), `${label}: hasValidKek`).toBe(accepted.includes(label));
      });
    }
  });

  it("reads the key it is asked about: one valid key never vouches for the other", () => {
    withKey("RELAY_KEK", hex64(), () =>
      withKey("DEVICE_LINK_KEK", undefined, () => {
        expect(hasValidKek("RELAY_KEK")).toBe(true);
        expect(hasValidKek("DEVICE_LINK_KEK")).toBe(false);
      }),
    );
    withKey("DEVICE_LINK_KEK", hex64(), () =>
      withKey("RELAY_KEK", undefined, () => {
        expect(hasValidKek("DEVICE_LINK_KEK")).toBe(true);
        expect(hasValidKek("RELAY_KEK")).toBe(false);
      }),
    );
  });
});

// A19 + A19b (owner 2026-09-28): the destination FINGERPRINT — HMAC-SHA256 under a key DERIVED from RELAY_KEK, over
// the identity-normalised url + stream key. It is what V421's `org_stream_targets (org_id, dest_fingerprint)` unique
// index compares, so one destination is one row and the one-live-session index holds per destination. Keyed on
// purpose: the column is plaintext, and a bare hash of (url, key) would let anyone holding the table test guesses
// of a stream key offline.
describe("fingerprintDestination (A19/A19b)", () => {
  const FB = "rtmps://live-api-s.facebook.com/rtmp/";
  const YT = "rtmp://a.rtmp.youtube.com/live2";

  it("64 lower-hex, stable for one destination; the explicit default port is the SAME fingerprint — rtmps :443 and rtmp :1935", () => {
    const fb = fingerprintDestination(FB, "FB-1");
    expect(fb).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDestination(FB, "FB-1")).toBe(fb);
    expect(fingerprintDestination("rtmps://live-api-s.facebook.com:443/rtmp/", "FB-1")).toBe(fb);
    const yt = fingerprintDestination(YT, "YT-1");
    expect(fingerprintDestination("rtmp://a.rtmp.youtube.com:1935/live2", "YT-1")).toBe(yt);
    expect(yt).not.toBe(fb);
  });

  it("a different key, a different destination, or a different KEK is a different fingerprint", () => {
    const base = fingerprintDestination(FB, "FB-1");
    expect(fingerprintDestination(FB, "FB-2")).not.toBe(base);
    expect(fingerprintDestination("rtmps://rtmp-api.facebook.com/rtmp/", "FB-1")).not.toBe(base);
    withKek(randomBytes(32).toString("hex"), () => {
      expect(fingerprintDestination(FB, "FB-1")).not.toBe(base);
    });
    // The field boundary is unambiguous: moving characters between url and key cannot collide.
    expect(fingerprintDestination("rtmps://live-api-s.facebook.com/rtmp/a", "b")).not.toBe(fingerprintDestination("rtmps://live-api-s.facebook.com/rtmp/", "ab"));
  });

  it("it is KEYED: neither a bare SHA-256 of the inputs nor an HMAC under the raw KEK (the fingerprint key is derived, not the envelope key reused)", () => {
    const fp = fingerprintDestination(FB, "FB-1");
    const input = JSON.stringify([FB, "FB-1"]);
    expect(fp).not.toBe(createHash("sha256").update(input).digest("hex"));
    expect(fp).not.toBe(createHmac("sha256", Buffer.from(process.env.RELAY_KEK!, "hex")).update(input).digest("hex"));
  });

  it("an undialable URL is never fingerprinted — refused with a message that echoes neither the URL nor the key; the missing KEK refuses the way seal does", () => {
    const msg = messageOf(() => fingerprintDestination("rtmps://127.0.0.1/app/SECRET-PATH", "SECRET-KEY"));
    expect(msg).not.toContain("SECRET");
    withKek(undefined, () => {
      expect(messageOf(() => fingerprintDestination(FB, "FB-1"))).toContain("RELAY_KEK is not set");
    });
  });
});
