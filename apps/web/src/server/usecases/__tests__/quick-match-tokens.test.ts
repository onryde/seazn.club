// Quick match home token and visitor key helpers (spec docs/superpowers/specs/2026-11-03-quick-match-design.md).
// No database: every helper is pure or reads its KEK from process.env on each call (relay/crypto.ts kek(), hasValidKek),
// so the "no KEK" cases stub the env in-process (pre-flight A15) and the afterEach restores the developer's own key.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { openWith, sealWith, type KekName } from "@/server/relay/crypto";
import {
  hashHomeToken,
  hashVisitorKey,
  isHomeTokenShaped,
  isVisitorKeyShaped,
  mintHomeToken,
  mintVisitorKey,
  openHomeToken,
  sealHomeToken,
  tryOpenHomeToken,
} from "../quick-match-tokens";

const KEK = "a".repeat(64);
/** A second VALID key: a wrong key must never be mistaken for a missing one. */
const OTHER_KEK = "b".repeat(64);
/** Every other KEK the envelope could be bound to, from crypto.ts's own `KekName` union. Stubbed to OTHER_KEK so a
 *  helper sealing under the wrong name seals under a key DEVICE_LINK_KEK cannot open, whatever the developer's env holds. */
type OtherKek = Exclude<KekName, "DEVICE_LINK_KEK">;
/** A Record, so tsc refuses this list the day `KekName` grows a member it does not name. */
const OTHER_KEKS: Record<OtherKek, true> = { RELAY_KEK: true, LICHESS_TOKEN_KEK: true, EMAIL_OUTBOX_KEK: true, YOUTUBE_TOKEN_KEK: true };
const OTHER_KEK_NAMES = Object.keys(OTHER_KEKS) as OtherKek[];
/** FIPS 180-2 Appendix B.1: SHA-256("abc"). From the standard, never from the code under test. */
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
afterEach(() => { vi.unstubAllEnvs(); });

describe("quick match home token", () => {
  it("mints distinct prefixed tokens and hashes deterministically", () => {
    const a = mintHomeToken(), b = mintHomeToken();
    expect(a).not.toBe(b); expect(a.startsWith("qm_")).toBe(true); expect(isHomeTokenShaped(a)).toBe(true);
    expect(hashHomeToken(a)).toBe(hashHomeToken(a)); expect(hashHomeToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHomeToken(a)).not.toBe(hashHomeToken(b));
  });

  it("hashes with SHA-256 itself: the FIPS 180-2 known answer", () => {
    expect(hashHomeToken("abc")).toBe(SHA256_ABC);
  });

  it("seals and opens under DEVICE_LINK_KEK", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const t = mintHomeToken();
    expect(openHomeToken(sealHomeToken(t))).toBe(t);
  });

  it("binds the envelope to DEVICE_LINK_KEK itself, both ways (C19)", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    for (const name of OTHER_KEK_NAMES) vi.stubEnv(name, OTHER_KEK);
    expect(OTHER_KEK_NAMES).toHaveLength(4);
    const t = mintHomeToken();
    expect(openWith("DEVICE_LINK_KEK", sealHomeToken(t))).toBe(t);
    expect(openHomeToken(sealWith("DEVICE_LINK_KEK", t))).toBe(t);
  });

  it("refuses to seal with no KEK: the helper's half of Review Focus 4 (the create's half is Task 5)", () => {
    vi.stubEnv("DEVICE_LINK_KEK", "");
    expect(() => sealHomeToken(mintHomeToken())).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
  });

  it("refuses to open with no KEK with the same 503, never a plain Error (A6)", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const enc = sealHomeToken(mintHomeToken());
    vi.stubEnv("DEVICE_LINK_KEK", "");
    expect(() => openHomeToken(enc)).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
  });

  it("refuses a MALFORMED KEK with the same 503 on both sides: present is not valid", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const enc = sealHomeToken(mintHomeToken());
    vi.stubEnv("DEVICE_LINK_KEK", "zz");
    expect(() => sealHomeToken(mintHomeToken())).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
    expect(() => openHomeToken(enc)).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
  });

  it("a wrong but valid KEK is NOT the configuration 503: the envelope's own failure stays a 500", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const enc = sealHomeToken(mintHomeToken());
    vi.stubEnv("DEVICE_LINK_KEK", OTHER_KEK);
    let err: unknown;
    try { openHomeToken(enc); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HttpError);
    expect((err as { status?: unknown }).status).toBeUndefined();
  });

  it("rejects shapes that are not a home token", () => {
    const valid = mintHomeToken();
    expect(isHomeTokenShaped(valid)).toBe(true);
    const bad = ["", "dl_abc", "qm_", "qm_" + "x".repeat(42), "qm_" + "x".repeat(44), "qv_" + "x".repeat(43), "qm_" + "!".repeat(43), "x" + valid];
    for (const s of bad) expect(isHomeTokenShaped(s)).toBe(false);
    expect(bad).toHaveLength(8);
  });
});

