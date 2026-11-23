import "server-only";
// server/usecases/seazn-replays.ts — moving a Seazn match's recordings from Cloudflare to the replay host (Seazn-hosted video,
// Phase 2, Task 24). Run by POST /api/cron/stream-tick after the Seazn lock pass, inside the same slice, every firing, and only
// with SEAZN_HOSTED_REPLAY on (`runSeaznReplays`).
//
// DISCOVERY (`discoverSeaznRecordings`): a Seazn session's programme input is listed once its session has ended past the
// finalisation grace AND its fixture was decided SEAZN_REPLAY_DELAY_MINUTES ago (owner ruling 2026-11-21, G-A) — or, for a fixture
// never decided, once the session ended SEAZN_REPLAY_UNDECIDED_FALLBACK_HOURS ago (recommendation 2026-11-21, G-F). Each listed
// recording must name the input itself (C6); one that does not is counted `refused` and never touched. A finished recording
// becomes a `found` row with its part number (the number the match page already shows for it: domain/replay-parts.ts
// `partNumbers` over the video read's own entries, assigned once, review I1); once every
// recording of the input is finished, on a listing short of a full page, the input is marked and never listed again.
//
// THE MOVE (`moveSeaznRecordings`): due rows are claimed in one statement that leases them (`replayClaimQuery`), then each row's
// next step comes from the pure transition table (video/domain/replay-move.ts `nextReplayStep`) and runs through `STEPS`, a lookup
// table of handlers keyed by the step's kind. Every write is conditional on the state the handler read (`write`): zero rows means
// another actor moved the row (an organiser delete, the webhook), and the row is dropped — a host copy the fetch just made for it is
// removed first. The next state is written BEFORE the provider call it leads to, so a crash after the call is resumed by the stale
// timeout, never by a blind second fetch.
//
// THE CLOUDFLARE DELETE (the binding rule, 2026-11-20: 25 recordings were lost to a filtered listing): `deleteVideo` is called only
// with the CLAIMED ROW's own `cf_video_id` — checked against its input at discovery (C6) — and only when the pure gate
// (`cfDeleteGate`, inside `nextReplayStep`) says `verified_at + SEAZN_CF_DELETE_DELAY_MINUTES` has passed. A copy that fails the
// check is never followed by a delete; a row never verified never earns one (its Cloudflare copy is left to Cloudflare's own
// scheduled deletion, Task 13).
//
// SECRETS: the fetch URL carries a downloadable token. It goes to the replay host and nowhere else: never logged, never stored,
// never in an error this module raises. A provider's error message is logged only through the shared scrubber
// (`scrubScoreUrl`), and a database error only by its class (it can echo a connection string: route.ts `endYoutube`).
import { sql, type Tx } from "@/lib/db";
import { scrubScoreUrl } from "@/lib/scrub-score-url";
import { log } from "@/server/logger";
import {
  FINALISATION_GRACE_SECONDS, SEAZN_CLAIM_LEASE_SECONDS, SEAZN_FETCH_URL_TTL_SECONDS, SEAZN_POLL_BACKSTOP_MINUTES,
  SEAZN_REPLAY_CALL_TIMEOUT_MS, SEAZN_REPLAY_CLAIM_BATCH, SEAZN_REPLAY_DELAY_MINUTES, SEAZN_REPLAY_UNDECIDED_FALLBACK_HOURS,
  seaznHostedReplay,
} from "@/server/relay/config";
import { TERMINAL_STATES } from "@/server/relay/domain/session";
import type { IngestProvider, IngestVideo } from "@/server/relay/ports";
import { type PlaybackTokenCache, signDownload } from "@/server/video/cf-playback";
import {
  REPLAY_PARKED_AT, type ReplayRow, type ReplayRowState, type ReplayStep, nextReplayStep, pollOutcome, replayCopyTitle, replayFailure,
  replayFailureOutcome,
} from "@/server/video/domain/replay-move";
import { partNumbers } from "@/server/video/domain/replay-parts";
import { readReplayEntries } from "@/server/video/replay-entries";
import type { ReplayHost } from "@/server/video/replay-ports";
import { SEAZN_PASS_CALL_FLOOR_MS, SEAZN_PASS_LOGGED_IDS_MAX } from "./seazn-recordings";

const MIN = 60_000;
/** Review I3 (2026-11-22): every Cloudflare call the move makes gives up after SEAZN_REPLAY_CALL_TIMEOUT_MS, under the tick's 8 s
 *  Seazn slice (the replay host's adapter applies the same bound to each of its own calls). */
