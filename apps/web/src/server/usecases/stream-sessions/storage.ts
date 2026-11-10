import "server-only";
// Admission's recording pool: fitted usage, reservations, headroom, the overcommit report (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { FINALISATION_GRACE_SECONDS, RECORDING_RETENTION_DAYS } from "@/server/relay/config";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { evaluate } from "@/server/relay/domain/expiry";
import { elapsedMinutesSince, endedReservationMinutes, headroomAfterReservations, reservationMinutes } from "@/server/relay/domain/credits";
import type { StorageUsage } from "@/server/relay/ports";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { type Row, cols, d, toSession } from "./session-row";

// ---------------------------------------------------------------------------
// Admission (C3 + B: reservations exclude sessions the policy already expires)
// ---------------------------------------------------------------------------
/** G7 (lane C A22(d)): Cloudflare reports storage in FRACTIONAL minutes (R0 measured `totalStorageMinutes` 396.84 and
 *  33.31), and every column that records it is an INTEGER (V410: `storage_minutes_at_admission`, and the snapshot's
 *  used/limit/reserved/headroom, whose CHECK is `headroom = limit − used − reserved`). Postgres refuses a fraction for an
 *  integer parameter outright (22P02), so an unfitted number failed EVERY start and every sweep snapshot. The ONE place
 *  the reading is fitted, for admission and the sweep alike, and conservatively: `used` rounds UP and the limit DOWN, so
 *  the headroom computed from the fitted pair can only UNDER-state the room — never admit a match the account cannot hold.
 *  Integers pass through untouched. */
export function storageUsageForColumns(u: StorageUsage): StorageUsage {
  return { totalStorageMinutes: Math.ceil(u.totalStorageMinutes), totalStorageMinutesLimit: Math.floor(u.totalStorageMinutesLimit), videoCount: u.videoCount };
}

/** C3 + R2004: every session's claim on the one recording pool, per session (exported for its test — the pool is the
 *  whole database's, so a test reads its OWN rows out of this, never the sum).
 *
 *  THE START the rules below count from is `warming_at` — the instant the session entered `warming`, i.e. the inputs were
 *  provisioned and the camera's credentials issued. It is the earliest instant the camera input CAN record: a phone can
 *  publish to input A as soon as it is paired, which is during warming and BEFORE the session goes live (`started_at`
 *  would under-count a composed session's camera by its whole warming time — up to WARMING_TIMEOUT_MINUTES, 10, past
 *  which the session fails), and `first_ingest_at` is never written for a composed session at all (only the passthrough
 *  poll writes it). Counting from `warming_at` can over-count the programme input B by at most that warming window and a
 *  passthrough input (which records only while connected) likewise — an over-statement of a few minutes, never an
 *  under-statement of the camera. A session with no `warming_at` has no start because it never warmed: running, that is
 *  elapsed 0 (the buffer only — it has not begun); ended, it recorded nothing and reserves 0 (review of PR #1041, m3).
 *  A warmed session whose `ended_at` is missing is the unreadable case, and falls back to the WHOLE booking (never 0).
 *
 *   - a RUNNING session reserves, per recording it makes (`reservationMinutes`; one for passthrough, two for composed —
 *     owner ruling 2026-10-18, option (a): the camera (A) keeps recording so the phone's delivery watch keeps its HLS, and
 *     the programme (B) records the product), `min(maxDurationMinutes, ceil(minutes since the start) + RESERVATION_BUFFER_MINUTES)`
 *     — owner ruling 2026-10-26 (E1, "30 mins buffer"). This AMENDS the 2026-10-18 ruling's "a full match per recording
 *     while it runs": the reservation rolls with the stream instead of claiming 2 × 300 the moment it starts, so a new
 *     start needs only RECORDINGS_PER_SESSION × 30 (composed 60, passthrough 30) of headroom. The price is that a
 *     reservation no longer guarantees a full booking, so the pool CAN be overcommitted by streams that run long together;
 *     that is reported (`reportStorageOvercommit`) and never enforced against a running stream;
 *   - an ENDED composed session keeps the camera's share until the daily sweep has deleted A's recordings
 *     (`fixture_stream_inputs.recordings_deleted_at`, written by the daily sweep's camera pass, phase 1c) — the 2026-10-18
 *     ruling's "released once A's recording is deleted", which STANDS. Owner ruling 2026-10-26 ("C") amends HOW MUCH it
 *     keeps: only the minutes the session actually ran (start to `ended_at`), rounded UP to a whole minute and capped at
 *     the booking (`endedCameraReservationMinutes`) — not a whole match, so a 6-minute stream no longer holds 300 until
 *     the sweep (owner, stg 2026-10-26: 70.6 of 1000 minutes used and "Go live" refused for storage). A warmed session
 *     whose end is missing or unreadable is the whole booking, never 0. Bounded by the retention horizon (ended +
 *     RECORDING_RETENTION_DAYS): by then retention has deleted every recording that old, so a delete that never succeeds
 *     cannot hold the pool forever. A camera input the provider never made recorded nothing and reserves nothing. Once the
 *     camera's recording is finalised Cloudflare's own usage counts it too, so until the sweep deletes it a composed match's
 *     camera is counted twice — an under-statement of the room;
 *   - for the FINALISATION GRACE after `ended_at` (`FINALISATION_GRACE_SECONDS`: the ingest hold window plus a cautious processing allowance) EVERY recording of
 *     an ended session keeps its span reserved — composed twice (the camera and the programme), passthrough once (review I1
 *     of PR #1041, owner-directed 2026-10-26). R0 F2: an in-progress recording is counted by NOTHING in `storage-usage`; its
 *     minutes land in one lump when Cloudflare finalises it, that long after the input disconnects. Without this window
 *     the programme (and a passthrough recording) vanished from the pool at the instant a match ended and reappeared in
 *     Cloudflare's usage ~3 minutes later — exactly while the next match's start is being admitted. After it the programme
 *     and the passthrough recording are in the usage and stop reserving, and only the composed camera remains, as above.
 *     Everything is counted from the same `warming_at` span (`endedReservationMinutes`), an over-statement for the
 *     programme (which starts after the camera) and for a passthrough input, never an under-statement. */
