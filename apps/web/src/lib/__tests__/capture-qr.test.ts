// lib/capture-qr.ts — the v1 QR contract's ONE schema (design §7.6, ruling R-A).
// What the design fixes, and therefore what these tests take as expected values:
//  1. BOTH credential shapes are required — a payload carrying SRT alone (or
//     RTMPS alone) is refused, because a one-shape payload blocks the fallback;
//  2. the version is read FIRST: a v2 payload is `wrong_version`, never
//     re-interpreted as a malformed v1 (an old app must say "update", not "bad QR");
//  3. `exp` is Unix seconds and the payload is dead AT exp, not after it;
//  4. nothing outside the declared fields rides along (strict at every level).
// Pure — no DB.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CaptureQrV1, parseCaptureQr } from "../capture-qr";

const EXP = 1_900_000_000; // 2030-03-17 — Unix SECONDS
const BEFORE = new Date((EXP - 3600) * 1000);

/** Cloudflare's observed create shape (design 2026-09-07 "Observed"): bare urls, streamId = the input uid. */
function valid() {
  return {
    v: 1,
    sid: "3f1c2a9e-8b7d-4c61-9f0a-2d5e6b7c8a91",
    slot: 0,
    cred: {
      srt: { url: "srt://live.cloudflare.com:778", streamId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", passphrase: "p".repeat(65), latencyMs: 2000 },
      rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "k".repeat(65) },
    },
    preferred: "srt",
    exp: EXP,
  };
}

type Json = Record<string, unknown>;

/** Every leaf path of a plain object (`["cred","srt","url"]`, …). */
function leafPaths(o: Json, prefix: string[] = []): string[][] {
  return Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? leafPaths(v as Json, [...prefix, k]) : [[...prefix, k]],
  );
}

/** Every leaf path the SCHEMA declares — so the payload sweep below cannot silently skip a field. */
function schemaLeafPaths(s: z.ZodObject, prefix: string[] = []): string[][] {
  return Object.entries(s.shape).flatMap(([k, v]) =>
    v instanceof z.ZodObject ? schemaLeafPaths(v, [...prefix, k]) : [[...prefix, k]],
  );
}

function without(o: Json, path: string[]): Json {
  const copy = structuredClone(o);
  let at: Json = copy;
  for (const k of path.slice(0, -1)) at = at[k] as Json;
  delete at[path[path.length - 1]!];
  return copy;
}

