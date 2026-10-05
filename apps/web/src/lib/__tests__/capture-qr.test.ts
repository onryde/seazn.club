// lib/capture-qr.ts — the capture QR's ONE client-safe schema, v2 (spec 2026-10-01 §6.2, W3), after the v1 hard cut
// (§6.13, W4: PR-1 T11 removed the v1 schema and its parser).
//
// What the spec fixes, and therefore what these tests take as expected values — never the module's own output:
//  1. the QR and the paste code are `{v:2, code, slot, tok}` — exactly these four keys, in this order (W3). The QR never
//     carries a credential, and never `exp` even when a payload holds one (A1: this server never sends it);
//  2. the version is read FIRST: a v1 payload is `wrong_version` (an old app says "update"), never a malformed v2;
//  3. nothing outside the declared fields rides along (strict).
// The JSON contract's parity with this schema is capture-contract.test.ts's; this file pins the builder and the cut.
// Pure — no DB. One shape, no sport: the QR reads no sport.
import { describe, expect, it } from "vitest";
import * as mod from "../capture-qr";
import { CaptureQrV2, captureQrV2Text, parseCaptureQrV2 } from "../capture-qr";

/** §6.2's alphabet (Crockford base32, lower case, no i l o u) and the 22-char base64url tok — written out here. */
const VALID = { v: 2, code: "k7m2q9xr4tbw", slot: 0, tok: "f3Kq9_ZtR2mXw8LpN4vB0a" } as const;

describe("captureQrV2Text — the QR and paste-code text (W3)", () => {
  it("exactly the four keys v, code, slot, tok — in that order — and the payload's own values", () => {
    const text = captureQrV2Text(CaptureQrV2.parse(VALID));
    const back = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(back)).toEqual(["v", "code", "slot", "tok"]);
    expect(back).toEqual(VALID);
  });

  it("never `exp`, even from a payload that carries one (A1) — and nothing else a caller hangs on the object", () => {
    const withExp = CaptureQrV2.parse({ ...VALID, exp: 1_900_000_000 });
    expect(withExp.exp, "PREMISE: the schema admits exp").toBe(1_900_000_000);
    const smuggled = { ...withExp, sid: "3f1c2a9e-8b7d-4c61-9f0a-2d5e6b7c8a91", cred: { rtmps: { streamKey: "k" } } } as unknown as CaptureQrV2;
    let checked = 0;
    for (const p of [withExp, smuggled]) {
      expect(Object.keys(JSON.parse(captureQrV2Text(p)))).toEqual(["v", "code", "slot", "tok"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the text round-trips through the phone's parser unchanged", () => {
    expect(parseCaptureQrV2(JSON.parse(captureQrV2Text(CaptureQrV2.parse(VALID))))).toEqual({ ok: true, payload: VALID });
  });
});

describe("parseCaptureQrV2 — the version first, then strict", () => {
  it("a v1 payload (the removed shape, credentials and all) is wrong_version, never invalid", () => {
    const v1 = {
      v: 1, sid: "3f1c2a9e-8b7d-4c61-9f0a-2d5e6b7c8a91", slot: 0, preferred: "srt", exp: 1_900_000_000,
      cred: { srt: { url: "srt://live.cloudflare.com:778", streamId: "a1", passphrase: "p", latencyMs: 2000 }, rtmps: { url: "rtmps://x/live/", streamKey: "k" } },
    };
    expect(parseCaptureQrV2(v1)).toEqual({ ok: false, reason: "wrong_version" });
    expect(parseCaptureQrV2({ v: 3 })).toEqual({ ok: false, reason: "wrong_version" });
  });

  it("an extra key, a missing key, a bad code or tok, a negative slot, and non-objects are invalid", () => {
    const cases: [string, unknown][] = [
      ["extra key", { ...VALID, sid: "x" }],
      ["no tok", { v: 2, code: VALID.code, slot: 0 }],
      ["code with an i", { ...VALID, code: "k7m2q9xr4tbi" }],
      ["code too short", { ...VALID, code: "k7m2q9xr4tb" }],
      ["tok 21 chars", { ...VALID, tok: VALID.tok.slice(1) }],
      ["slot -1", { ...VALID, slot: -1 }],
      ["null", null],
      ["a string", JSON.stringify(VALID)],
    ];
    let checked = 0;
    for (const [name, input] of cases) {
      expect(parseCaptureQrV2(input), name).toEqual({ ok: false, reason: "invalid" });
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(parseCaptureQrV2(VALID).ok, "the positive pair").toBe(true);
  });
});

describe("W4: the v1 hard cut (§6.13)", () => {
  it("the module exports no v1 schema and no v1 parser — only the v2 surface", () => {
    expect(Object.keys(mod).sort()).toEqual(["CaptureQrV2", "captureQrV2Text", "parseCaptureQrV2"]);
  });
});
