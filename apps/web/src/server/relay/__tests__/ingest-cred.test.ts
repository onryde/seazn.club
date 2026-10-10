// Capture QR v2 §6.4 (W21, W26, A18) — the descriptor's ingest credential, pure. W26 (owner, 2026-10-05) put both legs
// on Cloudflare's own host; the STREAM_INGEST_HOST rewrite was removed on 2026-10-10 (owner ruling). What is left:
// the stored values are served as stored, a url on any host but the one this deployment's driver issues is refused
// (`ingest_host_unexpected`), SRT on/off (A18) and the latency.
//
// Every expected url is written out in full from its SOURCE, never rebuilt through `URL` (a test that did would share
// the bug): Cloudflare's are the measured values (docs/superpowers/specs/2026-09-11-cloudflare-stream-measured.md
// :199-201, `rtmps://live.cloudflare.com:443/live/` and `srt://live.cloudflare.com:778`), the fake's come out of the
// REAL FakeIngest (fakes.ts), folded through `ingestCred` here so the producer and the check cannot drift apart.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing here reads a sport.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureCred } from "@/server/api-v1/capture-schemas";
import * as config from "../config";
import { FAKE_PLAYBACK_HOST, QR_PREFERRED_DEFAULT, SRT_LATENCY_MS, streamPlaybackHost, type RelayDriverMode } from "../config";
import { FakeIngest } from "../fakes";
import { CLOUDFLARE_INGEST_HOST, FAKE_INGEST_HOST, ingestCred, ingestHostOf, srtEnabled, type RawCred } from "../ingest-cred";

/** The measured Cloudflare values (2026-09-11 measured doc :199-201) — the same literals W26 and the contracts name. */
const CF_RTMPS = "rtmps://live.cloudflare.com:443/live/";
const CF_SRT = "srt://live.cloudflare.com:778";
const CF: RawCred = {
  srt: { url: CF_SRT, streamId: "abc123-0", passphrase: "pass-phrase-xyz" },
  rtmps: { url: CF_RTMPS, streamKey: "rtmps-key-123" },
};
const ON = { srtEnabled: true, latencyMs: SRT_LATENCY_MS };
const LIVE = { expectedHost: CLOUDFLARE_INGEST_HOST, ...ON };

afterEach(() => { vi.unstubAllEnvs(); });