describe("quick match visitor key", () => {
  it("mints distinct prefixed visitor keys and hashes them deterministically (B2a)", () => {
    const a = mintVisitorKey(), b = mintVisitorKey();
    expect(a).not.toBe(b); expect(a.startsWith("qv_")).toBe(true); expect(isVisitorKeyShaped(a)).toBe(true);
    expect(hashVisitorKey(a)).toBe(hashVisitorKey(a)); expect(hashVisitorKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVisitorKey(a)).not.toBe(hashVisitorKey(b));
  });

  it("hashes visitor keys with SHA-256 itself: the FIPS 180-2 known answer", () => {
    expect(hashVisitorKey("abc")).toBe(SHA256_ABC);
  });

  it("rejects shapes that are not a visitor key (B2a)", () => {
    const valid = mintVisitorKey();
    expect(isVisitorKeyShaped(valid)).toBe(true);
    const bad = ["", "qv_", "qv_" + "x".repeat(42), "qv_" + "x".repeat(44), "qv_" + "!".repeat(43), "qm_" + "x".repeat(43), "x" + valid];
    for (const s of bad) expect(isVisitorKeyShaped(s)).toBe(false);
    expect(bad).toHaveLength(7);
  });
});

// Controller ruling 2026-11-08 (Task 9 fix round 1): a page that rebuilds `/q/<token>` as an EXTRA (the pad's back link,
// plan 2's strip, plan 3's list) must never 500 on it, so it asks `tryOpenHomeToken`, which never throws and names the
// reason. The envelope layout comes from crypto.ts's own doc and e2e/lichess-token-seal.ts, never from the code under
// test: [version 1][wrap IV 12][wrapped DEK 32][wrap tag 16][data IV 12][data tag 16][body].
const LAYOUT_HEADER = 1 + 12 + 32 + 16 + 12 + 16;
const LAYOUT_VERSION = 0x01;

describe("tryOpenHomeToken: never throws, one reason per case", () => {
  it("opens a good envelope: the token itself", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const t = mintHomeToken();
    expect(tryOpenHomeToken(sealHomeToken(t))).toEqual({ ok: true, token: t });
  });

  it("kek_missing: unset or malformed, checked BEFORE the envelope (a damaged row under no key still answers the key)", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const good = sealHomeToken(mintHomeToken());
    const keys = ["", "zz", "a".repeat(63), "a".repeat(64) + "\n", "g".repeat(64)];
    let checked = 0;
    for (const key of keys) {
      vi.stubEnv("DEVICE_LINK_KEK", key);
      for (const enc of [good, Buffer.from([1, 2, 3])]) {
        expect(tryOpenHomeToken(enc), JSON.stringify(key)).toEqual({ ok: false, reason: "kek_missing" });
        checked++;
      }
    }
    expect(checked).toBe(keys.length * 2);
  });

  it("malformed: shorter than the header, or a version this envelope never had, under the RIGHT key", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const good = sealHomeToken(mintHomeToken());
    expect(good.length, "precondition: a real envelope is header + body").toBeGreaterThan(LAYOUT_HEADER);
    expect(good[0]).toBe(LAYOUT_VERSION);
    const withVersion = (v: number) => {
      const b = Buffer.from(good);
      b[0] = v;
      return b;
    };
    const cases = [Buffer.alloc(0), Buffer.from([1, 2, 3]), good.subarray(0, LAYOUT_HEADER - 1), withVersion(0x00), withVersion(0x02), withVersion(0xff)];
    for (const enc of cases) expect(tryOpenHomeToken(enc)).toEqual({ ok: false, reason: "malformed" });
    expect(cases).toHaveLength(6);
  });

  it("rejected: well formed but not opened: a wrong but valid KEK, an altered body, tag or wrapped key, a header with no body", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const t = mintHomeToken();
    const good = sealHomeToken(t);
    const flipped = (at: number) => {
      const b = Buffer.from(good);
      b[at] = b[at]! ^ 0x01;
      return b;
    };
    // body (last byte), data tag (offset 73), wrapped DEK (offset 13): each authenticated, so each is refused.
    const altered = [flipped(good.length - 1), flipped(1 + 12 + 32 + 16 + 12), flipped(1 + 12)];
    const headerOnly = good.subarray(0, LAYOUT_HEADER);
    let checked = 0;
    for (const enc of [...altered, headerOnly]) {
      expect(tryOpenHomeToken(enc)).toEqual({ ok: false, reason: "rejected" });
      checked++;
    }
    vi.stubEnv("DEVICE_LINK_KEK", OTHER_KEK);
    expect(tryOpenHomeToken(good), "a KEK rotated without re-sealing").toEqual({ ok: false, reason: "rejected" });
    checked++;
    expect(checked).toBe(5);
    // The same envelope under the right key still opens: the refusals above were the alterations, not the fixture.
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    expect(tryOpenHomeToken(good)).toEqual({ ok: true, token: t });
  });

  it("never throws: 400 random byte strings, each answered malformed or rejected, both reasons reached", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const seen = { malformed: 0, rejected: 0 };
    for (let i = 0; i < 400; i++) {
      const b = randomBytes(i % 200);
      if (i % 2 === 0 && b.length > 0) b[0] = LAYOUT_VERSION;
      const out = tryOpenHomeToken(b);
      expect(out.ok, `random input ${i} cannot be a sealed home token`).toBe(false);
      if (!out.ok) {
        expect(["malformed", "rejected"]).toContain(out.reason);
        seen[out.reason as "malformed" | "rejected"]++;
      }
    }
    expect(seen.malformed + seen.rejected).toBe(400);
    expect(seen.malformed, "anti-vacuity: the sweep reached the structural refusal").toBeGreaterThan(0);
    expect(seen.rejected, "anti-vacuity: the sweep reached the authentication refusal").toBeGreaterThan(0);
  });
});
