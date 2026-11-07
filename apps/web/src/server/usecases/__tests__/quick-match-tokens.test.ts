// Quick match home token and visitor key helpers (spec docs/superpowers/specs/2026-11-03-quick-match-design.md).
// No database: every helper is pure or reads its KEK from process.env on each call (relay/crypto.ts kek(), hasValidKek),
// so the "no KEK" cases stub the env in-process (pre-flight A15) and the afterEach restores the developer's own key.
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
