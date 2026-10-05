// server/relay/ingest-cred.ts — capture QR v2 §6.4 (W15, W21): the ingest credential the phone's descriptor serves,
// from the stored Cloudflare values. Pure: no I/O, no clock; the caller opens the stored values (`readFirstInput`)
// inside its own request and passes the environment's settings in.
//
//  - RTMPS: an exact `live.cloudflare.com` hostname is rewritten to the environment's ingest host. Scheme, port and
//    path are kept — `rtmps:` is not a special scheme, so `URL` keeps `:443` and `/live/` exactly as stored.
//  - SRT is NEVER rewritten (W21): it is served on `srt://live.cloudflare.com:778` as Cloudflare issued it.
//  - With an ingest host set, any other hostname on either url is refused (`ingest_host_unexpected`): capture refuses a
//    cred that is not on an allowed host, so serving it would only fail the start on the phone.
//  - With no ingest host (local, CI), the stored values pass through — the fake's `fake.ingest.invalid` included.
//  - `srtEnabled: false` (A18's safety net) → `srt: null`, and `preferred` never names a null shape.
import type { CaptureCred } from "@/server/api-v1/capture-schemas";
import { QR_PREFERRED_DEFAULT } from "./config";

export { srtEnabled } from "./config";

export type RawCred = { srt: { url: string; streamId: string; passphrase: string }; rtmps: { url: string; streamKey: string } };
export type IngestCredResult =
  | { ok: true; cred: CaptureCred; preferred: "srt" | "rtmps" }
  | { ok: false; reason: "ingest_host_unexpected"; which: "srt" | "rtmps" };

/** Cloudflare Stream's own ingest host — the only one a stored url may carry once an ingest host is configured. */
export const CLOUDFLARE_INGEST_HOST = "live.cloudflare.com";

export function ingestCred(
  raw: RawCred,
  env: { ingestHost: string | null; srtEnabled: boolean; latencyMs: number },
): IngestCredResult {
  const rtmps = new URL(raw.rtmps.url);
  const srt = new URL(raw.srt.url);
  if (env.ingestHost !== null) {
    if (rtmps.hostname !== CLOUDFLARE_INGEST_HOST) return { ok: false, reason: "ingest_host_unexpected", which: "rtmps" };
    if (env.srtEnabled && srt.hostname !== CLOUDFLARE_INGEST_HOST) return { ok: false, reason: "ingest_host_unexpected", which: "srt" };
    rtmps.hostname = env.ingestHost;   // RTMPS only — SRT is never rewritten (W21)
  }
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
