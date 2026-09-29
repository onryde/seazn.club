// The cross-repo drift gate (design §7.6): the contract JSON is checksummed,
// the zod schema (lib/capture-qr.ts) and the JSON contract agree on their
// required keys, the four fixtures parse/refuse as named, and a payload
// carrying SRT alone is refused (R-A) beside its both-halves twin. The
// fixtures were authored from §7.6, NOT dumped from the builder — r8 (drop
// the rtmps half in the builder) is caught by stream-sessions.test.ts, not
// here; this file cannot see the builder and does not pretend to. The seam
// proof — the REAL builder's output through this contract — lives in the
// DB-backed stream-sessions.test.ts, where the builder is reachable (lane D
// amendment D5).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import QRCode from "qrcode";
import { CaptureQrV1, parseCaptureQr } from "../capture-qr";

const CONTRACTS = resolve(import.meta.dirname, "../../../../../docs/contracts");
const contract = readFileSync(resolve(CONTRACTS, "capture-qr.v1.json"), "utf8");
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(CONTRACTS, "fixtures/capture-qr.v1", `${name}.json`), "utf8"));
const NOW = new Date("2026-09-14T12:00:00Z");

/** The value `shasum -a 256 docs/contracts/capture-qr.v1.json` prints. A change
 *  to the contract is a DELIBERATE v-bump and moves this constant in the same
 *  commit (and re-vendors the capture repo). */
const CONTRACT_SHA256 = "f13ca36e70fd6072169999a2b3d9ab8d0b405de7e0a8edb00b4c7e6d97ffe6e4";

type JsonLevel = { required: string[]; properties: Record<string, unknown> };

describe("capture-qr.v1.json", () => {
  it("is checksummed (the cross-repo drift gate)", () => {
    expect(createHash("sha256").update(contract).digest("hex")).toBe(CONTRACT_SHA256);
  });

  it("the zod schema and the JSON contract require the same keys, top-level and per credential shape — and every JSON property is required", () => {
    const json = JSON.parse(contract) as JsonLevel & {
      properties: { cred: JsonLevel & { properties: { srt: JsonLevel; rtmps: JsonLevel } } };
    };
    const cred = CaptureQrV1.shape.cred;
    const levels: [string, JsonLevel, string[]][] = [
      ["top", json, Object.keys(CaptureQrV1.shape)],
      ["cred", json.properties.cred, Object.keys(cred.shape)],
      ["cred.srt", json.properties.cred.properties.srt, Object.keys(cred.shape.srt.shape)],
      ["cred.rtmps", json.properties.cred.properties.rtmps, Object.keys(cred.shape.rtmps.shape)],
    ];
    let checked = 0;
    for (const [name, level, zodKeys] of levels) {
      expect(zodKeys.length, `${name}: an empty key set would agree with anything`).toBeGreaterThan(0);
      expect([...level.required].sort(), name).toEqual([...zodKeys].sort());
      // additionalProperties:false + a property left out of `required` would be
      // an OPTIONAL field the zod schema (strict, every key required) refuses.
      expect(Object.keys(level.properties).sort(), `${name}: a declared property is not required`).toEqual([...level.required].sort());
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("valid parses; expired, tampered and wrong-version refuse with their reason", () => {
    expect(parseCaptureQr(fixture("valid"), NOW)).toMatchObject({ ok: true, payload: { slot: 0, preferred: "srt" } });
    expect(parseCaptureQr(fixture("expired"), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(parseCaptureQr(fixture("tampered"), NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(parseCaptureQr(fixture("wrong-version"), NOW)).toEqual({ ok: false, reason: "wrong_version" });
  });

  it("R-A: a payload missing EITHER credential set, or preferred, or slot is refused; both sets with preferred rtmps is accepted", () => {
    const valid = fixture("valid") as Record<string, unknown> & { cred: Record<string, unknown> };
    const without = (edit: (p: typeof valid) => void) => { const p = structuredClone(valid); edit(p); return parseCaptureQr(p, NOW); };
    expect(without((p) => { delete p.cred.srt; })).toEqual({ ok: false, reason: "invalid" });
    expect(without((p) => { delete p.cred.rtmps; })).toEqual({ ok: false, reason: "invalid" });
    expect(without((p) => { delete p.preferred; })).toEqual({ ok: false, reason: "invalid" });
    expect(without((p) => { delete p.slot; })).toEqual({ ok: false, reason: "invalid" });
    expect(without((p) => { p.preferred = "rtmps"; })).toMatchObject({ ok: true, payload: { preferred: "rtmps" } });
  });

  it("§7.6 re-measure: the dual-credential payload at EC-M lands at a scannable version", () => {
    const text = JSON.stringify(fixture("valid"));
    const symbol = QRCode.create(text, { errorCorrectionLevel: "M" });
    // Record the two numbers in _INDEX.md (Task 17). The design's superseded
    // "~10–13" is replaced by what is measured here; the ceiling below is the
    // point past which a 236 CSS px symbol (320 wide) stops scanning reliably.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(600);
    expect(symbol.version).toBeGreaterThanOrEqual(8);
    expect(symbol.version).toBeLessThanOrEqual(20);
  });
});
