// server/relay/telemetry.ts — the only SQL that WRITES a capture table
// (enc-boundary.test.ts claim 4). Every payload passes sanitise() HERE, so a
// caller cannot skip it. recordEvent takes a Tx on purpose: an event is part of
// the state change that caused it, and stream-sessions.ts calls it inside the
// row-lock transaction — a failure here rolls the state back (atomicity test,
// Task 10).
import type postgres from "postgres";
import type { Tx } from "@/lib/db";
import { APP_BUILD_SHA, SAMPLES_PER_SESSION_CAP } from "./config";
import { pathTemplate, sanitise } from "./sanitise";

// `@/lib/db` exports `Tx` but keeps its `Sql` alias private; `postgres.Sql` is
// the pooled client's type, as in audit.ts / registrations.ts's AnySql.
type Exec = postgres.Sql | Tx;

export type EventSource = "domain" | "runner" | "ingest" | "output" | "sweep" | "webhook" | "admin" | "client";
export type EventKind = "event" | "transition" | "runner_transition" | "observed" | "effect" | "action";

export interface EventInput {
  sessionId: string;
  orgId: string;
  source: EventSource;
  kind: EventKind;
  type: string;
  from?: string | null;
  to?: string | null;
  result?: "ok" | "failed" | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  attempt?: number | null;
  providerRequestId?: string | null;
  actorUserId?: string | null;
  payload?: unknown;
  occurredAt?: Date;
}

/** Appends one row and returns its seq. The seq is `max + 1` under the
 *  caller's row lock on fixture_stream_sessions — two writers on one session
 *  cannot race because they cannot both hold the lock.
 *
 *  ROOT transaction only: call it inside `sql.begin`, never inside `withTenant`.
 *  `withTenant` runs `set local role app_user`, and V408 grants app_user nothing
 *  on the relay tables — under that role this insert fails with `permission
 *  denied for table fixture_stream_events` (measured 2026-09-16 on the V408
 *  schema). If a grant is ever added, FORCE row level security with ZERO
 *  policies still denies app_user every row. `Tx` types both transactions
 *  alike, so this sentence is the only thing that tells them apart. */
export async function recordEvent(tx: Tx, e: EventInput): Promise<number> {
  const [row] = await tx<{ seq: number }[]>`
    insert into fixture_stream_events
      (session_id, org_id, seq, occurred_at, source, kind, type, from_state, to_state, result,
       http_status, latency_ms, attempt, provider_request_id, actor_user_id, app_build_sha, payload)
    select ${e.sessionId}, ${e.orgId}, coalesce(max(seq), 0) + 1, ${e.occurredAt ?? new Date()},
           ${e.source}, ${e.kind}, ${e.type}, ${e.from ?? null}, ${e.to ?? null}, ${e.result ?? null},
           ${e.httpStatus ?? null}, ${e.latencyMs ?? null}, ${e.attempt ?? null}, ${e.providerRequestId ?? null},
           ${e.actorUserId ?? null}, ${APP_BUILD_SHA}, ${tx.json(sanitise(e.payload) as never)}
      from fixture_stream_events where session_id = ${e.sessionId}
    returning seq`;
  return row!.seq;
}

export interface SampleInput {
  sessionId: string;
  source: "heartbeat" | "poll";
  ingestState?: string | null;
  bitrateKbps?: number | null;
  fps?: number | null;
  droppedFrames?: number | null;
  outputState?: string | null;
  runnerCpuPct?: number | null;
  runnerMemMb?: number | null;
  encoderSpeed?: number | null;
  /** Dh: Cloudflare's `status.current.reason`, verbatim (Task 10 passes it from the ingest status read). */
  ingestReason?: string | null;
  raw?: unknown;
  sampledAt?: Date;
}

/** One row per beat/poll, capped per session. The cap is checked in the same
 *  statement as the insert (`where (select count(*) …) < cap`), so two
 *  concurrent beats at the boundary cannot both land. */
export async function recordSample(exec: Exec, s: SampleInput): Promise<"written" | "capped"> {
  const rows = await exec<{ id: number }[]>`
    insert into fixture_stream_samples
      (session_id, sampled_at, source, ingest_state, bitrate_kbps, fps, dropped_frames,
       output_state, runner_cpu_pct, runner_mem_mb, encoder_speed, ingest_reason, app_build_sha, raw)
    select ${s.sessionId}, ${s.sampledAt ?? new Date()}, ${s.source}, ${s.ingestState ?? null}, ${s.bitrateKbps ?? null},
           ${s.fps ?? null}, ${s.droppedFrames ?? null}, ${s.outputState ?? null},
           ${s.runnerCpuPct ?? null}, ${s.runnerMemMb ?? null}, ${s.encoderSpeed ?? null}, ${s.ingestReason ?? null},
           ${APP_BUILD_SHA}, ${exec.json(sanitise(s.raw) as never)}
     where (select count(*) from fixture_stream_samples where session_id = ${s.sessionId}) < ${SAMPLES_PER_SESSION_CAP}
    returning id`;
  return rows.length === 1 ? "written" : "capped";
}

export interface ProviderCallInput {
  sessionId?: string | null;
  provider: "cloudflare" | "fly" | "stripe";
  operation: string;
  /** The input uid / machine id the call was about — a provider id, never a secret. */
  subjectId?: string | null;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The URL as called; reduced to a template here — the raw URL never reaches SQL. */
  url: string;
  /** Every id the adapter interpolated into the URL, so each becomes `{id}`. */
  ids: readonly string[];
  status?: number | null;
  latencyMs: number;
  attempt: number;
  retryReason?: string | null;
  retryAfterSeconds?: number | null;
  requestId?: string | null;
  errorCode?: string | null;
  calledAt?: Date;
}

export async function recordProviderCall(exec: Exec, c: ProviderCallInput): Promise<void> {
  await exec`
    insert into stream_provider_calls
      (session_id, provider, operation, subject_id, method, path_template, status, latency_ms, attempt,
       retry_reason, retry_after_seconds, request_id, error_code, called_at)
    values (${c.sessionId ?? null}, ${c.provider}, ${c.operation}, ${c.subjectId ?? null}, ${c.method}, ${pathTemplate(c.url, c.ids)},
            ${c.status ?? null}, ${Math.max(0, Math.round(c.latencyMs))}, ${Math.max(1, c.attempt)},
            ${c.retryReason ?? null}, ${c.retryAfterSeconds ?? null}, ${c.requestId ?? null}, ${c.errorCode ?? null},
            ${c.calledAt ?? new Date()})`;
}

export interface StorageSnapshotInput {
  source: "sweep" | "admission";
  sessionId?: string | null;
  usedMinutes: number;
  limitMinutes: number;
  reservedMinutes: number;
  headroomMinutes: number;
  videosDeleted?: number;
  inputsDeleted?: number;
  deferred?: number;
  takenAt?: Date;
}

export async function recordStorageSnapshot(exec: Exec, s: StorageSnapshotInput): Promise<void> {
  await exec`
    insert into stream_storage_snapshots
      (taken_at, source, session_id, used_minutes, limit_minutes, reserved_minutes, headroom_minutes,
       videos_deleted, inputs_deleted, deferred)
    values (${s.takenAt ?? new Date()}, ${s.source}, ${s.sessionId ?? null}, ${s.usedMinutes}, ${s.limitMinutes},
            ${s.reservedMinutes}, ${s.headroomMinutes}, ${s.videosDeleted ?? 0}, ${s.inputsDeleted ?? 0}, ${s.deferred ?? 0})`;
}