export async function storageReservations(exec: Tx | typeof sql, now: Date): Promise<{ sessionId: string; minutes: number }[]> {
  const rows = await exec<Row[]>`select ${cols()} from fixture_stream_sessions where state in ${sql([...ACTIVE_STATES])}`;
  const running = rows
    .map(toSession)
    .filter((s) => { const x = evaluate(s, now).kind; return x === "none" || x === "stale_beat" || x === "grace_expired"; })   // a Machine being replaced or flushed still records
    .map((s) => ({ sessionId: s.id, minutes: reservationMinutes(s.mode, s.maxDurationMinutes, elapsedMinutesSince(s.warmingAt, now)) }));
  const horizon = new Date(now.getTime() - RECORDING_RETENTION_DAYS * 86_400_000);
  // An ENDED session is read when its recordings are still finalising (any mode: `ended_at` newer than the grace) or when it is
  // a composed one whose camera recording is still held. The amount is the domain's (`endedReservationMinutes`); a session that
  // reserves nothing (never warmed, or past the grace with the camera released) is absent from the read.
  const finalisingSince = new Date(now.getTime() - FINALISATION_GRACE_SECONDS * 1000);
  const ended = await exec<{ id: string; mode: "passthrough" | "composed"; max_duration_minutes: number; warming_at: string | null; ended_at: string | null; camera_held: boolean }[]>`
    select * from (
      select s.id, s.mode, s.max_duration_minutes, s.warming_at, s.ended_at,
             exists (select 1 from fixture_stream_inputs i
                      where i.session_id = s.id and i.role = 'camera' and i.ingest_input_id is not null and i.recordings_deleted_at is null) as camera_held
        from fixture_stream_sessions s
       where s.state in ${sql([...TERMINAL_STATES])} and coalesce(s.ended_at, s.created_at) > ${horizon}
    ) t
     where t.ended_at > ${finalisingSince} or (t.mode = 'composed' and t.camera_held)`;
  const settled = ended
    .map((e) => ({ sessionId: e.id, minutes: endedReservationMinutes({
      mode: e.mode, warmingAt: d(e.warming_at), endedAt: d(e.ended_at), maxDurationMinutes: e.max_duration_minutes, now, cameraHeld: e.camera_held }) }))
    .filter((r) => r.minutes > 0);
  return [...running, ...settled];
}

/** Owner ruling 2026-10-26 (E1): the pool's reading when the reservations outrun it. Pure of the database so the report's
 *  numbers are its test's to pin. NUMBERS ONLY — minutes and a count; no session, org or fixture id rides along. */
export function reportStorageOvercommit(a: { source: "admission" | "sweep"; usage: StorageUsage; reservedMinutes: number; reservingSessions: number; headroomMinutes: number }): void {
  log.warn({ source: a.source, headroomMinutes: a.headroomMinutes, usedMinutes: a.usage.totalStorageMinutes, limitMinutes: a.usage.totalStorageMinutesLimit,
    reservedMinutes: a.reservedMinutes, reservingSessions: a.reservingSessions }, "relay storage: the reservations exceed the pool — overcommitted");
  captureError(new Error("relay storage overcommitted: reservations exceed the recording pool"), { route: "relay.storage_overcommitted", extra: {
    source: a.source, headroomMinutes: a.headroomMinutes, usedMinutes: a.usage.totalStorageMinutes, limitMinutes: a.usage.totalStorageMinutesLimit,
    reservedMinutes: a.reservedMinutes, reservingSessions: a.reservingSessions } });
}

/** limit − used − Σ reservations. `source`, when given, names the pass reading it (an admission or the daily sweep), and a
 *  NEGATIVE result is then reported ONCE for that read as `relay.storage_overcommitted` (E1: a reservation no longer
 *  guarantees a full booking, so streams that run long together can outgrow the pool). Reporting never throws, never
 *  refuses and never touches a running stream — the headroom is returned either way. */
export async function storageHeadroomMinutes(exec: Tx | typeof sql, usage: StorageUsage, now: Date, source?: "admission" | "sweep"): Promise<number> {
  const reservations = await storageReservations(exec, now);
  const headroom = headroomAfterReservations(usage, reservations.map((r) => r.minutes));
  if (source !== undefined && headroom < 0) {
    try {
      reportStorageOvercommit({ source, usage, headroomMinutes: headroom, reservingSessions: reservations.length,
        reservedMinutes: reservations.reduce((n, r) => n + r.minutes, 0) });
    } catch (err) {
      log.error({ err: String(err) }, "relay storage: the overcommit report itself failed — the headroom is returned regardless");
    }
  }
  return headroom;
}
