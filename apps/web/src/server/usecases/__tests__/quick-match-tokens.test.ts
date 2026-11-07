// Quick match home token and visitor key helpers (spec docs/superpowers/specs/2026-11-03-quick-match-design.md).
// No database: every helper is pure or reads its KEK from process.env on each call (relay/crypto.ts kek(), hasValidKek),
// so the "no KEK" cases stub the env in-process (pre-flight A15) and the afterEach restores the developer's own key.
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => { vi.unstubAllEnvs(); });

describe("quick match home token", () => {
  it("mints distinct prefixed tokens and hashes deterministically", () => {
    const a = mintHomeToken(), b = mintHomeToken();
    expect(a).not.toBe(b); expect(a.startsWith("qm_")).toBe(true); expect(isHomeTokenShaped(a)).toBe(true);
    expect(hashHomeToken(a)).toBe(hashHomeToken(a)); expect(hashHomeToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seals and opens under DEVICE_LINK_KEK", () => {
    vi.stubEnv("DEVICE_LINK_KEK", KEK);
    const t = mintHomeToken();
    expect(openHomeToken(sealHomeToken(t))).toBe(t);
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

  it("rejects shapes that are not a home token", () => {
    for (const s of ["", "dl_abc", "qm_", "qm_" + "x".repeat(42), "qm_" + "x".repeat(44), "qv_" + "x".repeat(43)]) expect(isHomeTokenShaped(s)).toBe(false);
  });
});

describe("quick match visitor key", () => {
  it("mints distinct prefixed visitor keys and hashes them deterministically (B2a)", () => {
    const a = mintVisitorKey(), b = mintVisitorKey();
    expect(a).not.toBe(b); expect(a.startsWith("qv_")).toBe(true); expect(isVisitorKeyShaped(a)).toBe(true);
    expect(hashVisitorKey(a)).toBe(hashVisitorKey(a)); expect(hashVisitorKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVisitorKey(a)).not.toBe(hashVisitorKey(b));
  });

  it("rejects shapes that are not a visitor key (B2a)", () => {
    for (const s of ["", "qv_", "qv_" + "x".repeat(42), "qv_" + "x".repeat(44), "qv_" + "!".repeat(43), "qm_" + "x".repeat(43)]) expect(isVisitorKeyShaped(s)).toBe(false);
  });
});
