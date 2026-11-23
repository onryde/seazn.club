import "server-only";
// server/usecases/seazn-cost.ts — what Seazn-hosted video costs to deliver, measured once a day, and a deleted organisation's
// replays removed (Seazn-hosted video, Phase 3, Task 31; behind SEAZN_HOSTED_COST, which the daily sweep reads: relay-sweep.ts 7e).
//
//   measureSeaznDelivery(deps, now, scope)
//       Per Seazn session, two halves, each written to `fixture_video_delivery` (V546) on its own:
//       LIVE   — a session that ENDED within SEAZN_LIVE_MEASURE_DAYS: the minutes Cloudflare reports viewed for its programme input
//                uid AND every recording (video uid) of it, SUMMED (controller ruling 1, 2026-11-23). The input's minutes are the
//                live audience; a recording's are the interim replay's, played before the replay host's copy took over. If the two
//                ever prove to count the same viewing twice, the T30 report's fallback is max(input, sum of videos) per day
//                (task-30-report.md, "live minutes" note) — not done here: unmeasured, and only the sum is stored.
//       REPLAY — every replay row not deleted that names a copy on the replay host: the host's watch time of each copy, summed per
//                session. A copy the host no longer holds answers null — gone: counted, adds nothing, and NEVER writes 0 over what
//                is stored (ruling 2c: the host forgets a removed video's statistics with it).
//       Each half reads `delivery-window.ts`'s DAILY window: from the day after its `*_measured_through` (or the session's first
//       UTC day) through YESTERDAY, UTC, and stores yesterday as measured. A second run the same day reads nothing; the next day's
//       reads exactly one new day (ruling 3). The write ADDS, compare-and-set on the `*_measured_through` it read, so two passes
//       racing on one session cannot both add the same days: the loser writes nothing and is warned. A half that fails — a
//       read throws, the write throws — writes NOTHING for that session (a replay half is all of its copies or none), so the next
//       run reads its whole window again: nothing is lost, nothing is counted twice. Every failure is counted and logged; the
//       pass reports ONCE (route relay.sweep.seazn_measure), never once per session.
//
//   purgeDeletedOrgReplays(deps, now, scope)
//       Every replay of an organisation whose `organizations.deleted_at` is more than SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS before
//       `now`, not yet deleted, is deleted as the organiser's delete does (organiser-replays.ts): one short transaction takes the
//       row FOR UPDATE and writes `deleted`, reason `org_deleted`, no `deleted_by`, the move's cleanup due now (it deletes the
//       Cloudflare copy and retries a removal that fails here). After the commit, the copy's minutes are read one last time
//       (`measureReplayBeforeRemoval`, ruling 2a), THEN the copy is removed and the row forgets it.
//
//   measureReplayBeforeRemoval(host, copy, now)
//       The last read of a copy about to be removed, from the day after the session's `replay_measured_through` up to NOW (today's
//       partial day included: nothing can be read after). Called by the purge and by the organiser's delete (ruling 2b); never
//       throws and never holds a delete back. It ADDS without moving `replay_measured_through` — the copy leaves the daily read
//       with its row's `deleted`, and the session's other copies are still owed those days. Off unless SEAZN_HOSTED_COST.
//       NOT called by the move's cleanup step (seazn-replays.ts), deliberately: a deleted row's copy reached there was either
//       measured by the delete that deleted it (this function, before its own removal attempt) or failed its check and was never
//       playable — measuring it again would count the same days twice.
//
//   seaznVideoForOrg(orgId)
//       The staff view (/admin/orgs/[id]): the org's last SEAZN_STAFF_SESSIONS_LIMIT Seazn sessions, what was measured, and each
//       replay part's state. Read only.
//
// The minutes are ESTIMATES, never an invoice: Cloudflare's adaptive groups are sampled, and the replay host's watch time read about
// a third below the time played in the Task 20 probe (WATCH_TIME_CHART_SECONDS_PER_UNIT). Stored as measured, never "corrected".
import { sql } from "@/lib/db";
import { scrubScoreUrl } from "@/lib/scrub-score-url";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { SEAZN_LIVE_MEASURE_DAYS, SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS, seaznHostedCost } from "@/server/relay/config";
import { CF_ANALYTICS_MAX_WINDOW_DAYS, type LiveMinutesReader } from "@/server/video/cf-analytics";
import { dailyWindow, dayOf, dayText, endOfDay, finalWindow, utcDay } from "@/server/video/domain/delivery-window";
import type { ReplayHost } from "@/server/video/replay-ports";

