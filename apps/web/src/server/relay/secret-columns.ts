// server/relay/secret-columns.ts — the only SQL in the repo that names a *_enc
// column (enc-boundary.test.ts). Everything crossing this file is sealed on the
// way in and opened on the way out; nothing decrypted is ever written back.
import type { Tx } from "@/lib/db";
import { open, seal } from "./crypto";

export interface InputCredentials {
  srt: { url: string; streamId: string; passphrase: string };
  rtmps: { url: string; streamKey: string };
}

export interface InputRow {
  id: string;
  slot: number;
  ingestInputId: string | null;
  srt: InputCredentials["srt"] | null;
  rtmps: InputCredentials["rtmps"] | null;
}

/** A url column keeps scheme://host:port/path and nothing after it. Cloudflare's observed create response already
 *  returns bare urls (`srt://live.cloudflare.com:778`, `rtmps://live.cloudflare.com:443/live/` — design 2026-09-07,
 *  "Observed"); cutting at the first `?` or `#` is the floor under a shape that changes, so a credential a provider
 *  ever puts in a query (`?passphrase=…`) cannot land in a plaintext column. */
function bareUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Open an envelope that holds a JSON object of string fields. Node's JSON.parse error quotes the start of its input,
 *  and the input here is a decrypted credential, so every failure after `open` is re-thrown without it. */
function openFields<K extends string>(enc: Uint8Array, fields: readonly K[]): Record<K, string> {
  const plain = open(enc);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new Error("relay envelope does not hold a JSON credential");
  }
  const out = {} as Record<K, string>;
  for (const field of fields) {
    const value = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : undefined;
    if (typeof value !== "string") throw new Error(`relay envelope has no string ${field}`);
    out[field] = value;
  }
  return out;
}

const SRT_SEALED = ["passphrase", "streamId"] as const;
const TARGET_SEALED = ["url", "streamKey"] as const;

/** Persist a provisioned input's two credential shapes. Cloudflare returns the SRT `streamId` as a field of its own
 *  beside a bare url, so it exists nowhere else: `{ passphrase, streamId }` is sealed TOGETHER into
 *  `ingest_srt_key_enc` (as `rtmp_enc` seals `{ url, streamKey }`). The RTMPS pair is bare url + sealed stream key. */
export async function storeInputCredentials(
  tx: Tx,
  inputRowId: string,
  ingestInputId: string,
  creds: InputCredentials,
): Promise<void> {
  const srtSealed = { passphrase: creds.srt.passphrase, streamId: creds.srt.streamId };
  await tx`
    update fixture_stream_inputs
       set ingest_input_id = ${ingestInputId},
           ingest_srt_url = ${bareUrl(creds.srt.url)},
           ingest_srt_key_enc = ${seal(JSON.stringify(srtSealed))},
           ingest_rtmps_url = ${bareUrl(creds.rtmps.url)},
           ingest_rtmps_key_enc = ${seal(creds.rtmps.streamKey)}
     where id = ${inputRowId}`;
}

/** The input row at `slot` for a session, credentials DECRYPTED for this
 *  request only. `null` when the row is missing — the empty case, never a
 *  default object (the qr projection then reads `null`). The SRT streamId is the
 *  sealed one; it is never derived from the url. */
export async function readInputBySlot(tx: Tx, sessionId: string, slot: number): Promise<InputRow | null> {
  const [row] = await tx<{
    id: string; slot: number; ingest_input_id: string | null;
    ingest_srt_url: string | null; ingest_srt_key_enc: Uint8Array | null;
    ingest_rtmps_url: string | null; ingest_rtmps_key_enc: Uint8Array | null;
  }[]>`
    select id, slot, ingest_input_id, ingest_srt_url, ingest_srt_key_enc,
           ingest_rtmps_url, ingest_rtmps_key_enc
      from fixture_stream_inputs
     where session_id = ${sessionId} and slot = ${slot}`;
  if (!row) return null;
  let srt: InputRow["srt"] = null;
  if (row.ingest_srt_url && row.ingest_srt_key_enc) {
    const { passphrase, streamId } = openFields(row.ingest_srt_key_enc, SRT_SEALED);
    srt = { url: row.ingest_srt_url, streamId, passphrase };
  }
  const rtmps =
    row.ingest_rtmps_url && row.ingest_rtmps_key_enc
      ? { url: row.ingest_rtmps_url, streamKey: open(row.ingest_rtmps_key_enc) }
      : null;
  return { id: row.id, slot: row.slot, ingestInputId: row.ingest_input_id, srt, rtmps };
}

export async function storeTargetSecret(tx: Tx, targetRowId: string, rtmp: { url: string; streamKey: string }): Promise<void> {
  await tx`update org_stream_targets set rtmp_enc = ${seal(JSON.stringify(rtmp))} where id = ${targetRowId}`;
}

export async function readTargetSecret(tx: Tx, targetId: string): Promise<{ url: string; streamKey: string }> {
  const [row] = await tx<{ rtmp_enc: Uint8Array }[]>`select rtmp_enc from org_stream_targets where id = ${targetId}`;
  if (!row) throw new Error(`stream target ${targetId} not found`);
  const { url, streamKey } = openFields(row.rtmp_enc, TARGET_SEALED);
  return { url, streamKey };
}
