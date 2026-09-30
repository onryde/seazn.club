// server/relay/secret-columns.ts — the only SQL in the repo that names a *_enc
// column (enc-boundary.test.ts). Everything crossing this file is sealed on the
// way in and opened on the way out; nothing decrypted is ever written back.
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STREAM_PLATFORM_PRESETS, checkDestination, isStreamPlatform, type DestinationRefusal } from "@/lib/stream-destinations";
import { fingerprintDestination, hasValidKek, open, seal } from "./crypto";
import { log } from "@/server/logger";

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

/** §5.3: a key shorter than this has no hint — three characters of a short key are most of it. */
export const KEY_HINT_MIN_LENGTH = 12;
export const KEY_HINT_CHARS = 3;

export function keyHintOf(streamKey: string): string | null {
  return streamKey.length < KEY_HINT_MIN_LENGTH ? null : streamKey.slice(-KEY_HINT_CHARS);
}

/** The one unique index a destination write can meet (V421, made partial on active rows by V427). Matched by NAME. */
const FINGERPRINT_INDEX = "org_stream_targets_org_dest_fingerprint";
const isFingerprintConflict = (err: unknown): boolean => {
  const pg = err as { code?: string; constraint_name?: string };
  return pg.code === "23505" && pg.constraint_name === FINGERPRINT_INDEX;
};

export type InsertOutcome = "existing" | "restored" | "inserted";

/** Save a destination with its url + key sealed — the table's only writer of `rtmp_enc` and `dest_fingerprint`.
 *
 *  D2 (spec 2026-09-30 §5.2), in this order, per org and fingerprint:
 *   1. an ACTIVE row is the destination — returned as `existing`, nothing written (A19: the first row's kind, label,
 *      watch link and envelope stand);
 *   2. else the most recently ARCHIVED row is un-archived with the SUBMITTED label and watch link (`restored`);
 *   3. else a new row (`inserted`).
 *  A concurrent create or restore of the same destination makes the losing write a no-op or a 23505 on the partial
 *  index; the loop then re-reads, and step 1 — a new statement, so a new READ COMMITTED snapshot — returns the
 *  winner. Two lost rounds in a row are refused by name (m6). An undialable url throws before anything is written. */