const DAY_MS = 86_400_000;
/** The staff table's length (the brief: the last 50 Seazn sessions). */
export const SEAZN_STAFF_SESSIONS_LIMIT = 50;
/** The most session ids one pass report names; the count is always whole. */
const REPORTED_IDS_MAX = 10;

export interface SeaznCostDeps {
  liveMinutes: LiveMinutesReader;
  replay: ReplayHost;
}
/** TEST-ONLY scope, as the sweep's: omitted, every organisation. */
export interface SeaznCostScope { orgIds?: readonly string[] }
export interface SeaznMeasureResult {
  /** Sessions with at least one half written this run. */
  measured: number;
  /** Sessions with at least one half that failed (nothing written for that half; the next run reads its whole window). */
  failed: number;
  /** Replay copies the host no longer holds (read null: nothing added). */
  gone: number;
}
export interface SeaznPurgeResult {
  /** Replay rows deleted (`org_deleted`) this run. */
  purged: number;
  /** Rows whose delete or copy removal failed (a removal is retried by the move's cleanup step). */
  failed: number;
}

/** A scope handed an EMPTY list: `org_id in ()` is not a query, and read as "no filter" it would act on every organisation. */
export class SeaznCostScopeEmpty extends Error {
  override readonly name = "SeaznCostScopeEmpty";
  constructor() {
    super("seazn cost: orgIds is empty — omit it for every organisation, or name at least one");
  }
}
const orgIdsOf = (scope: SeaznCostScope): string[] | undefined => {
  if (scope.orgIds === undefined) return undefined;
  if (scope.orgIds.length === 0) throw new SeaznCostScopeEmpty();
  return [...scope.orgIds];
};

/** Whether SEAZN_HOSTED_COST is on. `seaznHostedCost` throws on a value other than true/false; a typo must never stop the sweep or
 *  an organiser's delete, so a malformed value reads as OFF, with a warning (relay-sweep.ts's `replayAlertArmed` rule). */
export function seaznCostArmed(): boolean {
  try {
    return seaznHostedCost();
  } catch (err) {
    log.warn({ err: String(err) }, "seazn cost: SEAZN_HOSTED_COST is not true/false — measuring and purging are off");
    return false;
  }
}

/** A provider's or database's error, for a log line or a report: through the shared scrubber, and short. */
const detail = (err: unknown) => scrubScoreUrl(err instanceof Error ? err.message : String(err)).slice(0, 200);
const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);

type Half = "live" | "replay";
const COLUMNS = {
  live: { minutes: "live_minutes", through: "live_measured_through" },
  replay: { minutes: "replay_minutes", through: "replay_measured_through" },
} as const;

/** ADDS `minutes` to one half of a session's delivery row and stores `through` as its last day measured — only while that half's
 *  `*_measured_through` still reads `readThrough` (compare-and-set). False: another writer moved it first; nothing was written. */
async function addMinutes(half: Half, a: { sessionId: string; orgId: string; minutes: number; readThrough: string | null; through: string | null }): Promise<boolean> {
  if (!Number.isFinite(a.minutes) || a.minutes < 0) throw new RangeError(`seazn cost: ${half} minutes ${a.minutes} for session ${a.sessionId} is not a count`);
  const c = COLUMNS[half];
  const rows = await sql`
    insert into fixture_video_delivery as d (session_id, org_id, ${sql(c.minutes)}, ${sql(c.through)})
    values (${a.sessionId}, ${a.orgId}, ${a.minutes}, ${a.through}::date)
    on conflict (session_id) do update
       set ${sql(c.minutes)} = d.${sql(c.minutes)} + excluded.${sql(c.minutes)},
           ${sql(c.through)} = excluded.${sql(c.through)},
           updated_at = now()
     where d.${sql(c.through)} is not distinct from ${a.readThrough}::date
    returning d.session_id`;
  return rows.length === 1;
}

/** The pass's ONE report for every session that failed: a constant message, the count and the first ids in `extra`. */
function reportOnce(route: string, message: string, failures: { sessionId: string; err: unknown }[], extra: Record<string, unknown> = {}): void {
  if (failures.length === 0) return;
  captureError(new Error(message), {
    route,
    extra: { ...extra, failed: failures.length, sessionIds: failures.slice(0, REPORTED_IDS_MAX).map((f) => f.sessionId), firstError: detail(failures[0]!.err) },
  });
}