const TIMED = { timeoutMs: SEAZN_REPLAY_CALL_TIMEOUT_MS } as const;
/** The most steps one row takes in one run (a retry, then the download and the fetch). A row still moving after them is released
 *  to the next firing. */
const MAX_STEPS_PER_ROW = 3;
/** A recording Cloudflare has finished with (the lock pass's set). Only a `ready` one is moved; an `error` one has nothing to move. */
const FINISHED = new Set(["ready", "error"]);

export interface SeaznReplayDeps {
  ingest: Pick<IngestProvider, "listInputVideos" | "createDownload" | "deleteVideo" | "playbackToken" | "capabilities">;
  replay: ReplayHost;
  tokenCache: PlaybackTokenCache;
}
export interface SeaznReplayOpts { now: Date; budgetMs: number; orgIds?: readonly string[]; wallClock?: () => number }

/** The replay half of the tick's `seazn` answer (the route adds it to the lock pass's).
 *  - `discovered`: `found` rows inserted;
 *  - `moved`: state changes written (a Cloudflare delete and a cleanup count as one each);
 *  - `playable`: copies that passed the check this run;
 *  - `refused`: listed recordings naming another input, or none (C6) — never touched;
 *  - `failed`: provider calls that threw, copies that failed the check, rows refused by name — each retried after its backoff;
 *  - `deferred`: inputs or rows the slice did not reach. */
export interface SeaznReplayResult { discovered: number; moved: number; playable: number; refused: number; failed: number; deferred: number }
const zero = (): SeaznReplayResult => ({ discovered: 0, moved: 0, playable: 0, refused: 0, failed: 0, deferred: 0 });

