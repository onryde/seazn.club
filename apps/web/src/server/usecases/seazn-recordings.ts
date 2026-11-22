import "server-only";
// server/usecases/seazn-recordings.ts — the stream tick's SEAZN pass (Seazn-hosted video, Phase 1 Task 13; spec G5, probes C3,
// C6, C7). Run by POST /api/cron/stream-tick after the session pass, every firing.
//
// Task 12 signs a Seazn session's programme input, but Cloudflare records a signed input's recording UNSIGNED (C3: the finished
// recording read `requireSignedURLs: false` and played with no token). So every recording of a Seazn programme input is made to
// need a token here, and a `seazn_locked_videos` row (V540) records that it was.
//
// NEVER WHILE IT RECORDS (controller ruling 2026-11-21, review m1): nobody has measured whether live HLS survives this edit (C7
// measured the flag's echo, not the stream), so a `live-inprogress` recording is not touched, whatever it reads — C7 found one
// already reading signed, and one reading unsigned is left until it stops. It is locked the first pass after it stops recording,
// and checked again once `ready`: C7 never showed a lock surviving to `ready`, so a locked recording whose listing reads unsigned
// (or does not say) is locked AGAIN. An input is marked finished (`recordings_locked_at`) only once its session has ended past
// the finalisation grace and every recording has been seen finished AND signed, on a listing short of a full page (review m2: a
// full page may be missing recordings). A marked input is never listed again.
//
// C6 (the Global Constraint): Cloudflare's filtered listing has been seen answering recordings of OTHER inputs, so every listed
// recording must name this input itself (its own `liveInput`) before anything is done to it; one that does not — or names none —
// is counted `refused` and never touched. This pass only signs; it never deletes.
//
// THE DELETION (Phase 1 review I3): the sweep HOLDS every Seazn programme recording for Phase 2 (relay-sweep.ts), so Cloudflare's own
// deletion is the only one, and whether this edit keeps the one the input stamped was never measured. So the lock sends it too
// (`seaznRecordingDeleteAt`): the same instant on every relock, never earlier than Cloudflare's own.
//
// The flags are not read: a Seazn recording is signed whatever SEAZN_HOSTED_LIVE or SEAZN_HOSTED_REPLAY say, as Task 18 holds it
// whatever they are. The pass never throws past one recording; the route wraps the whole pass so a throw (the database down) is
// one failure and the firing goes on. No token is minted here, and nothing logged holds more than ids and an error's class
// (a database error can echo a connection string: route.ts `endYoutube`).
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { DELETE_RECORDING_AFTER_DAYS, FINALISATION_GRACE_SECONDS, MAX_DURATION_MINUTES } from "@/server/relay/config";
import { TERMINAL_STATES, type SessionState } from "@/server/relay/domain/session";
import type { IngestVideo } from "@/server/relay/ports";
import type { SessionDeps } from "./stream-sessions";

/** The pass's slice of the tick's 45 s (plan, Task 13): it gets min(this, what is left), so the firing still stops starting
 *  work at 45 s. */
export const SEAZN_PASS_BUDGET_MS = 8_000;
/** No provider call starts with less than this left of the pass's slice; what is not reached is `deferred` to the next firing. */
export const SEAZN_PASS_CALL_FLOOR_MS = 2_000;
/** Phase 1 review m13: the most foreign recording ids one C6 warning names (it repeats every pass); the count is whole. */
export const SEAZN_PASS_LOGGED_IDS_MAX = 10;

/** The pass's answer, read by the cron Worker as `data.seazn` (`failed` is its one failure counter, R3).
 *  - `locked`: recordings made to need a token for the first time this pass;
 *  - `relocked`: recordings already locked whose listing read unsigned again, or did not say, locked again (C7's unmeasured half);
 *  - `refused`: listed under an input but naming another, or none (C6) — never touched;
 *  - `failed`: a lock that threw — retried next pass;
 *  - `deferred`: inputs the slice did not reach. */
export interface SeaznPassResult { locked: number; relocked: number; refused: number; failed: number; deferred: number }

/** Sessions whose programme input may hold a recording: live, ending or ended (brief). Requested, provisioning and warming are
 *  left to the first pass after the session goes live. */
const RECORDING_STATES: readonly SessionState[] = ["live", "ending", ...TERMINAL_STATES];
/** A recording Cloudflare has finished with: what it is now, it stays. */
const FINISHED = new Set(["ready", "error"]);
/** Cloudflare's state for a recording that is still being recorded: never edited (m1). */
const RECORDING = "live-inprogress";

interface SeaznInput { id: string; session_id: string; org_id: string; uid: string; state: SessionState; end_ref: Date }

/** Phase 1 review I3: when Cloudflare is to delete a Seazn recording, sent in the lock's own edit. The input's retention
 *  (DELETE_RECORDING_AFTER_DAYS, which Cloudflare counts from when the recording is READY) from the recording's CREATION, plus the
 *  longest a recording runs (MAX_DURATION_MINUTES) and finalises (FINALISATION_GRACE_SECONDS): never before Cloudflare's own, and
 *  never short of its "at least 30 days from upload" floor. From the recording's own creation, so a relock sends the same instant.
 *  A creation that is not a date counts from `nowMs` (the pass's clock): the lock must never fail on a timestamp. */
export function seaznRecordingDeleteAt(createdAt: string, nowMs: number): Date {
  const created = Date.parse(createdAt);
  const from = Number.isFinite(created) ? created : nowMs;
  return new Date(from + DELETE_RECORDING_AFTER_DAYS * 86_400_000 + MAX_DURATION_MINUTES * 60_000 + FINALISATION_GRACE_SECONDS * 1000);
}