export async function measureSeaznDelivery(deps: SeaznCostDeps, now: Date, scope: SeaznCostScope = {}): Promise<SeaznMeasureResult> {
  const orgIds = orgIdsOf(scope);
  const yesterday = dayText(new Date(utcDay(now).getTime() - DAY_MS));
  const liveSince = new Date(now.getTime() - SEAZN_LIVE_MEASURE_DAYS * DAY_MS);
  // As the sweep: a session created after `now` is not this pass's business (relay-sweep.ts m3).
  const inScope = sql`and s.created_at <= ${now} ${orgIds ? sql`and s.org_id in ${sql(orgIds)}` : sql``}`;
  const written = new Set<string>();
  const failures: { sessionId: string; half: Half; err: unknown }[] = [];
  let gone = 0;

  // LIVE. The uids: the session's own input uid, its programme input's (the same, on a composed session: kept for a session whose
  // row was never stamped), every recording the video-facts step stamped on it, every one the Seazn lock pass locked, and every one
  // a replay row was made from — de-duplicated.
  const live = await sql<{ id: string; org_id: string; created_at: Date; through: string | null; uids: string[] }[]>`
    select s.id, s.org_id, s.created_at, d.live_measured_through::text as through,
           array(
             select distinct u from unnest(
               array[s.ingest_input_uid]
               || coalesce(s.video_uids, '{}'::text[])
               || array(select i.ingest_input_id from fixture_stream_inputs i where i.session_id = s.id and i.role = 'programme')
               || array(select l.cf_video_id from seazn_locked_videos l join fixture_stream_inputs i on i.id = l.input_row_id
                         where i.session_id = s.id and i.role = 'programme')
               || array(select r.cf_video_id from fixture_video_replays r where r.session_id = s.id)
             ) as u where u is not null order by u
           ) as uids
      from fixture_stream_sessions s
      left join fixture_video_delivery d on d.session_id = s.id
     where s.destination_kind = 'seazn' and s.ended_at is not null and s.ended_at >= ${liveSince}
       and (d.live_measured_through is null or d.live_measured_through < ${yesterday}::date)
       ${inScope}
     order by s.created_at, s.id`;
  for (const s of live) {
    try {
      const w = dailyWindow({ firstAt: new Date(s.created_at), measuredThrough: dayOf(s.through), now, maxDays: CF_ANALYTICS_MAX_WINDOW_DAYS });
      if (w === null) continue;   // the selection admits only a session owed a day; kept for a clock that moved under it
      if (w.clamped) log.warn({ sid: s.id, from: dayText(w.from), through: dayText(w.through) }, "seazn cost: a live window reached past Cloudflare's 32 dates — the earlier days are not read");
      const byUid = await deps.liveMinutes(s.uids, w.from, w.through);
      const minutes = Object.values(byUid).reduce((sum, m) => sum + m, 0);
      if (await addMinutes("live", { sessionId: s.id, orgId: s.org_id, minutes, readThrough: s.through, through: dayText(w.through) })) written.add(s.id);
      else log.warn({ sid: s.id, half: "live" }, "seazn cost: another pass measured this session first — nothing added");
    } catch (err) {
      failures.push({ sessionId: s.id, half: "live", err });
      log.error({ sid: s.id, half: "live", errClass: errClass(err), detail: detail(err) }, "seazn cost: a live measurement failed — nothing written; the next pass reads its whole window");
    }
  }

  // REPLAY. Every copy of a row not deleted; a session whose copies are all deleted is no longer read.
  const replay = await sql<{ id: string; org_id: string; created_at: Date; through: string | null; copies: string[] }[]>`
    select s.id, s.org_id, s.created_at, d.replay_measured_through::text as through,
           array_agg(r.bunny_video_id order by r.part_no, r.id) as copies
      from fixture_video_replays r
      join fixture_stream_sessions s on s.id = r.session_id
      left join fixture_video_delivery d on d.session_id = s.id
     where r.state <> 'deleted' and r.bunny_video_id is not null
       and (d.replay_measured_through is null or d.replay_measured_through < ${yesterday}::date)
       ${inScope}
     group by s.id, s.org_id, s.created_at, d.replay_measured_through
     order by s.created_at, s.id`;
  for (const s of replay) {
    try {
      const w = dailyWindow({ firstAt: new Date(s.created_at), measuredThrough: dayOf(s.through), now });
      if (w === null) continue;
      let minutes = 0;
      let goneHere = 0;
      for (const copy of s.copies) {
        const m = await deps.replay.watchMinutes(copy, w.from, endOfDay(w.through));
        if (m === null) goneHere++;   // gone: nothing more can be read of it — never a 0 written over what is stored
        else minutes += m;
      }
      if (goneHere > 0) log.info({ sid: s.id, gone: goneHere, copies: s.copies.length }, "seazn cost: a replay copy is gone from the host — nothing read for it");
      gone += goneHere;
      if (await addMinutes("replay", { sessionId: s.id, orgId: s.org_id, minutes, readThrough: s.through, through: dayText(w.through) })) written.add(s.id);
      else log.warn({ sid: s.id, half: "replay" }, "seazn cost: another pass measured this session first — nothing added");
    } catch (err) {
      failures.push({ sessionId: s.id, half: "replay", err });
      log.error({ sid: s.id, half: "replay", errClass: errClass(err), detail: detail(err) }, "seazn cost: a replay measurement failed — nothing written; the next pass reads its whole window");
    }
  }

  const failedSessions = new Set(failures.map((f) => f.sessionId));
  reportOnce("relay.sweep.seazn_measure", "relay sweep: Seazn delivery could not be measured for some sessions — nothing written for them; the next pass reads their whole window",
    [...failedSessions].map((sessionId) => ({ sessionId, err: failures.find((f) => f.sessionId === sessionId)!.err })),
    { halves: failures.map((f) => f.half).slice(0, REPORTED_IDS_MAX) });
  return { measured: written.size, failed: failedSessions.size, gone };
}

