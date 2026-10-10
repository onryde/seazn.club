// server/relay/ingest-cred.ts — capture QR v2 §6.4 (W21, W26): the ingest credential the phone's descriptor serves,
// from the stored provider values. Pure: no I/O, no clock, no env; the caller opens the stored values (`readFirstInput`)
// inside its own request and passes the deployment's settings in.
//
//  - Both legs are served as the provider issued them (W26: Cloudflare's own `live.cloudflare.com`, in every
//    environment): SRT verbatim, RTMPS through its parsed `URL`, which keeps `:443` and `/live/` exactly as stored
//    (`rtmps:` is not a special scheme). There is no custom ingest host: W15's rewrite to one was retired by W26
//    (2026-10-05) and removed with its setting on 2026-10-10 (owner ruling) — capture trusts only Cloudflare's host, so
//    a rewrite would break every phone.
//  - A url on any host but the one this deployment's driver issues (`ingestHostOf`: Cloudflare's under a live driver,
//    the fake's `fake.ingest.invalid` under the fake one) is refused (`ingest_host_unexpected`): capture refuses a cred
//    that is not on its trusted host, so serving it would only fail the start on the phone. Exact hostname, never a
//    suffix. SRT is judged only while it is offered.
//  - `srtEnabled: false` (A18's safety net) → `srt: null`, and `preferred` never names a null shape.
import type { CaptureCred } from "@/server/api-v1/capture-schemas";
import { QR_PREFERRED_DEFAULT, type RelayDriverMode } from "./config";

export { srtEnabled } from "./config";

export type RawCred = { srt: { url: string; streamId: string; passphrase: string }; rtmps: { url: string; streamKey: string } };
export type IngestCredResult =
  | { ok: true; cred: CaptureCred; preferred: "srt" | "rtmps" }
  | { ok: false; reason: "ingest_host_unexpected"; which: "srt" | "rtmps" };

/** Cloudflare Stream's own ingest host (W26; measured 2026-09-11) — the only one a live deployment serves. */
export const CLOUDFLARE_INGEST_HOST = "live.cloudflare.com";
/** The fake driver's ingest host — fakes.ts issues both legs on it. `.invalid` never resolves. */
export const FAKE_INGEST_HOST = "fake.ingest.invalid";

/** The one host a stored ingest url may carry under `mode`. `disabled` never reaches the descriptor's cred (it refuses
 *  `relay_disabled` first); if it ever did, it is held to Cloudflare's host — strict, never lenient. */
export function ingestHostOf(mode: RelayDriverMode): string {
  return mode === "fake" ? FAKE_INGEST_HOST : CLOUDFLARE_INGEST_HOST;
}

export function ingestCred(
  raw: RawCred,
  env: { expectedHost: string; srtEnabled: boolean; latencyMs: number },
): IngestCredResult {
  const rtmps = new URL(raw.rtmps.url);
  const srt = new URL(raw.srt.url);
  if (rtmps.hostname !== env.expectedHost) return { ok: false, reason: "ingest_host_unexpected", which: "rtmps" };
  if (env.srtEnabled && srt.hostname !== env.expectedHost) return { ok: false, reason: "ingest_host_unexpected", which: "srt" };
  const srtCred = env.srtEnabled
    ? { url: raw.srt.url, streamId: raw.srt.streamId, passphrase: raw.srt.passphrase, latencyMs: env.latencyMs }
    : null;
  return {
    ok: true,
    cred: { srt: srtCred, rtmps: { url: rtmps.toString(), streamKey: raw.rtmps.streamKey } },
    // §6.4: QR_PREFERRED_DEFAULT while SRT is offered; "rtmps" otherwise — `preferred` never names a null shape (A18).
    preferred: srtCred ? QR_PREFERRED_DEFAULT : "rtmps",
  };
}