export async function insertStreamTarget(
  tx: Tx,
  args: { orgId: string; kind: string; label: string; watchUrl: string | null; rtmp: { url: string; streamKey: string } },
): Promise<StoredStreamTarget> {
  const fingerprint = fingerprintDestination(args.rtmp.url, args.rtmp.streamKey);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [active] = await tx<TargetRow[]>`
      select id, kind, label, watch_url, created_at from org_stream_targets
       where org_id = ${args.orgId} and dest_fingerprint = ${fingerprint} and archived_at is null`;
    if (active) return storedTarget(active, "existing");
    const [archived] = await tx<{ id: string }[]>`
      select id from org_stream_targets
       where org_id = ${args.orgId} and dest_fingerprint = ${fingerprint} and archived_at is not null
       order by archived_at desc, created_at desc limit 1`;
    if (archived) {
      const restored = await tx
        .savepoint((sp) => sp<TargetRow[]>`
          update org_stream_targets set archived_at = null, label = ${args.label}, watch_url = ${args.watchUrl}
           where id = ${archived.id} and archived_at is not null
          returning id, kind, label, watch_url, created_at`)
        .catch((err: unknown) => {
          if (isFingerprintConflict(err)) return [] as TargetRow[];
          throw err;
        });
      if (restored[0]) return storedTarget(restored[0], "restored");
      continue;   // another writer restored or inserted it first: round again, step 1 returns theirs
    }
    // The conflict target names the partial index's WHOLE predicate so Postgres INFERS
    // org_stream_targets_org_dest_fingerprint (a drifted predicate is 42P10). A concurrent insert of the same
    // destination makes this one WAIT for it; once it commits, this is a no-op and the next round's step 1 sees it.
    const [row] = await tx<TargetRow[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, watch_url, dest_fingerprint)
      values (${args.orgId}, ${args.kind}, ${args.label}, ${seal(JSON.stringify(args.rtmp))}, ${args.watchUrl}, ${fingerprint})
      on conflict (org_id, dest_fingerprint) where dest_fingerprint is not null and archived_at is null do nothing
      returning id, kind, label, watch_url, created_at`;
    if (row) return storedTarget(row, "inserted");
  }
  // Lost the race on the retry too. Refused by name rather than handing back an undefined row.
  throw new StreamTargetVanishedError();
}

/** The STORED target's public fields and how this call reached it. Never the envelope. */
export interface StoredStreamTarget {
  id: string; kind: string; label: string; watchUrl: string | null; createdAt: Date; outcome: InsertOutcome;
}

type TargetRow = { id: string; kind: string; label: string; watch_url: string | null; created_at: Date };

const storedTarget = (r: TargetRow, outcome: InsertOutcome): StoredStreamTarget =>
  ({ id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at), outcome });

/** `insertStreamTarget` lost the race for a destination — its insert conflicted with a row it could not then read
 *  back — on its first attempt AND on its one retry (m6); or `replaceTargetKey`'s write conflicted with a holder that
 *  was gone by the re-read. Carries no org, url or key. M4 (B1 review): an HttpError 409 — "try again" is a retry the
 *  caller can make, so the v1 envelope answers 409, never an unmapped 500. */
export class StreamTargetVanishedError extends HttpError {
  constructor() {
    super(409, "stream target changed while it was being saved; try again");
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
  const [row] = await tx<{ rtmp_enc: Uint8Array; kind: string }[]>`
    select rtmp_enc, kind from org_stream_targets where id = ${targetId} and org_id = ${orgId}`;
  if (!row) throw new Error(`stream target ${targetId} not found`);
  let fields: Record<(typeof TARGET_SEALED)[number], string>;
  try {
    fields = openFields(row.rtmp_enc, TARGET_SEALED);
  } catch (err) {
    // M3 (B2 review): a missing or malformed RELAY_KEK is the DEPLOYMENT's fault — it stays the loud config error (a 500
    // that reaches Sentry), never an organiser-facing "replace your key". Only an envelope that will not open under a
    // valid KEK is this row's problem.
    if (!hasValidKek("RELAY_KEK")) throw err;
    throw new TargetSecretUnreadableError(targetId, row.kind);
  }
  return { url: fields.url, streamKey: fields.streamKey };
}

/** B2 (B1 review): the destination row EXISTS and is this org's, but its envelope will not open — sealed under another
 *  KEK, or a damaged byte. Typed so Go live can refuse it cleanly (422 TARGET_UNREADABLE) instead of a 500; a missing
 *  row stays the plain "not found" above. Carries the target id and kind only — never the envelope, a key or a url. */
export class TargetSecretUnreadableError extends Error {
  constructor(public readonly targetId: string, public readonly kind: string) {
    super(`stream target ${targetId}: the saved destination will not open`);
    this.name = "TargetSecretUnreadableError";
  }
}

/** §5.3 — each ACTIVE destination's key hint, opened here so the full key never leaves this module. An envelope that
 *  will not open under a valid KEK (a rotated KEK, a corrupt byte) is a row with no hint, never a failed list (Review
 *  Focus 1). A missing or malformed RELAY_KEK is the deployment's fault, not a row's: it rethrows (M3; N1, B2 re-review). */
export async function readKeyHints(tx: Tx, orgId: string): Promise<Map<string, string | null>> {
  const rows = await tx<{ id: string; rtmp_enc: Uint8Array }[]>`
    select id, rtmp_enc from org_stream_targets where org_id = ${orgId} and archived_at is null`;
  const hints = new Map<string, string | null>();
  for (const r of rows) {
    let hint: string | null = null;
    try {
      hint = keyHintOf(openFields(r.rtmp_enc, TARGET_SEALED).streamKey);
    } catch (err) {
      if (!hasValidKek("RELAY_KEK")) throw err;
      hint = null;
    }
    hints.set(r.id, hint);
  }
  return hints;
}

/** §5.2 — the row lock Replace key, Remove and createSession all take BEFORE they check, so Remove cannot interleave
 *  with Go live. False for an archived row, another org's row, or no row: the callers' 404. Under READ COMMITTED a
 *  lock that waited re-evaluates `archived_at is null` on the committed row, so a Remove that won reads as absent. */
export async function lockStreamTarget(tx: Tx, orgId: string, targetId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id from org_stream_targets where id = ${targetId} and org_id = ${orgId} and archived_at is null for update`;
  return rows.length === 1;
}