function checkOpts(o: SeaznReplayOpts): string[] | undefined {
  const orgIds = o.orgIds === undefined ? undefined : [...o.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) throw new Error("seazn replays: orgIds is empty — omit it to pass over every organisation, or name at least one");
  if (!Number.isFinite(o.budgetMs) || o.budgetMs < 0) throw new Error(`seazn replays: budgetMs must be a finite number of milliseconds, 0 or more, got ${o.budgetMs}`);
  return orgIds;
}
const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);
/** A provider's error, for a log line: through the shared scrubber, and short. */
const detail = (err: unknown) => scrubScoreUrl(err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Discovery, then the move, on one slice — only with SEAZN_HOSTED_REPLAY on (which needs LIVE). Off, it makes no call. A
 *  malformed flag throws, and the route counts the throw as one failure. */
export async function runSeaznReplays(deps: SeaznReplayDeps, opts: SeaznReplayOpts): Promise<SeaznReplayResult> {
  checkOpts(opts);
  if (!seaznHostedReplay()) return zero();
  const wallClock = opts.wallClock ?? Date.now;
  const started = wallClock();
  const found = await discoverSeaznRecordings(deps, { ...opts, wallClock });
  const moved = await moveSeaznRecordings(deps, { ...opts, wallClock, budgetMs: Math.max(0, opts.budgetMs - (wallClock() - started)) });
  return {
    discovered: found.discovered, moved: moved.moved, playable: moved.playable,
    refused: found.refused + moved.refused, failed: found.failed + moved.failed, deferred: found.deferred + moved.deferred,
  };
}

// ─── Discovery ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DiscoveryInput { id: string; session_id: string; org_id: string; fixture_id: string; uid: string; session_created_at: Date }

/** The programme inputs discovery lists now (G-A, G-F), oldest session first. The inputs side is V542's discovery index's
 *  predicate (review m4), so it is read through that index rather than scanned every minute (seazn-replays-migration.test.ts
 *  explains this very statement). */
export function replayDiscoveryQuery(exec: typeof sql | Tx, a: { now: Date; orgIds?: readonly string[] }) {
  const graceCut = new Date(a.now.getTime() - FINALISATION_GRACE_SECONDS * 1000);
  const decidedCut = new Date(a.now.getTime() - SEAZN_REPLAY_DELAY_MINUTES * MIN);
  const undecidedCut = new Date(a.now.getTime() - SEAZN_REPLAY_UNDECIDED_FALLBACK_HOURS * 60 * MIN);
  return exec<DiscoveryInput[]>`
    select i.id, i.session_id, s.org_id, s.fixture_id, i.ingest_input_id as uid, s.created_at as session_created_at
      from fixture_stream_inputs i
      join fixture_stream_sessions s on s.id = i.session_id
      join fixtures f on f.id = s.fixture_id
     where s.destination_kind = 'seazn' and i.role = 'programme' and i.ingest_input_id is not null
       and i.replays_discovered_at is null and s.state in ${exec([...TERMINAL_STATES])}
       and coalesce(s.ended_at, s.created_at) < ${graceCut}
       and ((f.finished_at is not null and f.finished_at <= ${decidedCut})
            or (f.finished_at is null and coalesce(s.ended_at, s.created_at) <= ${undecidedCut}))
       ${a.orgIds ? exec`and s.org_id in ${exec([...a.orgIds])}` : exec``}
     order by s.created_at, i.id`;
}

/** When a recording began, for V542's NOT NULL `recorded_at`: the listing's creation; a creation that is not a date falls back to
 *  the session's own start, then to `now`, warned by the recording's id only. */
function recordedAtOf(v: IngestVideo, input: DiscoveryInput, now: Date): Date {
  const listed = Date.parse(v.createdAt);
  if (Number.isFinite(listed)) return new Date(listed);
  const session = new Date(input.session_created_at).getTime();
  log.warn({ sid: input.session_id, videoId: v.videoId }, "seazn replays: a recording's listing carries no creation time — ordered by its session's start");
  return Number.isFinite(session) ? new Date(session) : new Date(now);
}

/** The new parts of one fixture, numbered under the fixture's own lock by the ONE numbering rule (review I1): the fixture's entries
 *  are read through the video read's own query (replay-entries.ts), this input's new recordings among them, and each new row stores
 *  exactly the number `partNumbers` gives it — the number the match page already shows for a locked recording. So a recording this
 *  run skips (an errored one, an input whose listing failed) or a later session listed first moves no part's number. A recording
 *  already held keeps its row and its number. */
async function insertParts(input: DiscoveryInput, videos: IngestVideo[], now: Date): Promise<number> {
  return sql.begin(async (tx: Tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture-replays:" + input.fixture_id}))`;
    const known = new Set((await tx<{ cf_video_id: string }[]>`
      select cf_video_id from fixture_video_replays where cf_video_id in ${tx(videos.map((v) => v.videoId))}`).map((r) => r.cf_video_id));
    const fresh = new Map(videos.filter((v) => !known.has(v.videoId)).map((v) => [v.videoId, { v, at: recordedAtOf(v, input, now) }]));
    if (fresh.size === 0) return 0;
    const entries = await readReplayEntries(tx, {
      fixtureId: input.fixture_id,
      orgId: null,
      pending: {
        sessionId: input.session_id,
        sessionCreatedAt: new Date(input.session_created_at),
        recordings: [...fresh.values()].map(({ v, at }) => ({ cfVideoId: v.videoId, recordedAt: at })),
      },
    });
    const numbers = partNumbers(entries.map((e) => ({ stored: e.row === null ? null : e.row.partNo })));
    let inserted = 0;
    let numbered = 0;
    for (const [i, e] of entries.entries()) {
      const f = fresh.get(e.cfVideoId);
      if (f === undefined || e.row !== null) continue;
      numbered++;
      const { v, at } = f;
      const rows = await tx`
        insert into fixture_video_replays
          (org_id, session_id, fixture_id, cf_video_id, recorded_at, part_no, state, state_at, next_attempt_at, cf_duration_seconds, cf_height)
        values (${input.org_id}, ${input.session_id}, ${input.fixture_id}, ${v.videoId}, ${at}, ${numbers[i]!}, 'found', ${now}, ${now},
                ${v.durationSeconds === null ? null : Math.round(v.durationSeconds)}, ${v.height === null ? null : Math.round(v.height)})
        on conflict (cf_video_id) do nothing returning id`;
      inserted += rows.length;
    }
    // Every new recording is an entry (held by the lock, or pending): one that is not would never be stored. Never guessed past.
    if (numbered !== fresh.size) throw new Error(`seazn replays: ${fresh.size - numbered} new recording(s) missing from the fixture's entries`);
    return inserted;
  });
}

export async function discoverSeaznRecordings(deps: SeaznReplayDeps, opts: SeaznReplayOpts): Promise<SeaznReplayResult> {
  const orgIds = checkOpts(opts);
  const wallClock = opts.wallClock ?? Date.now;
  const started = wallClock();
  const canCall = () => opts.budgetMs - (wallClock() - started) >= SEAZN_PASS_CALL_FLOOR_MS;
  const out = zero();
  const inputs = await replayDiscoveryQuery(sql, { now: opts.now, orgIds });
  for (let n = 0; n < inputs.length; n++) {
    const input = inputs[n]!;
    if (!canCall()) { out.deferred += inputs.length - n; break; }
    let listed: IngestVideo[];
    try {
      listed = await deps.ingest.listInputVideos(input.uid, { sessionId: input.session_id, ...TIMED });
    } catch (err) {
      out.failed++;
      log.error({ sid: input.session_id, errClass: errClass(err), detail: detail(err) }, "seazn replays: a programme input's recordings could not be listed — the next firing retries it");
      continue;
    }
    // C6: only this input's own recordings. The rest are counted and left alone, by id only.
    const own = listed.filter((v) => v.inputId === input.uid);
    const foreign = listed.filter((v) => v.inputId !== input.uid);
    if (foreign.length > 0) {
      out.refused += foreign.length;
      log.warn({ sid: input.session_id, refusedCount: foreign.length, refused: foreign.slice(0, SEAZN_PASS_LOGGED_IDS_MAX).map((v) => ({ videoId: v.videoId, videoInput: v.inputId })) }, "seazn replays: a programme input's listing named recordings of another input — left untouched (C6)");
    }
    const ready = own.filter((v) => !v.inProgress && v.state === "ready");
    if (ready.length > 0) {
      try {
        out.discovered += await insertParts(input, ready, opts.now);
      } catch (err) {
        out.failed++;
        log.error({ sid: input.session_id, errClass: errClass(err) }, "seazn replays: a programme input's recordings could not be recorded — the next firing retries it");
        continue;
      }
    }
    const errored = own.filter((v) => !v.inProgress && v.state === "error");
    if (errored.length > 0) log.warn({ sid: input.session_id, videoIds: errored.slice(0, SEAZN_PASS_LOGGED_IDS_MAX).map((v) => v.videoId) }, "seazn replays: Cloudflare failed a recording — nothing to move");
    // The mark: every own recording finished, on a listing short of a full page (a full one may be missing recordings: A13).
    const truncated = listed.length >= deps.ingest.capabilities.listVideosPageLimit;
    if (!truncated && own.every((v) => !v.inProgress && FINISHED.has(v.state))) {
      await sql`update fixture_stream_inputs set replays_discovered_at = coalesce(replays_discovered_at, ${opts.now}) where id = ${input.id}`;
    }
  }
  return out;
}

// ─── The move ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The claim: every row due now and still to be acted on — the WHERE is V542's `fixture_video_replays_due_idx` predicate, word
 *  for word, so the planner proves the index serves it (seazn-replays-migration.test.ts explains this very query) — leased for
 *  SEAZN_CLAIM_LEASE_SECONDS in the same statement, so a run starting after it commits does not claim the row again, and a
 *  crashed run's rows come back once the lease runs out. `skip locked`: a row another run is claiming is left to it. */
export function replayClaimQuery(exec: typeof sql | Tx, a: { now: Date; leaseUntil: Date; limit: number; orgIds?: readonly string[] }) {
  return exec<ClaimedDbRow[]>`
    update fixture_video_replays set next_attempt_at = ${a.leaseUntil}
     where id in (
       select id from fixture_video_replays
        where next_attempt_at <= ${a.now}
          and (state not in ('playable','deleted')
               or (state = 'playable' and cf_deleted_at is null)
               or (state = 'deleted' and bunny_cleaned_at is null))
          ${a.orgIds ? exec`and org_id in ${exec([...a.orgIds])}` : exec``}
        order by next_attempt_at, id
        limit ${a.limit}
        for update skip locked)
    returning id, org_id, session_id, cf_video_id, state, state_at, recorded_at, bunny_video_id, verified_at, cf_deleted_at,
              bunny_cleaned_at, deleted_at, cf_duration_seconds, cf_height, attempts`;
}

interface ClaimedDbRow {
  id: string; org_id: string; session_id: string; cf_video_id: string; state: ReplayRowState; state_at: Date; recorded_at: Date;
  bunny_video_id: string | null; verified_at: Date | null; cf_deleted_at: Date | null; bunny_cleaned_at: Date | null;
  deleted_at: Date | null; cf_duration_seconds: number | null; cf_height: number | null; attempts: number;
}
interface Claimed extends ReplayRow { id: string; orgId: string; sessionId: string; cfVideoId: string }

const dateOrNull = (d: Date | null) => (d === null ? null : new Date(d));
function claimedOf(r: ClaimedDbRow): Claimed {
  return {
    id: r.id, orgId: r.org_id, sessionId: r.session_id, cfVideoId: r.cf_video_id, state: r.state, stateAt: new Date(r.state_at),
    recordedAt: new Date(r.recorded_at), bunnyVideoId: r.bunny_video_id, verifiedAt: dateOrNull(r.verified_at),
    cfDeletedAt: dateOrNull(r.cf_deleted_at), bunnyCleanedAt: dateOrNull(r.bunny_cleaned_at), deletedAt: dateOrNull(r.deleted_at),
    cfDurationSeconds: r.cf_duration_seconds, cfHeight: r.cf_height, attempts: r.attempts,
  };
}

interface Patch {
  state?: ReplayRowState; state_at?: Date; bunny_video_id?: string | null; length_seconds?: number | null; attempts?: number;
  next_attempt_at?: Date; cf_deleted_at?: Date; verified_at?: Date; bunny_cleaned_at?: Date;
}
/** The one way a row is written: only while it is still in the state the handler read. False: another actor moved it. */
async function write(row: Claimed, expected: ReplayRowState, patch: Patch): Promise<boolean> {
  const done = await sql`
    update fixture_video_replays set ${sql(patch as Record<string, unknown>)} where id = ${row.id} and state = ${expected} returning id`;
  return done.length === 1;
}

interface Run { deps: SeaznReplayDeps; now: Date; out: SeaznReplayResult; canCall: () => boolean }
/** What a handler leaves: `again` — the row moved and its next step may run now; `done` — nothing more this run. */
type Outcome = "again" | "done";
type Handler<K extends ReplayStep["kind"]> = (run: Run, row: Claimed, step: Extract<ReplayStep, { kind: K }>) => Promise<Outcome>;

/** A provider call, a check or a database step failed. Inside the row's retry window: the backoff, on the row as it stands. Past
 *  it (review I2): the row is parked — as `failed`, or in its own state when that is playable or deleted
 *  (`replayFailureOutcome`) — logged once, and never claimed again. A provider's error is logged through the scrubber; a database
 *  error (`source: "db"`) by its class alone (review m3: it can echo a connection string). */
async function failure(run: Run, row: Claimed, step: string, err?: unknown, source: "provider" | "db" = "provider"): Promise<Outcome> {
  run.out.failed++;
  const o = replayFailureOutcome(row, run.now);
  const facts = {
    replayId: row.id, videoId: row.cfVideoId, step, attempts: o.attempts,
    ...(err === undefined ? {} : { errClass: errClass(err), ...(source === "provider" ? { detail: detail(err) } : {}) }),
  };
  if (o.kind === "give_up") {
    if (o.nextAttemptAt.getTime() !== REPLAY_PARKED_AT.getTime()) {
      // Task 31b: parked as failed while it holds a host copy — due again after the backoff, when give_up removes the copy first.
      log.error({ ...facts, state: row.state, parkedAs: o.state, guid: row.bunnyVideoId },
        "seazn replays: a step still failing past the Cloudflare copy's life — given up; its host copy is removed before the row is parked");
    } else {
      log.error({ ...facts, state: row.state, parkedAs: o.state, guid: row.bunnyVideoId },
        "seazn replays: a step still failing past the Cloudflare copy's life — given up: parked, never retried");
    }
    const patch: Patch = { attempts: o.attempts, next_attempt_at: o.nextAttemptAt, ...(o.state === row.state ? {} : { state: o.state, state_at: run.now }) };
    if (await write(row, row.state, patch)) row.state = o.state;
    return "done";
  }
  log.error(facts, "seazn replays: a step failed — retried after its backoff");
  await write(row, row.state, { attempts: o.attempts, next_attempt_at: o.nextAttemptAt });
  return "done";
}
/** The slice ran out before this row's call: the lease is released, so the next firing takes it. */
async function defer(run: Run, row: Claimed): Promise<Outcome> {
  run.out.deferred++;
  await write(row, row.state, { next_attempt_at: run.now });
  return "done";
}
function dropped(row: Claimed, expected: ReplayRowState): Outcome {
  log.info({ replayId: row.id, expected }, "seazn replays: another actor moved the row — dropped from this run");
  return "done";
}
/** Move the in-memory row with a write that landed. */
function moved(run: Run, row: Claimed, patch: { state: ReplayRowState; bunnyVideoId?: string | null }): void {
  row.state = patch.state;
  row.stateAt = run.now;
  if (patch.bunnyVideoId !== undefined) row.bunnyVideoId = patch.bunnyVideoId;
  run.out.moved++;
}

/** Stores an org's first collection unless another run stored one first, and answers the one stored — ours or theirs (the
 *  no-op update makes the statement answer the kept row either way). */
async function keepCollection(orgId: string, made: string): Promise<string> {
  const [kept] = await sql<{ collection_id: string }[]>`
    insert into org_video_collections (org_id, collection_id) values (${orgId}, ${made})
    on conflict (org_id) do update set collection_id = org_video_collections.collection_id
    returning collection_id`;
  return kept!.collection_id;
}

/** `downloading`, the download ready: the org's collection and the signed URL first, then `fetching` is written, then the one
 *  fetch. The org's first collection is made with NO transaction open (review I3: a provider call never holds a pooled
 *  connection): read, made on the host, then stored only if no other run stored one first. The stored one wins; a spare made by
 *  a race is left empty on the host and logged by its id. Each step's failure is logged by its own name, a database one by its
 *  class alone (review m3). */
async function fetchCopy(run: Run, row: Claimed): Promise<Outcome> {
  if (!run.canCall()) return defer(run, row);
  let collectionId: string | undefined;
  try {
    collectionId = (await sql<{ collection_id: string }[]>`select collection_id from org_video_collections where org_id = ${row.orgId}`)[0]?.collection_id;
  } catch (err) {
    return failure(run, row, "read_collection", err, "db");
  }
  if (collectionId === undefined) {
    let made: string;
    try {
      made = await run.deps.replay.createCollection(row.orgId);
    } catch (err) {
      return failure(run, row, "create_collection", err);
    }
    try {
      collectionId = await keepCollection(row.orgId, made);
    } catch (err) {
      return failure(run, row, "store_collection", err, "db");
    }
    if (collectionId !== made) {
      log.warn({ orgId: row.orgId, collectionId: made, kept: collectionId }, "seazn replays: another run stored this org's first collection first — the spare one is left empty on the host");
    }
  }
  let url: string;
  try {
    url = await signDownload({ ingest: run.deps.ingest, tokenCache: run.deps.tokenCache }, row.cfVideoId, run.now, SEAZN_FETCH_URL_TTL_SECONDS, TIMED);
  } catch (err) {
    return failure(run, row, "sign_download", err);
  }
  if (!(await write(row, "downloading", { state: "fetching", state_at: run.now }))) return dropped(row, "downloading");
  moved(run, row, { state: "fetching" });
  let guid: string;
  try {
    guid = await run.deps.replay.fetchFromUrl({ collectionId, title: replayCopyTitle(row.sessionId, row.cfVideoId), url });
  } catch (err) {
    return failure(run, row, "fetch", err);
  }
  const pollAt = new Date(run.now.getTime() + SEAZN_POLL_BACKSTOP_MINUTES * MIN);
  if (!(await write(row, "fetching", { state: "encoding", state_at: run.now, bunny_video_id: guid, next_attempt_at: pollAt }))) {
    // Nothing may stay on the host for a row another actor moved.
    await removeQuietly(run, row, guid);
    return dropped(row, "fetching");
  }
  moved(run, row, { state: "encoding", bunnyVideoId: guid });
  return "done";
}

/** A failed row forgets its copy — only AFTER the remove succeeded (re-review N2), and only while the row is still failed and
 *  still holds that very copy. False: another actor moved the row. */
async function forgetCopy(row: Claimed, guid: string): Promise<boolean> {
  const done = await sql`
    update fixture_video_replays set bunny_video_id = null where id = ${row.id} and state = 'failed' and bunny_video_id = ${guid} returning id`;
  if (done.length !== 1) return false;
  row.bunnyVideoId = null;
  return true;
}

async function removeQuietly(run: Run, row: Claimed, guid: string): Promise<void> {
  try {
    await run.deps.replay.remove(guid);
  } catch (err) {
    run.out.failed++;
    log.error({ replayId: row.id, guid, errClass: errClass(err), detail: detail(err) }, "seazn replays: a stray copy could not be removed — the webhook's stray check removes it (Task 27)");
  }
}

/** The handlers, one per step kind (the lookup table the transition table's answers run through). */
const STEPS: { readonly [K in ReplayStep["kind"]]: Handler<K> } = {
  create_download: async (run, row) => {
    if (row.state === "found") {
      if (!(await write(row, "found", { state: "downloading", state_at: run.now }))) return dropped(row, "found");
      moved(run, row, { state: "downloading" });
    }
    if (!run.canCall()) return defer(run, row);
    let status: "ready" | "inprogress";
    try {
      status = await run.deps.ingest.createDownload(row.cfVideoId, TIMED);
    } catch (err) {
      return failure(run, row, "create_download", err);
    }
    if (status === "inprogress") {
      // Cloudflare is still making it: asked again on the next firing.
      await write(row, "downloading", { next_attempt_at: run.now });
      return "done";
    }
    return fetchCopy(run, row);
  },
  refetch: async (run, row) => {
    // The fetch's answer was lost: back to `downloading`, and the fetch is sent again (its lost copy is the webhook's, Task 27).
    if (!(await write(row, "fetching", { state: "downloading", state_at: run.now }))) return dropped(row, "fetching");
    moved(run, row, { state: "downloading" });
    return "again";
  },
  poll_state: async (run, row) => {
    if (!run.canCall()) return defer(run, row);
    const guid = row.bunnyVideoId!;   // `encoding` holds its copy's id (V542's CHECK)
    let copy;
    try {
      copy = await run.deps.replay.video(guid);
    } catch (err) {
      return failure(run, row, "poll_state", err);
    }
    const o = pollOutcome(row, copy, run.now);
    switch (o.kind) {
      case "processing":
        await write(row, "encoding", { next_attempt_at: o.nextAttemptAt });
        return "done";
      case "verified":
        if (!(await write(row, "encoding", { state: "playable", state_at: run.now, verified_at: o.verifiedAt, length_seconds: o.lengthSeconds, next_attempt_at: o.nextAttemptAt }))) {
          return dropped(row, "encoding");
        }
        moved(run, row, { state: "playable" });
        row.verifiedAt = o.verifiedAt;
        run.out.playable++;
        return "done";
      case "failed": {
        // Never followed by a Cloudflare delete: the move starts again after the backoff. The conditional write comes FIRST
        // (review m2): a row another run verified meanwhile keeps its copy; only a row this write moved has its copy removed. The
        // row keeps the copy's id until the remove succeeds (re-review N2): a remove that fails leaves it there, for the retry.
        run.out.failed++;
        const f = replayFailure(row, run.now);
        log.warn({ replayId: row.id, videoId: row.cfVideoId, guid, reason: o.reason, attempts: f.attempts }, "seazn replays: the host's copy failed the check — it is removed, and the move starts again after the backoff");
        if (!(await write(row, "encoding", { state: "failed", state_at: run.now, attempts: f.attempts, next_attempt_at: f.nextAttemptAt }))) return dropped(row, "encoding");
        row.state = "failed";
        try {
          await run.deps.replay.remove(guid);
        } catch (err) {
          // Already counted as failed; the row still holds the copy, so the retry removes it before anything else.
          log.error({ replayId: row.id, guid, errClass: errClass(err), detail: detail(err) }, "seazn replays: a failed copy could not be removed — kept on the row; the retry removes it first");
          return "done";
        }
        await forgetCopy(row, guid);
        return "done";
      }
      case "lost":
        if (!(await write(row, "encoding", { state: "found", state_at: run.now, bunny_video_id: null, next_attempt_at: run.now }))) return dropped(row, "encoding");
        moved(run, row, { state: "found", bunnyVideoId: null });
        log.warn({ replayId: row.id, guid }, "seazn replays: the host no longer holds the copy — the move starts again");
        return "done";
    }
  },
  delete_cf: async (run, row) => {
    if (!run.canCall()) return defer(run, row);
    let res;
    try {
      // The claimed row's OWN id (checked at discovery, C6); the gate passed in nextReplayStep. Never a listing.
      res = await run.deps.ingest.deleteVideo(row.cfVideoId, TIMED);
    } catch (err) {
      return failure(run, row, "delete_cf", err);
    }
    if (res === "in_progress") {
      await write(row, "playable", { next_attempt_at: run.now });
      return "done";
    }
    if (await write(row, "playable", { cf_deleted_at: run.now })) run.out.moved++;
    return "done";
  },
  retry: async (run, row) => {
    if (row.bunnyVideoId !== null) {
      // A copy that failed its check and whose remove failed then (re-review N2): removed before the move starts again, so the
      // row never leaves `failed` still holding it.
      if (!run.canCall()) return defer(run, row);
      try {
        await run.deps.replay.remove(row.bunnyVideoId);
      } catch (err) {
        return failure(run, row, "remove_failed_copy", err);
      }
      if (!(await forgetCopy(row, row.bunnyVideoId))) return dropped(row, "failed");
    }
    if (!(await write(row, "failed", { state: "found", state_at: run.now, next_attempt_at: run.now }))) return dropped(row, "failed");
    moved(run, row, { state: "found" });
    return "again";
  },
  cleanup: async (run, row, step) => {
    if (!run.canCall()) return defer(run, row);
    if (row.bunnyVideoId !== null) {
      try {
        await run.deps.replay.remove(row.bunnyVideoId);
      } catch (err) {
        return failure(run, row, "cleanup", err);
      }
      if (!(await write(row, "deleted", { bunny_video_id: null }))) return dropped(row, "deleted");
      row.bunnyVideoId = null;
    }
    if (step.cf === "wait") {
      await write(row, "deleted", { next_attempt_at: step.until });
      return "done";
    }
    if (step.cf === "delete") {
      let res;
      try {
        res = await run.deps.ingest.deleteVideo(row.cfVideoId, TIMED);
      } catch (err) {
        return failure(run, row, "cleanup_cf", err);
      }
      if (res === "in_progress") {
        await write(row, "deleted", { next_attempt_at: run.now });
        return "done";
      }
      await write(row, "deleted", { cf_deleted_at: run.now });
    }
    if (await write(row, "deleted", { bunny_cleaned_at: run.now })) run.out.moved++;
    return "done";
  },
  wait: async (run, row, step) => {
    await write(row, row.state, { next_attempt_at: step.until });
    return "done";
  },
  settled: async () => "done",
  give_up: async (run, row) => {
    if (row.bunnyVideoId !== null) {
      // Task 31b: a failed row still holding a copy (one whose removal failed, or a row parked mid-move) has it removed BEFORE it is
      // parked: parked, nothing would ever remove it. No final replay read is owed: a failed copy was never served (seazn-cost.ts's
      // header). A removal that fails keeps the copy on the row and backs off (`replayFailureOutcome`), never parks it.
      if (!run.canCall()) return defer(run, row);
      try {
        await run.deps.replay.remove(row.bunnyVideoId);
      } catch (err) {
        return failure(run, row, "remove_parked_copy", err);
      }
      if (!(await forgetCopy(row, row.bunnyVideoId))) return dropped(row, "failed");
    }
    log.warn({ replayId: row.id, videoId: row.cfVideoId, attempts: row.attempts }, "seazn replays: a move still failing past the Cloudflare copy's life — given up");
    await write(row, "failed", { next_attempt_at: REPLAY_PARKED_AT });
    return "done";
  },
  refuse: async (run, row, step) => {
    log.error({ replayId: row.id, state: row.state, reason: step.reason }, "seazn replays: a row in a shape nothing writes — refused, never guessed");
    return failure(run, row, `refuse:${step.reason}`);
  },
};

async function stepRow(run: Run, row: Claimed): Promise<void> {
  for (let n = 0; n < MAX_STEPS_PER_ROW; n++) {
    const step = nextReplayStep(row, run.now);
    const handler = STEPS[step.kind] as Handler<typeof step.kind>;
    if ((await handler(run, row, step as never)) === "done") return;
  }
  // Still moving after its steps: released to the next firing rather than held for the lease.
  await write(row, row.state, { next_attempt_at: run.now });
}

export async function moveSeaznRecordings(deps: SeaznReplayDeps, opts: SeaznReplayOpts): Promise<SeaznReplayResult> {
  const orgIds = checkOpts(opts);
  const wallClock = opts.wallClock ?? Date.now;
  const started = wallClock();
  const run: Run = { deps, now: opts.now, out: zero(), canCall: () => opts.budgetMs - (wallClock() - started) >= SEAZN_PASS_CALL_FLOOR_MS };
  if (!run.canCall()) return run.out;   // no slice: nothing claimed, so nothing waits out a lease
  const leaseUntil = new Date(opts.now.getTime() + SEAZN_CLAIM_LEASE_SECONDS * 1000);
  const claimed = (await replayClaimQuery(sql, { now: opts.now, leaseUntil, limit: SEAZN_REPLAY_CLAIM_BATCH, orgIds })).map(claimedOf)
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.id.localeCompare(b.id));
  for (const row of claimed) {
    try {
      await stepRow(run, row);
    } catch (err) {
      // A database fault mid-row: counted, and the row comes back once its lease runs out.
      run.out.failed++;
      log.error({ replayId: row.id, errClass: errClass(err) }, "seazn replays: a row's step threw — it comes back after its lease");
    }
  }
  if (claimed.length > 0) log.info({ ...run.out, claimed: claimed.length, scoped: orgIds !== undefined }, "seazn replays: move");
  return run.out;
}
