// RT (lane-close fix, ruled 2026-09-29): the stream overlay's realtime grant is a SIGNED key carried in the OBS URL the
// panel copies, not "a stream session is up". The rule, from the ruling: key = HMAC-SHA256 over `overlay:{fixtureId}`
// with an EXISTING server signing secret (AUTH_SECRET — no new env var), truncated and URL-safe; verified in constant
// time. Every expected value below is computed HERE from that rule with node's own crypto, never read back from the
// module under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { OVERLAY_KEY_BYTES, overlayKeyFor, verifyOverlayKey } from "../overlay-key";

const SECRET = "unit-overlay-key-secret-0123456789abcdef";
/** The ruling's construction, spelled independently of the module. */
const ruled = (secret: string, fixtureId: string): string =>
  createHmac("sha256", secret).update(`overlay:${fixtureId}`).digest().subarray(0, OVERLAY_KEY_BYTES).toString("base64url");

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("overlayKeyFor — the ruled construction", () => {
  it("is HMAC-SHA256(AUTH_SECRET, `overlay:{fixtureId}`), truncated to 16 bytes, base64url: 22 URL-safe characters, no padding", () => {
    expect(OVERLAY_KEY_BYTES, "128 bits: truncated, but never below a MAC's safe floor").toBe(16);
    let checked = 0;
    for (let i = 0; i < 12; i++) {
      const id = randomUUID();
      const key = overlayKeyFor(id);
      expect(key, id).toBe(ruled(SECRET, id));
      expect(key, "URL-safe as it stands: nothing a query string must escape").toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(encodeURIComponent(key!)).toBe(key);
      expect(overlayKeyFor(id), "deterministic — the panel's copy and the route's check agree").toBe(key);
      checked++;
    }
    expect(checked).toBe(12);
  });

  it("no AUTH_SECRET → no key at all (fail closed), and nothing verifies — not even the empty-secret MAC", () => {
    const id = randomUUID();
    const underSecret = overlayKeyFor(id)!;
    vi.stubEnv("AUTH_SECRET", "");
    expect(overlayKeyFor(id)).toBeNull();
    expect(verifyOverlayKey(id, underSecret)).toBe(false);
    expect(verifyOverlayKey(id, ruled("", id)), "an empty secret is no secret").toBe(false);
  });
});

describe("verifyOverlayKey", () => {
  it("accepts the fixture's own key and refuses it for every OTHER fixture — the key is fixture-bound", () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    let own = 0;
    let crossed = 0;
    for (const a of ids) {
      for (const b of ids) {
        const got = verifyOverlayKey(b, overlayKeyFor(a));
        if (a === b) {
          expect(got, `${a}'s own key`).toBe(true);
          own++;
        } else {
          expect(got, `${a}'s key on ${b}`).toBe(false);
          crossed++;
        }
      }
    }
    expect(own).toBe(ids.length);
    expect(crossed).toBe(ids.length * (ids.length - 1));
  });

  it("refuses every near miss, wrong type and wrong length — and never throws on one", () => {
    const id = randomUUID();
    const key = overlayKeyFor(id)!;
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const bad: [string, unknown][] = [
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["first char flipped", flip(key, 0)],
      ["last char flipped", flip(key, key.length - 1)],
      ["one short", key.slice(0, -1)],
      ["one long", `${key}A`],
      ["padded", `${key}==`],
      ["the untruncated digest", createHmac("sha256", SECRET).update(`overlay:${id}`).digest("base64url")],
      ["hex, not base64url", createHmac("sha256", SECRET).update(`overlay:${id}`).digest().subarray(0, 16).toString("hex")],
      ["over a different message", createHmac("sha256", SECRET).update(id).digest().subarray(0, 16).toString("base64url")],
      ["under another secret", ruled("another-secret-entirely", id)],
      ["a number", 12345],
      ["an array", [key]],
      // Same STRING length as a key, twice its byte length: a length check on the string and a compare on the bytes
      // would hand timingSafeEqual two buffers of different sizes, which throws.
      ["multi-byte, same string length", "é".repeat(22)],
    ];
    let checked = 0;
    for (const [name, value] of bad) {
      expect(() => verifyOverlayKey(id, value as string), name).not.toThrow();
      expect(verifyOverlayKey(id, value as string), name).toBe(false);
      checked++;
    }
    expect(checked).toBe(bad.length);
    // The positive pair, on the same fixture: the real key still verifies.
    expect(verifyOverlayKey(id, key)).toBe(true);
  });

  it("a rotated AUTH_SECRET retires every key minted under the old one", () => {
    const id = randomUUID();
    const old = overlayKeyFor(id)!;
    vi.stubEnv("AUTH_SECRET", "rotated-secret-0123456789abcdef-rotated");
    expect(verifyOverlayKey(id, old)).toBe(false);
    expect(verifyOverlayKey(id, overlayKeyFor(id))).toBe(true);
  });
});