export type FinalMeasure = "off" | "measured" | "nothing_left" | "gone" | "raced" | "failed";

/** The last read of a copy about to be removed (ruling 2a/2b): ADDED to the session's replay minutes, `replay_measured_through`
 *  left where it is. Never throws: a failure is logged and answered `failed`, and the removal goes ahead — a removed copy cannot be
 *  read again, and holding the removal back for a statistic would keep a deleted video playable. */
export async function measureReplayBeforeRemoval(
  host: () => ReplayHost, a: { sessionId: string; orgId: string; copy: string }, now: Date,
): Promise<FinalMeasure> {
  if (!seaznCostArmed()) return "off";
  try {
    const [s] = await sql<{ created_at: Date; through: string | null }[]>`
      select s.created_at, d.replay_measured_through::text as through
        from fixture_stream_sessions s left join fixture_video_delivery d on d.session_id = s.id
       where s.id = ${a.sessionId}`;
    if (!s) throw new Error(`seazn cost: no session ${a.sessionId} for the copy being removed`);
    const w = finalWindow({ firstAt: new Date(s.created_at), measuredThrough: dayOf(s.through), now });
    if (w === null) return "nothing_left";
    const minutes = await host().watchMinutes(a.copy, w.from, w.to);
    if (minutes === null) {
      log.info({ sid: a.sessionId, copy: a.copy }, "seazn cost: the copy being removed is already gone from the host — nothing read");
      return "gone";
    }
    if (await addMinutes("replay", { sessionId: a.sessionId, orgId: a.orgId, minutes, readThrough: s.through, through: s.through })) return "measured";
    log.warn({ sid: a.sessionId, copy: a.copy }, "seazn cost: the daily pass measured this session while its copy was being removed — the copy's last read is not added");
    return "raced";
  } catch (err) {
    log.error({ sid: a.sessionId, copy: a.copy, errClass: errClass(err), detail: detail(err) }, "seazn cost: the last read of a copy before its removal failed — its minutes since the last pass are lost; the removal goes ahead");
    return "failed";
  }
}

