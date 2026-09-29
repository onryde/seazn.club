// server/relay/secret-columns.ts — the only SQL in the repo that names a *_enc
// column (enc-boundary.test.ts). Everything crossing this file is sealed on the
// way in and opened on the way out; nothing decrypted is ever written back.
import type { Tx } from "@/lib/db";
import { fingerprintDestination, open, seal } from "./crypto";

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

/** Insert a destination with its RTMPS url + key sealed. The row's only
 *  writer: `rtmp_enc` is NOT NULL, so the insert and the seal are one call.
 *
 *  It is also the only writer of `dest_fingerprint` (V421, owner ruling A19 + A19b): one destination — its url in
 *  identity form plus its stream key — is ONE row per org. A repeat, even spelled with the default port, or racing a
 *  concurrent create, returns the EXISTING row's id and writes nothing: the first row's kind, label, watch link and
 *  envelope stand. An undialable url has no fingerprint and throws before anything is written. */
export async function insertStreamTarget(
  tx: Tx,
  args: { orgId: string; kind: string; label: string; watchUrl: string | null; rtmp: { url: string; streamKey: string } },
): Promise<StoredStreamTarget> {
  const fingerprint = fingerprintDestination(args.rtmp.url, args.rtmp.streamKey);
  // m6 (lane C final review): ONE retry, here. The conflicting row can be deleted between the insert and the read-back;
  // nothing above this function mapped that refusal, so the lost race was a 500. A second attempt in the same transaction
  // is a new statement — a new READ COMMITTED snapshot — so it sees that row gone and its insert lands. Only a second
  // vanish in a row (the same destination re-created AND deleted again inside the retry) is still refused by name.
  for (let attempt = 1; attempt <= 2; attempt++) {
    // The conflict target names the partial index's predicate so Postgres INFERS
    // org_stream_targets_org_dest_fingerprint. A concurrent insert of the same
    // destination makes this one WAIT for it; once it commits, this is a no-op and
    // the read below — a new statement, so a new READ COMMITTED snapshot — sees it.
    const [row] = await tx<TargetRow[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, watch_url, dest_fingerprint)
      values (${args.orgId}, ${args.kind}, ${args.label}, ${seal(JSON.stringify(args.rtmp))}, ${args.watchUrl}, ${fingerprint})
      on conflict (org_id, dest_fingerprint) where dest_fingerprint is not null do nothing
      returning id, kind, label, watch_url, created_at`;
    if (row) return storedTarget(row);
    const [existing] = await tx<TargetRow[]>`
      select id, kind, label, watch_url, created_at from org_stream_targets
       where org_id = ${args.orgId} and dest_fingerprint = ${fingerprint}`;
    if (existing) return storedTarget(existing);
    // The conflicting row was deleted between the two statements: go round once more.
  }
  // Vanished on the retry too. Refused by name rather than handing back an undefined row.
  throw new StreamTargetVanishedError();
}

/** The STORED target's public fields — the row that now answers for this destination, which on a repeat is the
 *  first create's row, not the arguments. Never the envelope. */
export interface StoredStreamTarget { id: string; kind: string; label: string; watchUrl: string | null; createdAt: Date }

type TargetRow = { id: string; kind: string; label: string; watch_url: string | null; created_at: Date };

const storedTarget = (r: TargetRow): StoredStreamTarget =>
  ({ id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at) });

/** `insertStreamTarget` found the destination already saved, then could not read it back — the row was deleted in
 *  between — on its first attempt AND on its one retry (m6). Carries no org, url or key. */
export class StreamTargetVanishedError extends Error {
  constructor() {
    super("stream target changed while it was being saved; try again");
    this.name = "StreamTargetVanishedError";
  }
}

/** The session's FIRST input (lowest slot) — the row the organiser projection
 *  reads. The slot VALUE travels with the row; nothing types a `0`. */
export async function readFirstInput(tx: Tx, sessionId: string): Promise<InputRow | null> {
  const [row] = await tx<{ slot: number }[]>`
    select slot from fixture_stream_inputs where session_id = ${sessionId} order by slot asc limit 1`;
  return row ? readInputBySlot(tx, sessionId, row.slot) : null;
}

/** Open an org's destination credential. The `orgId` is NOT decoration and it is not the caller's convenience — it is
 *  the tenancy check itself (whole-branch review I5, auth).
 *
 *  V410 puts `org_stream_targets` under FORCE RLS with ZERO policies, and `telemetry.ts` records the consequence: these
 *  rows are reachable only through the superuser `sql` client, never `withTenant`/`app_user`. So RLS supplies no
 *  tenancy here BY DESIGN, and before this the only thing standing between one org and another org's live RTMP key was
 *  a boolean the CALLER had computed, at a different time, in a different transaction (`admit`'s `targetBelongsToOrg`).
 *  The obligation sat entirely outside the module that holds the secret; now the query carries it.
 *
 *  The two errors are not symmetric and the asymmetry is the argument: a false REJECT is a 404 on a stream target,
 *  which an organiser retries; a false ACCEPT hands one org another org's destination credential, which is
 *  unrecoverable the moment it is used. A wrong `orgId` therefore reads exactly like a missing row — no oracle, one
 *  sentence, and the id is not a secret so it stays in the message. */
export async function readTargetSecret(tx: Tx, orgId: string, targetId: string): Promise<{ url: string; streamKey: string }> {
  const [row] = await tx<{ rtmp_enc: Uint8Array }[]>`
    select rtmp_enc from org_stream_targets where id = ${targetId} and org_id = ${orgId}`;
  if (!row) throw new Error(`stream target ${targetId} not found`);
  const { url, streamKey } = openFields(row.rtmp_enc, TARGET_SEALED);
  return { url, streamKey };
}