describe("ingestCred (§6.4, W21, W26)", () => {
  it("PREMISE: Cloudflare's host is the measured one, and the fixture is the measured pair", () => {
    expect(CLOUDFLARE_INGEST_HOST).toBe("live.cloudflare.com");
    expect(new URL(CF.rtmps.url).hostname).toBe(CLOUDFLARE_INGEST_HOST);
    expect(new URL(CF.srt.url).hostname).toBe(CLOUDFLARE_INGEST_HOST);
  });

  it("Cloudflare's values under Cloudflare's host: both legs served EXACTLY as stored (scheme, port and path kept)", () => {
    const r = ingestCred(CF, LIVE);
    expect(r).toEqual({
      ok: true, preferred: QR_PREFERRED_DEFAULT,
      cred: {
        srt: { url: CF_SRT, streamId: "abc123-0", passphrase: "pass-phrase-xyz", latencyMs: SRT_LATENCY_MS },
        rtmps: { url: CF_RTMPS, streamKey: "rtmps-key-123" },
      },
    });
    if (!r.ok) return;
    expect(CaptureCred.parse(r.cred)).toEqual(r.cred);
  });

  it("REGRESSION GUARD (W26; the rewrite was removed 2026-10-10): a set STREAM_INGEST_HOST has NO effect — RTMPS stays on Cloudflare's host", () => {
    const keys = Object.keys(config);
    expect(keys.length, "premise: the config namespace was read").toBeGreaterThan(0);
    expect(keys, "the setting's reader is gone").not.toContain("streamIngestHost");
    vi.stubEnv("STREAM_INGEST_HOST", "live.seazn.club");
    expect(process.env.STREAM_INGEST_HOST, "premise: the variable IS set for this call").toBe("live.seazn.club");
    const r = ingestCred(CF, LIVE);
    expect(r).toMatchObject({ ok: true, cred: { rtmps: { url: CF_RTMPS }, srt: { url: CF_SRT } } });
    // And with SRT off, where only RTMPS is served, it is still Cloudflare's.
    expect(ingestCred(CF, { ...LIVE, srtEnabled: false })).toMatchObject({ ok: true, cred: { srt: null, rtmps: { url: CF_RTMPS } } });
  });

  it("a foreign host is refused on its own leg — rtmps alone, srt alone, parent/sibling/child-domain tricks on both legs; Cloudflare's own passes (the positive pair)", () => {
    const rtmpsForeign = { ...CF, rtmps: { ...CF.rtmps, url: "rtmps://evil.example:443/live/" } };
    expect(ingestCred(rtmpsForeign, LIVE)).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
    const srtForeign = { ...CF, srt: { ...CF.srt, url: "srt://evil.example:778" } };
    expect(ingestCred(srtForeign, LIVE)).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "srt" });
    // Lookalikes are not the host — exact hostname only, on BOTH legs (SRT on): a parent-domain trick
    // (`live.cloudflare.com.evil.example`, a prefix match would admit it), a sibling (`evil-live.cloudflare.com`, admitted
    // by `endsWith(host)`) and a child (`x.live.cloudflare.com`, admitted by `endsWith("." + host)`).
    let tricks = 0;
    for (const host of ["live.cloudflare.com.evil.example", "evil-live.cloudflare.com", "x.live.cloudflare.com"]) {
      expect(ingestCred({ ...CF, rtmps: { ...CF.rtmps, url: `rtmps://${host}:443/live/` } }, LIVE), `rtmps ${host}`)
        .toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
      expect(ingestCred({ ...CF, srt: { ...CF.srt, url: `srt://${host}:778` } }, LIVE), `srt ${host}`)
        .toEqual({ ok: false, reason: "ingest_host_unexpected", which: "srt" });
      tricks++;
    }
    expect(tricks, "anti-vacuity").toBe(3);
    // W15's retired custom host is foreign too: a stored url on it is never served (capture trusts only Cloudflare's).
    const custom = { ...CF, rtmps: { ...CF.rtmps, url: "rtmps://live.seazn.club:443/live/" } };
    expect(ingestCred(custom, LIVE)).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
    expect(ingestCred(CF, LIVE)).toMatchObject({ ok: true });
  });

  it("both legs are served BYTE-FOR-BYTE as stored — never re-serialised through URL, which would normalise a path", () => {
    // Each stored value is one `URL` rewrites (a dot segment collapses, a space is percent-encoded), so a served value
    // re-serialised through `URL` differs from the stored one and this test sees it.
    let checked = 0;
    for (const [rtmps, srt] of [
      ["rtmps://live.cloudflare.com:443/live/../live/", "srt://live.cloudflare.com:778/../x"],
      ["rtmps://live.cloudflare.com:443/live/a b", "srt://live.cloudflare.com:778/a b"],
    ]) {
      expect(new URL(rtmps).toString(), `premise: URL re-encodes ${rtmps}`).not.toBe(rtmps);
      expect(new URL(srt).toString(), `premise: URL re-encodes ${srt}`).not.toBe(srt);
      const r = ingestCred({ srt: { ...CF.srt, url: srt }, rtmps: { ...CF.rtmps, url: rtmps } }, LIVE);
      expect(r, rtmps).toMatchObject({ ok: true });
      if (!r.ok) continue;
      expect(r.cred.rtmps.url, rtmps).toBe(rtmps);
      expect(r.cred.srt?.url, srt).toBe(srt);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("SRT off (A18): a foreign SRT host is not judged — it is not served (srt: null) — but a foreign RTMPS host still is", () => {
    const srtForeign = { ...CF, srt: { ...CF.srt, url: "srt://evil.example:778" } };
    expect(ingestCred(srtForeign, { ...LIVE, srtEnabled: false })).toEqual({
      ok: true, preferred: "rtmps", cred: { srt: null, rtmps: { url: CF_RTMPS, streamKey: "rtmps-key-123" } },
    });
    const rtmpsForeign = { ...CF, rtmps: { ...CF.rtmps, url: "rtmps://evil.example:443/live/" } };
    expect(ingestCred(rtmpsForeign, { ...LIVE, srtEnabled: false })).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
  });

  it("srtEnabled false (A18): srt is null and preferred is rtmps — preferred never names a null shape", () => {
    const r = ingestCred(CF, { ...LIVE, srtEnabled: false });
    expect(r).toEqual({ ok: true, preferred: "rtmps", cred: { srt: null, rtmps: { url: CF_RTMPS, streamKey: "rtmps-key-123" } } });
  });

  it("the REAL fake's output under the fake driver's host passes through untouched, both legs; under Cloudflare's it is foreign", async () => {
    const issued = await new FakeIngest().createLiveInput({ sessionId: "s1", slot: 0 });
    const raw: RawCred = { srt: issued.srt, rtmps: issued.rtmps };
    expect(new URL(raw.rtmps.url).hostname, "premise: the fake issues RTMPS on its own host").toBe(FAKE_INGEST_HOST);
    expect(new URL(raw.srt.url).hostname, "premise: the fake issues SRT on its own host").toBe(FAKE_INGEST_HOST);
    expect(ingestCred(raw, { expectedHost: ingestHostOf("fake"), ...ON })).toEqual({
      ok: true, preferred: QR_PREFERRED_DEFAULT,
      cred: {
        srt: { url: "srt://fake.ingest.invalid:778", streamId: issued.srt.streamId, passphrase: issued.srt.passphrase, latencyMs: SRT_LATENCY_MS },
        rtmps: { url: "rtmps://fake.ingest.invalid:443/live/", streamKey: issued.rtmps.streamKey },
      },
    });
    expect(ingestCred(raw, { expectedHost: ingestHostOf("live"), ...ON })).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
    // …and the converse: Cloudflare's values under the fake driver are foreign.
    expect(ingestCred(CF, { expectedHost: ingestHostOf("fake"), ...ON })).toEqual({ ok: false, reason: "ingest_host_unexpected", which: "rtmps" });
  });

  it("a second call answers the same and leaves the stored values untouched (pure)", () => {
    const raw = structuredClone(CF);
    const first = ingestCred(raw, LIVE);
    const second = ingestCred(raw, LIVE);
    expect(second).toEqual(first);
    expect(raw).toEqual(CF);
  });
});

describe("ingestHostOf — the one host each driver mode issues", () => {
  it("fake → the fake's host; live and disabled → Cloudflare's (every mode, counted)", () => {
    const table: [RelayDriverMode, string][] = [
      ["fake", "fake.ingest.invalid"],     // fakes.ts createLiveInput, both legs
      ["live", "live.cloudflare.com"],     // the measured value (W26)
      ["disabled", "live.cloudflare.com"], // the descriptor refuses `relay_disabled` first; strict, never lenient, if reached
    ];
    let checked = 0;
    for (const [mode, want] of table) {
      expect(ingestHostOf(mode), mode).toBe(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every RelayDriverMode").toBe(3);
  });
});

describe("the ingest settings that remain (§6.15)", () => {
  it("srtEnabled: unset and blank read TRUE (the W21 default); 'false' reads false; junk throws naming the variable", () => {
    expect(srtEnabled({})).toBe(true);
    expect(srtEnabled({ STREAM_SRT_ENABLED: "" })).toBe(true);
    expect(srtEnabled({ STREAM_SRT_ENABLED: " true " })).toBe(true);
    expect(srtEnabled({ STREAM_SRT_ENABLED: "false" })).toBe(false);
    expect(srtEnabled({ STREAM_SRT_ENABLED: "FALSE" })).toBe(false);
    expect(() => srtEnabled({ STREAM_SRT_ENABLED: "0" })).toThrow(/STREAM_SRT_ENABLED/);
  });

  it("streamPlaybackHost: set = itself; unset under the FAKE driver = the fake's host; unset under a LIVE driver = null (503 playback_unconfigured)", () => {
    expect(streamPlaybackHost({ STREAM_PLAYBACK_HOST: "customer-x.cloudflarestream.com", RELAY_DRIVERS: "live" })).toBe("customer-x.cloudflarestream.com");
    expect(streamPlaybackHost({ NODE_ENV: "test" })).toBe(FAKE_PLAYBACK_HOST);
    expect(streamPlaybackHost({ RELAY_DRIVERS: "live" })).toBeNull();
  });

  it("streamPlaybackHost: blank reads unset; a scheme, port or path is refused naming the variable (a bare hostname only)", () => {
    expect(streamPlaybackHost({ STREAM_PLAYBACK_HOST: "  ", RELAY_DRIVERS: "live" })).toBeNull();
    expect(streamPlaybackHost({ STREAM_PLAYBACK_HOST: " customer-x.cloudflarestream.com ", RELAY_DRIVERS: "live" })).toBe("customer-x.cloudflarestream.com");
    let refused = 0;
    for (const bad of ["https://customer-x.cloudflarestream.com", "customer-x.cloudflarestream.com:443", "customer-x.cloudflarestream.com/x"]) {
      expect(() => streamPlaybackHost({ STREAM_PLAYBACK_HOST: bad, RELAY_DRIVERS: "live" }), bad).toThrow(/STREAM_PLAYBACK_HOST must be a bare hostname/);
      refused++;
    }
    expect(refused, "anti-vacuity").toBe(3);
  });
});