export async function purgeDeletedOrgReplays(deps: Pick<SeaznCostDeps, "replay">, now: Date, scope: SeaznCostScope = {}): Promise<SeaznPurgeResult> {
  const orgIds = orgIdsOf(scope);
  const cutoff = new Date(now.getTime() - SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS * DAY_MS);
  const due = await sql<{ id: string; org_id: string; session_id: string }[]>`
    select r.id, r.org_id, r.session_id
      from fixture_video_replays r
      join organizations o on o.id = r.org_id
     where o.deleted_at is not null and o.deleted_at < ${cutoff} and r.state <> 'deleted'
       ${orgIds ? sql`and r.org_id in ${sql(orgIds)}` : sql``}
     order by r.org_id, r.session_id, r.part_no, r.id`;
  let purged = 0;
  const failures: { sessionId: string; err: unknown }[] = [];
  const unmeasured: string[] = [];
  for (const row of due) {
    let copy: string | null | undefined;
    try {
      copy = (await sql.begin(async (tx) => {
        const [cur] = await tx<{ state: string; bunny_video_id: string | null }[]>`
          select state, bunny_video_id from fixture_video_replays where id = ${row.id} for update`;
        if (!cur || cur.state === "deleted") return undefined;   // deleted since the selection (the organiser, a second pass)
        await tx`
          update fixture_video_replays
             set state = 'deleted', state_at = ${now}, deleted_at = coalesce(deleted_at, ${now}), deleted_reason = 'org_deleted',
                 deleted_by = null, next_attempt_at = ${now}, attempts = 0
           where id = ${row.id}`;
        return cur.bunny_video_id;
      })) as string | null | undefined;
      if (copy === undefined) continue;
      purged++;
    } catch (err) {
      failures.push({ sessionId: row.session_id, err });
      log.error({ replayId: row.id, errClass: errClass(err), detail: detail(err) }, "seazn cost: a deleted org's replay could not be deleted — the next pass retries it");
      continue;
    }
    if (copy === null) continue;
    // The minutes FIRST: once removed, the host answers nothing for the copy (ruling 2a).
    if ((await measureReplayBeforeRemoval(() => deps.replay, { sessionId: row.session_id, orgId: row.org_id, copy }, now)) === "failed") unmeasured.push(row.id);
    try {
      await deps.replay.remove(copy);
    } catch (err) {
      failures.push({ sessionId: row.session_id, err });
      log.error({ replayId: row.id, copy, errClass: errClass(err), detail: detail(err) }, "seazn cost: a deleted org's replay copy could not be removed — the move's cleanup retries it");
      continue;
    }
    try {
      await sql`update fixture_video_replays set bunny_video_id = null where id = ${row.id} and state = 'deleted' and bunny_video_id = ${copy}`;
    } catch (err) {
      // The copy is gone; the row still names it, so the cleanup asks the host once more and is told `absent`.
      log.error({ replayId: row.id, errClass: errClass(err) }, "seazn cost: a removed copy could not be forgotten — the move's cleanup reads it absent");
    }
  }
  // ONE report for the pass: rows it could not delete or copies it could not remove (retried), and copies removed without their
  // last read (lost minutes, logged each).
  if (failures.length > 0 || unmeasured.length > 0) {
    captureError(new Error("relay sweep: a deleted organisation's Seazn replays were not all removed, or not all measured first"), {
      route: "relay.sweep.seazn_purge",
      extra: {
        failed: failures.length, sessionIds: failures.slice(0, REPORTED_IDS_MAX).map((f) => f.sessionId),
        firstError: failures[0] ? detail(failures[0].err) : null,
        unmeasured: unmeasured.length, unmeasuredReplayIds: unmeasured.slice(0, REPORTED_IDS_MAX),
      },
    });
  }
  return { purged, failed: failures.length };
}

export interface SeaznVideoPart { partNo: number; state: string; deletedReason: string | null }
export interface SeaznVideoSession {
  sessionId: string;
  /** "Home v Away", or null for a session with no fixture or no entrants. */
  fixture: string | null;
  endedAt: Date | null;
  /** As stored (numeric(12,1), text); null: not measured yet. */
  liveMinutes: string | null;
  replayMinutes: string | null;
  liveThrough: string | null;
  replayThrough: string | null;
  parts: SeaznVideoPart[];
}

/** The staff view's rows: the org's last SEAZN_STAFF_SESSIONS_LIMIT Seazn sessions, newest first. */
export async function seaznVideoForOrg(orgId: string): Promise<SeaznVideoSession[]> {
  const rows = await sql<{
    id: string; home: string | null; away: string | null; ended_at: Date | null;
    live_minutes: string | null; replay_minutes: string | null; live_through: string | null; replay_through: string | null;
    parts: { partNo: number; state: string; deletedReason: string | null }[];
  }[]>`
    select s.id, he.display_name as home, ae.display_name as away, s.ended_at,
           d.live_minutes::text as live_minutes, d.replay_minutes::text as replay_minutes,
           d.live_measured_through::text as live_through, d.replay_measured_through::text as replay_through,
           coalesce((select json_agg(json_build_object('partNo', r.part_no, 'state', r.state, 'deletedReason', r.deleted_reason) order by r.part_no, r.id)
                       from fixture_video_replays r where r.session_id = s.id), '[]'::json) as parts
      from fixture_stream_sessions s
      left join fixtures f on f.id = s.fixture_id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
      left join fixture_video_delivery d on d.session_id = s.id
     where s.org_id = ${orgId} and s.destination_kind = 'seazn'
     order by s.created_at desc, s.id
     limit ${SEAZN_STAFF_SESSIONS_LIMIT}`;
  return rows.map((r) => ({
    sessionId: r.id,
    fixture: r.home !== null && r.away !== null ? `${r.home} v ${r.away}` : (r.home ?? r.away),
    endedAt: r.ended_at === null ? null : new Date(r.ended_at),
    liveMinutes: r.live_minutes, replayMinutes: r.replay_minutes, liveThrough: r.live_through, replayThrough: r.replay_through,
    parts: r.parts,
  }));
}