describe("parseCaptureQr — the v1 contract", () => {
  it("accepts the observed shape and hands back exactly the payload", () => {
    const r = parseCaptureQr(valid(), BEFORE);
    expect(r).toEqual({ ok: true, payload: valid() });
  });

  it("BOTH credential shapes are required: SRT alone and RTMPS alone are each refused (§7.6)", () => {
    const srtOnly = valid() as Json;
    delete (srtOnly.cred as Json).rtmps;
    expect(parseCaptureQr(srtOnly, BEFORE)).toEqual({ ok: false, reason: "invalid" });
    const rtmpsOnly = valid() as Json;
    delete (rtmpsOnly.cred as Json).srt;
    expect(parseCaptureQr(rtmpsOnly, BEFORE)).toEqual({ ok: false, reason: "invalid" });
  });

  it("every declared field is required — sweep over each leaf removed in turn", () => {
    const payloadLeaves = leafPaths(valid()).map((p) => p.join("."));
    // The sweep's own coverage: the fixture carries every leaf the schema declares, no more, no fewer.
    expect(payloadLeaves.sort()).toEqual(schemaLeafPaths(CaptureQrV1).map((p) => p.join(".")).sort());
    let checked = 0;
    for (const path of leafPaths(valid())) {
      const r = parseCaptureQr(without(valid(), path), BEFORE);
      expect(r.ok, `payload without ${path.join(".")} was accepted`).toBe(false);
      checked++;
    }
    expect(checked, "leaves checked").toBeGreaterThan(0);
    expect(checked).toBe(payloadLeaves.length);
  });

  it("the version is read first: v 2 is wrong_version even when it is ALSO expired and malformed", () => {
    expect(parseCaptureQr({ ...valid(), v: 2 }, BEFORE)).toEqual({ ok: false, reason: "wrong_version" });
    expect(parseCaptureQr({ v: 2 }, new Date((EXP + 1) * 1000))).toEqual({ ok: false, reason: "wrong_version" });
    // …while the SAME malformed body at v 1 is merely invalid (the twin that shows the version check is what fired).
    expect(parseCaptureQr({ v: 1 }, BEFORE)).toEqual({ ok: false, reason: "invalid" });
    // ALSO expired, and otherwise well-formed (Task 9 review minor 2): a v 2 body carrying a PAST `exp` is still
    // wrong_version — an expiry read before the version would call it expired, and an old app would say "rescan"
    // where it must say "update". The twin: the same body at v 1, the same instant, IS expired, so expiry would fire.
    const pastExp = new Date((EXP + 1) * 1000);
    expect(parseCaptureQr({ ...valid(), v: 2 }, pastExp)).toEqual({ ok: false, reason: "wrong_version" });
    expect(parseCaptureQr(valid(), pastExp)).toEqual({ ok: false, reason: "expired" });
  });

  it("expiry is at exp itself: one millisecond before is ok, exp and after are expired", () => {
    expect(parseCaptureQr(valid(), new Date(EXP * 1000 - 1)).ok).toBe(true);
    expect(parseCaptureQr(valid(), new Date(EXP * 1000))).toEqual({ ok: false, reason: "expired" });
    expect(parseCaptureQr(valid(), new Date(EXP * 1000 + 1))).toEqual({ ok: false, reason: "expired" });
  });

  it("strict at every level: an extra field at the top, in cred, in srt or in rtmps is refused", () => {
    const extras: [string, (p: Json) => void][] = [
      ["top", (p) => { p.debug = true; }],
      ["cred", (p) => { (p.cred as Json).hls = { url: "https://x" }; }],
      ["cred.srt", (p) => { ((p.cred as Json).srt as Json).mode = "caller"; }],
      ["cred.rtmps", (p) => { ((p.cred as Json).rtmps as Json).app = "live"; }],
    ];
    for (const [where, add] of extras) {
      const p = valid() as Json;
      add(p);
      expect(parseCaptureQr(p, BEFORE), `extra field in ${where}`).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("empty and non-object input is invalid, never a throw", () => {
    for (const input of [undefined, null, {}, [], "", "{}", 1, true]) {
      expect(parseCaptureQr(input, BEFORE), JSON.stringify(input) ?? "undefined").toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("field bounds: a non-uuid sid, a negative or fractional slot, a zero latency, an empty credential, an unknown preference, a fractional exp", () => {
    const cases: [string, (p: Json) => void][] = [
      ["sid", (p) => { p.sid = "not-a-uuid"; }],
      ["slot -1", (p) => { p.slot = -1; }],
      ["slot 0.5", (p) => { p.slot = 0.5; }],
      ["latencyMs 0", (p) => { ((p.cred as Json).srt as Json).latencyMs = 0; }],
      ["passphrase ''", (p) => { ((p.cred as Json).srt as Json).passphrase = ""; }],
      ["streamKey ''", (p) => { ((p.cred as Json).rtmps as Json).streamKey = ""; }],
      ["preferred hls", (p) => { p.preferred = "hls"; }],
      ["exp fractional", (p) => { p.exp = EXP + 0.5; }],
    ];
    for (const [name, mutate] of cases) {
      const p = valid() as Json;
      mutate(p);
      expect(parseCaptureQr(p, BEFORE), name).toEqual({ ok: false, reason: "invalid" });
    }
    // The accepted twins at the edges: slot 1 (a second phone) and the RTMPS preference.
    expect(parseCaptureQr({ ...valid(), slot: 1, preferred: "rtmps" }, BEFORE).ok).toBe(true);
  });
});
