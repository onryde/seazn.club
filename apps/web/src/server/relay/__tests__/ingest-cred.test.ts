// Capture QR v2 §6.4 (W15, W21, A18) — the descriptor's ingest credential, pure. Every expected url below is the
// stored value with ONLY its hostname changed, written out in full: `rtmps:` is not a special scheme, so a `URL`
// round-trip must keep `:443` and `/live/`, and a test that rebuilt the expectation through `URL` would share the bug.
// The stored values are the shapes Cloudflare returns (design 2026-09-07 "Observed") and the fake's (fakes.ts).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing here reads a sport.
import { describe, expect, it } from "vitest";
import { CaptureCred } from "@/server/api-v1/capture-schemas";
import { FAKE_PLAYBACK_HOST, QR_PREFERRED_DEFAULT, SRT_LATENCY_MS, streamIngestHost, streamPlaybackHost } from "../config";
import { CLOUDFLARE_INGEST_HOST, ingestCred, srtEnabled, type RawCred } from "../ingest-cred";

const CF: RawCred = {
  srt: { url: "srt://live.cloudflare.com:778", streamId: "abc123-0", passphrase: "pass-phrase-xyz" },
  rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "rtmps-key-123" },
};
const FAKE: RawCred = {
  srt: { url: "srt://fake.ingest.invalid:778", streamId: "sid-0", passphrase: "fake-pass" },
  rtmps: { url: "rtmps://fake.ingest.invalid:443/live/", streamKey: "fake-key" },
};
const ON = { srtEnabled: true, latencyMs: SRT_LATENCY_MS };

describe("ingestCred (§6.4, W15, W21)", () => {
  it("PREMISE: the stored Cloudflare host is the one the module rewrites from", () => {
    expect(new URL(CF.rtmps.url).hostname).toBe(CLOUDFLARE_INGEST_HOST);
    expect(new URL(CF.srt.url).hostname).toBe(CLOUDFLARE_INGEST_HOST);
  });

  it("host set: RTMPS is rewritten (scheme, port and path kept, exact string), SRT is served UNCHANGED (W21)", () => {
    const r = ingestCred(CF, { ingestHost: "live.seazn.club", ...ON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cred.rtmps).toEqual({ url: "rtmps://live.seazn.club:443/live/", streamKey: "rtmps-key-123" });
    expect(r.cred.srt).toEqual({ url: "srt://live.cloudflare.com:778", streamId: "abc123-0", passphrase: "pass-phrase-xyz", latencyMs: SRT_LATENCY_MS });
    expect(r.preferred).toBe(QR_PREFERRED_DEFAULT);
    expect(CaptureCred.parse(r.cred)).toEqual(r.cred);
  });

  it("host set: a foreign RTMPS host is refused on rtmps; a foreign SRT host on srt — each alone", () => {
    const rtmpsForeign = { ...CF, rtmps: { ...CF.rtmps, url: "rtmps://evil.example:443/live/" } };
    expect(ingestCred(rtmpsForeign, { ingestHost: "live.seazn.club", ...ON })).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
    const srtForeign = { ...CF, srt: { ...CF.srt, url: "srt://evil.example:778" } };
    expect(ingestCred(srtForeign, { ingestHost: "live.seazn.club", ...ON })).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "srt" });
    // A suffix trick is not the host: `live.cloudflare.com.evil.example` is a different hostname.
    const suffix = { ...CF, rtmps: { ...CF.rtmps, url: "rtmps://live.cloudflare.com.evil.example:443/live/" } };
    expect(ingestCred(suffix, { ingestHost: "live.seazn.club", ...ON })).toMatchObject({ ok: false, which: "rtmps" });
  });

  it("host set, SRT off: a foreign SRT host is not judged — it is not served (srt: null)", () => {
    const srtForeign = { ...CF, srt: { ...CF.srt, url: "srt://evil.example:778" } };
    const r = ingestCred(srtForeign, { ingestHost: "live.seazn.club", srtEnabled: false, latencyMs: SRT_LATENCY_MS });
    expect(r).toMatchObject({ ok: true, cred: { srt: null }, preferred: "rtmps" });
  });

  it("host unset: the fake's values pass through untouched, both legs", () => {
    const r = ingestCred(FAKE, { ingestHost: null, ...ON });
    expect(r).toEqual({
      ok: true, preferred: QR_PREFERRED_DEFAULT,
      cred: { srt: { ...FAKE.srt, latencyMs: SRT_LATENCY_MS }, rtmps: { url: "rtmps://fake.ingest.invalid:443/live/", streamKey: "fake-key" } },
    });
  });

  it("srtEnabled false (A18): srt is null and preferred is rtmps — preferred never names a null shape", () => {
    const r = ingestCred(CF, { ingestHost: "live.seazn.club", srtEnabled: false, latencyMs: SRT_LATENCY_MS });
    expect(r).toEqual({ ok: true, preferred: "rtmps", cred: { srt: null, rtmps: { url: "rtmps://live.seazn.club:443/live/", streamKey: "rtmps-key-123" } } });
  });
});

describe("the three ingest settings (§6.15)", () => {
  it("srtEnabled: unset and blank read TRUE (the W21 default); 'false' reads false; junk throws naming the variable", () => {
    expect(srtEnabled({})).toBe(true);
    expect(srtEnabled({ STREAM_SRT_ENABLED: "" })).toBe(true);
    expect(srtEnabled({ STREAM_SRT_ENABLED: " true " })).toBe(true);
    expect(srtEnabled({ STREAM_SRT_ENABLED: "false" })).toBe(false);
    expect(srtEnabled({ STREAM_SRT_ENABLED: "FALSE" })).toBe(false);
    expect(() => srtEnabled({ STREAM_SRT_ENABLED: "0" })).toThrow(/STREAM_SRT_ENABLED/);
  });

  it("streamIngestHost: unset/blank = null; a bare host is read; a scheme or path is refused", () => {
    expect(streamIngestHost({})).toBeNull();
    expect(streamIngestHost({ STREAM_INGEST_HOST: "  " })).toBeNull();
    expect(streamIngestHost({ STREAM_INGEST_HOST: "live.stg.seazn.club" })).toBe("live.stg.seazn.club");
    expect(() => streamIngestHost({ STREAM_INGEST_HOST: "rtmps://live.seazn.club" })).toThrow(/STREAM_INGEST_HOST/);
    expect(() => streamIngestHost({ STREAM_INGEST_HOST: "live.seazn.club/x" })).toThrow(/STREAM_INGEST_HOST/);
  });

  it("streamPlaybackHost: set = itself; unset under the FAKE driver = the fake's host; unset under a LIVE driver = null (503 playback_unconfigured)", () => {
    expect(streamPlaybackHost({ STREAM_PLAYBACK_HOST: "customer-x.cloudflarestream.com", RELAY_DRIVERS: "live" })).toBe("customer-x.cloudflarestream.com");
    expect(streamPlaybackHost({ NODE_ENV: "test" })).toBe(FAKE_PLAYBACK_HOST);
    expect(streamPlaybackHost({ RELAY_DRIVERS: "live" })).toBeNull();
  });
});
