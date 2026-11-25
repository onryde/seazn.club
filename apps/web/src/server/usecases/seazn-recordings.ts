import "server-only";
// server/usecases/seazn-recordings.ts — the stream tick's SEAZN pass (Seazn-hosted video, Phase 1 Task 13; spec G5, probes C3,
// C6, C7). Run by POST /api/cron/stream-tick after the session pass, every firing.
//
// Task 12 signs a Seazn session's programme input, but Cloudflare records a signed input's recording UNSIGNED (C3: the finished
// recording read `requireSignedURLs: false` and played with no token). So every recording of a Seazn programme input is made to
// need a token here, and a `seazn_locked_videos` row (V541) records that it was.
//
// NEVER WHILE IT RECORDS (controller ruling 2026-11-21, review m1): nobody has measured whether live HLS survives this edit (C7
// measured the flag's echo, not the stream), so a `live-inprogress` recording is not touched, whatever it reads — C7 found one
// already reading signed, and one reading unsigned is left until it stops. It is locked the first pass after it stops recording,
// and checked again once `ready`: C7 never showed a lock surviving to `ready`, so a locked recording whose listing reads unsigned
// (or does not say) is locked AGAIN. An input is marked finished (`recordings_locked_at`) only once its session has ended past
// the finalisation grace and every recording has been seen finished AND signed, on a listing short of a full page (review m2: a
// full page may be missing recordings). A marked input is never listed again.
//
// OFFERED ONLY WHEN PLAYABLE (Task 39): locking is not playing. Every finished recording is locked at once (signing must not wait), but
// the replay read offers a Cloudflare part only once the recording is `ready` (`playable`, below), which this pass records as
// `seazn_locked_videos.ready_at` on EVERY firing it lists the recording, locked this firing or before: set the first time it reads
// ready, kept while it does, cleared if Cloudflare later reads it otherwise (an `error`). An errored recording is locked and never
// ready, and an input is marked only once every recording is `ready` or `error` (an errored one is as finished as it will get).
// A reconnect inside Cloudflare's hold window continues the SAME recording (one uid, so one part); only a recording after the
// window is another uid, and so another part. Nothing here keys a part on anything but the uid.
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
import { fireStreamPresenceRevalidate } from "@/server/public-site/revalidate";
import { DELETE_RECORDING_AFTER_DAYS, FINALISATION_GRACE_SECONDS, MAX_DURATION_MINUTES, SEAZN_REPLAY_CALL_TIMEOUT_MS } from "@/server/relay/config";
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
/** Task 39: Cloudflare can play this recording: its state is `ready` and its own `readyToStream` does not say otherwise (null, the
 *  key absent, is not a refusal: a `ready` recording is playable). Everything else (`queued`, `inprogress`, `error`, a state this
 *  code has never seen) is not. */
const playable = (v: IngestVideo): boolean => v.state === "ready" && v.ready !== false;
/** A recording Cloudflare has finished with: what it is now, it stays. A `ready` one is finished only once it is playable. */
const finished = (v: IngestVideo): boolean => playable(v) || v.state === "error";
/** Cloudflare's state for a recording that is still being recorded: never edited (m1). */
const RECORDING = "live-inprogress";

interface SeaznInput { id: string; session_id: string; org_id: string; fixture_id: string | null; uid: string; state: SessionState; end_ref: Date }

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

/** V542 (the Task 14 carry): when the recording BEGAN, stored with its lock so the interim replay can order one session's
 *  parts by it. Cloudflare's `created` on a live input's recording is its start. A creation that is not a date stores null:
 *  the lock never fails on a timestamp, and the read orders such a part after the dated ones. */
function recordedAtOf(createdAt: string): Date | null {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Task 39: write what the listing says of a locked recording's playability: set the first time it reads playable (kept while it
 *  does, so the stamp is when it was FIRST seen ready), cleared when it no longer does.
 *  Phase 4 final review m3: a change expires the fixture's public hub (`fireStreamPresenceRevalidate`, the same expiry a session going
 *  into or out of live fires, apply.ts), because the hub's "replay" camera follows `ready_at`; without it the camera appears up to the hub
 *  document's own window (15 s Redis, 30 s ISR) late. Fire-and-forget, after the write, only when a row changed (a second pass fires
 *  nothing); a session whose fixture is gone (`fixture_id` null) has no card to expire. */
