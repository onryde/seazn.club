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

/** Persist a provisioned input's two credential shapes. `streamId` is part of
 *  the SRT URL Cloudflare returns (`srt://…?streamid=…`), so the SRT column
 *  pair is url + sealed passphrase; the RTMPS pair is url + sealed stream key. */
export async function storeInputCredentials(
  tx: Tx,
  inputRowId: string,
  ingestInputId: string,
  creds: InputCredentials,
): Promise<void> {
  await tx`
    update fixture_stream_inputs
       set ingest_input_id = ${ingestInputId},
           ingest_srt_url = ${creds.srt.url},
           ingest_srt_key_enc = ${seal(creds.srt.passphrase)},
           ingest_rtmps_url = ${creds.rtmps.url},
           ingest_rtmps_key_enc = ${seal(creds.rtmps.streamKey)}
     where id = ${inputRowId}`;
}

/** The input row at `slot` for a session, credentials DECRYPTED for this
 *  request only. `null` when the row is missing — the empty case, never a
 *  default object (the qr projection then reads `null`). */
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
  const srt =
    row.ingest_srt_url && row.ingest_srt_key_enc
      ? { url: row.ingest_srt_url, streamId: streamIdOf(row.ingest_srt_url), passphrase: open(row.ingest_srt_key_enc) }
      : null;
  const rtmps =
    row.ingest_rtmps_url && row.ingest_rtmps_key_enc
      ? { url: row.ingest_rtmps_url, streamKey: open(row.ingest_rtmps_key_enc) }
      : null;
  return { id: row.id, slot: row.slot, ingestInputId: row.ingest_input_id, srt, rtmps };
}

/** `srt://live.cloudflare.com:778?passphrase=…&streamid=…` → the streamid value. */
export function streamIdOf(srtUrl: string): string {
  const q = srtUrl.split("?")[1] ?? "";
  for (const part of q.split("&")) {
    const [k, v] = part.split("=");
    if (k === "streamid" && v) return decodeURIComponent(v);
  }
  return "";
}

export async function storeTargetSecret(tx: Tx, targetRowId: string, rtmp: { url: string; streamKey: string }): Promise<void> {
  await tx`update org_stream_targets set rtmp_enc = ${seal(JSON.stringify(rtmp))} where id = ${targetRowId}`;
}

export async function readTargetSecret(tx: Tx, targetId: string): Promise<{ url: string; streamKey: string }> {
  const [row] = await tx<{ rtmp_enc: Uint8Array }[]>`select rtmp_enc from org_stream_targets where id = ${targetId}`;
  if (!row) throw new Error(`stream target ${targetId} not found`);
  const parsed = JSON.parse(open(row.rtmp_enc)) as { url: string; streamKey: string };
  return { url: parsed.url, streamKey: parsed.streamKey };
}