/** D2 — Remove is an archive. False when there was no ACTIVE row of this org to archive (the caller's 404). */
export async function archiveStreamTarget(tx: Tx, orgId: string, targetId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    update org_stream_targets set archived_at = now()
     where id = ${targetId} and org_id = ${orgId} and archived_at is null
    returning id`;
  return rows.length === 1;
}

export type ReplaceKeyResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "undialable"; rule: DestinationRefusal }
  | { ok: false; reason: "duplicate"; other: { id: string; label: string } }
  | { ok: false; reason: "unreadable" };

/** §5.2 Replace key — the SAME url (it was server-filled per platform), a new key: re-sealed and re-fingerprinted. An
 *  ACTIVE row of this org already holding the new fingerprint refuses with its name; an archived one never blocks.
 *  I2 (B1 review): an envelope that will not open (sealed under another KEK — the row the list shows with keyHint null)
 *  is exactly the row Replace key must RECOVER in place, since the old url is gone with it. A platform row's url is its
 *  preset (D6: server-filled), so it is re-sealed there; a legacy kind has no preset to fall back on and is `unreadable`
 *  (the caller's 422: remove it — a legacy kind cannot be added again, D6). The old envelope is never needed to write the new one. */
export async function replaceTargetKey(tx: Tx, orgId: string, targetId: string, streamKey: string): Promise<ReplaceKeyResult> {
  const [row] = await tx<{ rtmp_enc: Uint8Array; dest_fingerprint: string | null; kind: string }[]>`
    select rtmp_enc, dest_fingerprint, kind from org_stream_targets
     where id = ${targetId} and org_id = ${orgId} and archived_at is null`;
  if (!row) return { ok: false, reason: "not_found" };
  let url: string;
  let recovering = false;
  try {
    url = openFields(row.rtmp_enc, TARGET_SEALED).url;
  } catch (err) {
    if (!hasValidKek("RELAY_KEK")) throw err;   // M3: a KEK fault is not an unopenable envelope — no recovery, no warn
    // N3 (B1 review): never silent — an unopenable envelope is how a KEK change shows itself. Target id and kind ONLY.
    log.warn({ targetId, kind: row.kind }, "stream target: the saved destination will not open — Replace key re-seals a platform row on its preset; a legacy kind is refused");
    if (!isStreamPlatform(row.kind)) return { ok: false, reason: "unreadable" };
    url = STREAM_PLATFORM_PRESETS[row.kind];
    recovering = true;
  }
  const dialable = checkDestination(url);
  if (!dialable.ok) return { ok: false, reason: "undialable", rule: dialable.rule };
  const fingerprint = fingerprintDestination(dialable.url, streamKey);
  // A matching fingerprint is a no-op only when the envelope OPENS: a damaged envelope under the current KEK keeps its
  // fingerprint, and "the same key again" is then exactly the re-seal that repairs it.
  if (fingerprint === row.dest_fingerprint && !recovering) return { ok: true, changed: false };
  const otherHolder = () => tx<{ id: string; label: string }[]>`
    select id, label from org_stream_targets
     where org_id = ${orgId} and dest_fingerprint = ${fingerprint} and archived_at is null and id <> ${targetId}`;
  const [other] = await otherHolder();
  if (other) return { ok: false, reason: "duplicate", other: { id: other.id, label: other.label } };
  const wrote = await tx
    .savepoint((sp) => sp`
      update org_stream_targets
         set rtmp_enc = ${seal(JSON.stringify({ url: dialable.url, streamKey }))}, dest_fingerprint = ${fingerprint}
       where id = ${targetId} and org_id = ${orgId} and archived_at is null`)
    .then(() => true)
    .catch((err: unknown) => {
      if (isFingerprintConflict(err)) return false;
      throw err;
    });
  if (wrote) return { ok: true, changed: true };
  const [winner] = await otherHolder();   // a concurrent create took the fingerprint between the read and the write
  if (!winner) throw new StreamTargetVanishedError();
  return { ok: false, reason: "duplicate", other: { id: winner.id, label: winner.label } };
}