async function setReady(videoId: string, isPlayable: boolean, now: Date, fixtureId: string | null): Promise<void> {
  const changed = await sql`
    update seazn_locked_videos set ready_at = ${isPlayable ? now : null}
     where cf_video_id = ${videoId} and (ready_at is not null) is distinct from ${isPlayable}
    returning cf_video_id`;
  if (changed.length > 0 && fixtureId !== null) void fireStreamPresenceRevalidate(fixtureId);
}
/** `setReady` that never throws past one recording: a failure is logged by class and answers false, so the caller counts it and the
 *  next pass retries it (and the input is not marked on a readiness it could not write). */
async function markReady(videoId: string, isPlayable: boolean, sessionId: string, now: Date, fixtureId: string | null): Promise<boolean> {
  try {
    await setReady(videoId, isPlayable, now, fixtureId);
    return true;
  } catch (err) {
    log.error({ sid: sessionId, videoId, errClass: err instanceof Error ? err.name : typeof err }, "seazn pass: a recording's readiness could not be written — the next pass retries it");
    return false;
  }
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
    select i.id, i.session_id, s.org_id, s.fixture_id, i.ingest_input_id as uid, s.state, coalesce(s.ended_at, s.created_at) as end_ref
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
      // Task 24 review I3 follow-up: the listing gives up at the slice's call timeout, so a hung one is a failure, never a held tick.
      listed = await ingest.listInputVideos(input.uid, { sessionId: input.session_id, timeoutMs: SEAZN_REPLAY_CALL_TIMEOUT_MS });
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
    // The locks it already has, and whether each is marked playable (Task 39).
    const lockedBefore = own.length === 0 ? new Map<string, boolean>() : new Map((await sql<{ cf_video_id: string; ready: boolean }[]>`
      select cf_video_id, ready_at is not null as ready from seazn_locked_videos where cf_video_id in ${sql(own.map((v) => v.videoId))}`).map((r) => [r.cf_video_id, r.ready]));

    let confirmed = 0;   // own recordings seen locked this pass (or gone)
    let stopped = false;
    for (const v of own) {
      if (v.state === RECORDING) continue;   // m1: never edited mid-stream; it is not finished, so it also holds the mark back
      const known = lockedBefore.has(v.videoId);
      // Task 39: whether the stored readiness already says what the listing says; a lock that does not need an edit is not edited.
      const readyStale = known && lockedBefore.get(v.videoId) !== playable(v);
      // Already locked and reading signed: nothing to ask. Reading unsigned, or not saying (`null`): locked again (C7), so the
      // mark rests on an echo, never a guess.
      if (known && v.signed === true) {
        if (readyStale && !(await markReady(v.videoId, playable(v), input.session_id, opts.now, input.fixture_id))) { out.failed++; continue; }
        confirmed++;
        continue;
      }
      if (!canCall()) { stopped = true; break; }
      try {
        // Re-review N3: the lock shares the slice too, so it gives up at the same 4 s as the listing.
        const res = await ingest.requireSignedVideo(v.videoId, { deleteAt: seaznRecordingDeleteAt(v.createdAt, nowMs), timeoutMs: SEAZN_REPLAY_CALL_TIMEOUT_MS });
        if (res === "set" && !known) {
          const inserted = await sql`
            insert into seazn_locked_videos (cf_video_id, input_row_id, recorded_at, ready_at)
            values (${v.videoId}, ${input.id}, ${recordedAtOf(v.createdAt)}, ${playable(v) ? opts.now : null}) on conflict (cf_video_id) do nothing
            returning cf_video_id`;
          // A recording locked already playable is a replay camera appearing too (m3).
          if (inserted.length > 0 && playable(v) && input.fixture_id !== null) void fireStreamPresenceRevalidate(input.fixture_id);
          out.locked++;
        } else if (res === "set") {
          out.relocked++;
          log.warn({ sid: input.session_id, videoId: v.videoId, state: v.state, signed: v.signed }, "seazn pass: a locked recording read unsigned, or did not say — locked again (C7)");
          if (readyStale) await setReady(v.videoId, playable(v), opts.now, input.fixture_id);
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
    if (settled && !truncated && confirmed === own.length && own.every(finished)) {
      await sql`update fixture_stream_inputs set recordings_locked_at = coalesce(recordings_locked_at, ${opts.now}) where id = ${input.id}`;
    }
  }
  log.info({ ...out, inputs: inputs.length, scoped: orgIds !== undefined }, "seazn pass");
  return out;
}