export async function lockSeaznRecordings(
  deps: Pick<SessionDeps, "drivers">,
  opts: { now: Date; budgetMs: number; orgIds?: readonly string[]; wallClock?: () => number },
): Promise<SeaznPassResult> {
  // `orgIds` and `wallClock` are test seams; the route passes neither. An empty `orgIds` refuses rather than read as "every org".
  const orgIds = opts.orgIds === undefined ? undefined : [...opts.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) {
    throw new Error("seazn pass: orgIds is empty — omit it to pass over every organisation, or name at least one");
  }
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0) {
    throw new Error(`seazn pass: budgetMs must be a finite number of milliseconds, 0 or more, got ${opts.budgetMs}`);
  }
  const wallClock = opts.wallClock ?? Date.now;
  const started = wallClock();
  const canCall = () => opts.budgetMs - (wallClock() - started) >= SEAZN_PASS_CALL_FLOOR_MS;
  const ingest = deps.drivers.ingest;
  const nowMs = opts.now.getTime();
  const out: SeaznPassResult = { locked: 0, relocked: 0, refused: 0, failed: 0, deferred: 0 };

  const inputs = await sql<SeaznInput[]>`
    select i.id, i.session_id, s.org_id, i.ingest_input_id as uid, s.state, coalesce(s.ended_at, s.created_at) as end_ref
      from fixture_stream_inputs i join fixture_stream_sessions s on s.id = i.session_id
     where s.destination_kind = 'seazn' and i.role = 'programme' and i.ingest_input_id is not null
       and i.recordings_locked_at is null and s.state in ${sql([...RECORDING_STATES])}
       ${orgIds ? sql`and s.org_id in ${sql(orgIds)}` : sql``}
     order by s.created_at, i.id`;

  for (let n = 0; n < inputs.length; n++) {
    const input = inputs[n]!;
    if (!canCall()) { out.deferred += inputs.length - n; break; }
    let listed: IngestVideo[];
    try {
      listed = await ingest.listInputVideos(input.uid, { sessionId: input.session_id });
    } catch (err) {
      out.failed++;
      log.error({ sid: input.session_id, errClass: err instanceof Error ? err.name : typeof err }, "seazn pass: a programme input's recordings could not be listed — the next pass retries it");
      continue;
    }
    // C6: only this input's own recordings. The rest are counted and left alone, by id only.
    const own = listed.filter((v) => v.inputId === input.uid);
    // A FULL page means "there may be more" (relay-sweep.ts's camera step, A13): what it listed is locked, but no mark is written.
    const truncated = listed.length >= ingest.capabilities.listVideosPageLimit;
    if (truncated) log.warn({ sid: input.session_id, listed: listed.length }, "seazn pass: a programme input's listing came back a full page — the tail may be missing; not marked this pass");
    const foreign = listed.filter((v) => v.inputId !== input.uid);
    if (foreign.length > 0) {
      out.refused += foreign.length;
      log.warn({ sid: input.session_id, refusedCount: foreign.length, refused: foreign.slice(0, SEAZN_PASS_LOGGED_IDS_MAX).map((v) => ({ videoId: v.videoId, videoInput: v.inputId })) }, "seazn pass: a programme input's listing named recordings of another input — left untouched (C6)");
    }
    const lockedBefore = own.length === 0 ? new Set<string>() : new Set((await sql<{ cf_video_id: string }[]>`
      select cf_video_id from seazn_locked_videos where cf_video_id in ${sql(own.map((v) => v.videoId))}`).map((r) => r.cf_video_id));

    let confirmed = 0;   // own recordings seen locked this pass (or gone)
    let stopped = false;
    for (const v of own) {
      if (v.state === RECORDING) continue;   // m1: never edited mid-stream; it is not finished, so it also holds the mark back
      const known = lockedBefore.has(v.videoId);
      // Already locked and reading signed: nothing to ask. Reading unsigned, or not saying (`null`): locked again (C7), so the
      // mark rests on an echo, never a guess.
      if (known && v.signed === true) { confirmed++; continue; }
      if (!canCall()) { stopped = true; break; }
      try {
        const res = await ingest.requireSignedVideo(v.videoId, { deleteAt: seaznRecordingDeleteAt(v.createdAt, nowMs) });
        if (res === "set" && !known) {
          await sql`insert into seazn_locked_videos (cf_video_id, input_row_id) values (${v.videoId}, ${input.id}) on conflict (cf_video_id) do nothing`;
          out.locked++;
        } else if (res === "set") {
          out.relocked++;
          log.warn({ sid: input.session_id, videoId: v.videoId, state: v.state, signed: v.signed }, "seazn pass: a locked recording read unsigned, or did not say — locked again (C7)");
        }
        confirmed++;   // "set" echoed true; "absent" is a recording Cloudflare no longer holds
      } catch (err) {
        out.failed++;
        log.error({ sid: input.session_id, videoId: v.videoId, errClass: err instanceof Error ? err.name : typeof err }, "seazn pass: a recording's lock failed — the next pass retries it");
      }
    }
    if (stopped) { out.deferred += inputs.length - n; break; }

    // The mark: the session has ended past the grace (no recording can still appear or finish), the listing was short of a page,
    // and every own recording is finished and was seen locked this pass. Refused recordings are not this input's, so they never
    // hold the mark back.
    const settled = TERMINAL_STATES.includes(input.state) && nowMs - new Date(input.end_ref).getTime() > FINALISATION_GRACE_SECONDS * 1000;
    if (settled && !truncated && confirmed === own.length && own.every((v) => FINISHED.has(v.state))) {
      await sql`update fixture_stream_inputs set recordings_locked_at = coalesce(recordings_locked_at, ${opts.now}) where id = ${input.id}`;
    }
  }
  log.info({ ...out, inputs: inputs.length, scoped: orgIds !== undefined }, "seazn pass");
  return out;
}
