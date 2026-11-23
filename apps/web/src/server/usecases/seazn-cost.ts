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
//       run reads its whole window again: nothing is lost, nothing is counted twice. So does a replay half one of whose parts was
//       deleted while it was read: that delete's last read took the copy's days (review m1). Every failure is counted and logged; the
//       pass reports ONCE (route relay.sweep.seazn_measure), never once per session.
//       The scale guard (Task 31b, T31 review m11): the live half asks Cloudflare once per WINDOW, not once per session — sessions
//       whose windows are the same share one `uid_in` query of at most SEAZN_LIVE_MEASURE_UIDS_PER_QUERY uids (`batchByWindow`), and
//       each stores only its own uids' sum. A shared query that fails is asked again per session, so one session's refusal holds back
//       only that session. After SEAZN_LIVE_MEASURE_BREAKER_FAILURES failed queries IN A ROW the live half stops for the pass: the
//       sessions not asked are counted `skipped` (warned once, named in the report) and read whole the next day.
//
//   purgeDeletedOrgReplays(deps, now, scope)
//       Every replay of an organisation whose `organizations.deleted_at` is more than SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS before
//       `now`, not yet deleted, is deleted as the organiser's delete does (organiser-replays.ts): one short transaction takes the
//       row FOR UPDATE and writes `deleted`, reason `org_deleted`, no `deleted_by`, the move's cleanup due one claim lease after
//       that commit (`cleanupDueAfterDelete` from the later of `now` and the wall clock — `now` is the sweep's start: the cleanup
//       deletes the Cloudflare copy and retries a removal that fails here, never ahead of the last read). After the commit, the
//       copy's minutes are read one last time (`measureReplayBeforeRemoval`, ruling 2a), THEN the copy is removed and the row
//       forgets it.
//
//   purgeFixturelessReplays(deps, now, scope)
//       Task 31b (T23 review G1): every replay not yet deleted whose fixture was deleted (`fixture_id` SET NULL, V542) — on no page,
//       still stored and billed — is deleted the same way, reason `fixture_deleted` (V551), its copy read one last time first. Its
//       one report is route relay.sweep.seazn_fixtureless.
//
//   measureReplayBeforeRemoval(host, copy, now)
//       The last read of a copy about to be removed, from the day after the session's `replay_measured_through` up to NOW (today's
//       partial day included: nothing can be read after). Called by both purges and by the organiser's delete (ruling 2b); never
//       throws and never holds a delete back. It ADDS without moving `replay_measured_through` — the copy leaves the daily read
//       with its row's `deleted`, and the session's other copies are still owed those days. Off unless SEAZN_HOSTED_COST.
//       NOT called by the move's cleanup step (seazn-replays.ts), deliberately: a deleted row's copy reached there was either
//       measured by the delete that deleted it (this function, before its own removal attempt) or failed its check and was never
//       playable — measuring it again would count the same days twice. Nor by the removals of copies that were never served: a
//       copy that failed its check (seazn-replays.ts, seazn-replay-webhook.ts), a failed row's copy removed before it is parked at
//       day 30 (seazn-replays.ts `give_up`, Task 31b), and a STRAY copy whose fetch answer was lost or whose row was deleted while it
//       was being made (seazn-replays.ts, seazn-replay-webhook.ts) — nobody could have watched them.
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
import {
  SEAZN_CLAIM_LEASE_SECONDS, SEAZN_LIVE_MEASURE_BREAKER_FAILURES, SEAZN_LIVE_MEASURE_DAYS, SEAZN_LIVE_MEASURE_UIDS_PER_QUERY,
  SEAZN_ORG_DELETED_REPLAY_GRACE_DAYS, seaznHostedCost,
} from "@/server/relay/config";
import { CF_ANALYTICS_MAX_WINDOW_DAYS, type LiveMinutesReader } from "@/server/video/cf-analytics";
import { batchByWindow, dailyWindow, dayOf, dayText, endOfDay, finalWindow, utcDay } from "@/server/video/domain/delivery-window";
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
  /** Sessions whose live half was not asked: the pass stopped after SEAZN_LIVE_MEASURE_BREAKER_FAILURES failed queries in a row
   *  (Task 31b). Nothing written for them; the next run reads their whole window. */
  skipped: number;
}
export interface SeaznPurgeResult {
  /** Replay rows deleted this run (`org_deleted`, or `fixture_deleted` by the fixtureless pass). */
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
 *  `*_measured_through` still reads `readThrough` (compare-and-set), and, given `unlessDeleted` (the replay rows whose copies were
 *  read), only while none of those rows has gone `deleted` since (review m1: a delete's last read already ADDED that copy's days,
 *  without moving the day, so the daily sum holding the same days must not land on top of it). Ids, not copies: a removed copy's
 *  row forgets its copy. False: nothing was written. */
async function addMinutes(half: Half, a: {
  sessionId: string; orgId: string; minutes: number; readThrough: string | null; through: string | null; unlessDeleted?: readonly string[];
}): Promise<boolean> {
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
       ${a.unlessDeleted ? sql`and not exists (select 1 from fixture_video_replays r where r.id = any(${a.unlessDeleted as string[]}::uuid[]) and r.state = 'deleted')` : sql``}
    returning d.session_id`;
  return rows.length === 1;
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
  const goneSessions: string[] = [];

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
  // Each session's window first (a failure here is that session's), then one query per batch of sessions sharing a window.
  type LiveRow = (typeof live)[number];
  const liveFailed = (s: LiveRow, err: unknown) => {
    failures.push({ sessionId: s.id, half: "live", err });
    log.error({ sid: s.id, half: "live", errClass: errClass(err), detail: detail(err) }, "seazn cost: a live measurement failed — nothing written; the next pass reads its whole window");
  };
  const planned: { uids: string[]; window: { from: Date; through: Date }; item: LiveRow }[] = [];
  for (const s of live) {
    try {
      const w = dailyWindow({ firstAt: new Date(s.created_at), measuredThrough: dayOf(s.through), now, maxDays: CF_ANALYTICS_MAX_WINDOW_DAYS });
      if (w === null) continue;   // the selection admits only a session owed a day; kept for a clock that moved under it
      if (w.clamped) log.warn({ sid: s.id, from: dayText(w.from), through: dayText(w.through) }, "seazn cost: a live window reached past Cloudflare's 32 dates — the earlier days are not read");
      planned.push({ uids: s.uids, window: w, item: s });
    } catch (err) {
      liveFailed(s, err);
    }
  }
  let failedInARow = 0;
  let skipped = 0;
  /** One Cloudflare query, counted toward the breaker: an answer resets the count, a failure adds one. */
  const ask = async (uids: string[], w: { from: Date; through: Date }): Promise<{ ok: true; byUid: Record<string, number> } | { ok: false; err: unknown }> => {
    try {
      const byUid = await deps.liveMinutes(uids, w.from, w.through);
      failedInARow = 0;
      return { ok: true, byUid };
    } catch (err) {
      failedInARow++;
      return { ok: false, err };
    }
  };
  const stopped = () => failedInARow >= SEAZN_LIVE_MEASURE_BREAKER_FAILURES;
  /** Stores one session's live half from an answer that named its uids. */
  const store = async (s: LiveRow, byUid: Record<string, number>, w: { through: Date }) => {
    try {
      let minutes = 0;
      for (const u of s.uids) {
        // Cloudflare's reader answers every uid it was asked (0 for none); a missing one would read as 0 and store the day.
        if (!Object.hasOwn(byUid, u)) throw new Error(`seazn cost: the live answer names no minutes for uid ${u}`);
        minutes += byUid[u]!;
      }
      if (await addMinutes("live", { sessionId: s.id, orgId: s.org_id, minutes, readThrough: s.through, through: dayText(w.through) })) written.add(s.id);
      else log.warn({ sid: s.id, half: "live" }, "seazn cost: another pass measured this session first — nothing added");
    } catch (err) {
      liveFailed(s, err);
    }
  };
  const skippedSessions: string[] = [];
  const skip = (s: LiveRow) => {
    if (skipped === 0) log.warn({ failedInARow, limit: SEAZN_LIVE_MEASURE_BREAKER_FAILURES }, "seazn cost: Cloudflare failed the live read too many times in a row — the rest of the live half is skipped this pass; it is read whole next pass");
    skipped++;
    skippedSessions.push(s.id);
  };
  for (const b of batchByWindow(planned, SEAZN_LIVE_MEASURE_UIDS_PER_QUERY)) {
    if (stopped()) { b.items.forEach(skip); continue; }
    const answer = await ask(b.uids, b);
    if (answer.ok) {
      for (const s of b.items) await store(s, answer.byUid, b);
      continue;
    }
    if (b.items.length === 1) { liveFailed(b.items[0]!, answer.err); continue; }
    // A shared query failed: each session alone, so one session's refusal holds back only that session.
    for (const s of b.items) {
      if (stopped()) { skip(s); continue; }
      const own = await ask(s.uids, b);
      if (own.ok) await store(s, own.byUid, b);
      else liveFailed(s, own.err);
    }
  }

  // REPLAY. Every copy of a row not deleted; a session whose copies are all deleted is no longer read. A part deleted while its
  // session is being read sends the whole half back (`unlessDeleted`): its delete read that copy's days; the next pass reads the
  // surviving copies over the whole window again.
  const replay = await sql<{ id: string; org_id: string; created_at: Date; through: string | null; copies: string[]; replay_ids: string[] }[]>`
    select s.id, s.org_id, s.created_at, d.replay_measured_through::text as through,
           array_agg(r.bunny_video_id order by r.part_no, r.id) as copies, array_agg(r.id order by r.part_no, r.id) as replay_ids
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
      for (const [i, copy] of s.copies.entries()) {
        const m = await deps.replay.watchMinutes(copy, w.from, endOfDay(w.through));
        if (m !== null) { minutes += m; continue; }
        // Gone: nothing more can be read of it — never a 0 written over what is stored. Unless its row was DELETED since the
        // selection (review R2): that delete removed it and took its last read, and the write below is refused for it.
        const [row] = await sql<{ state: string }[]>`select state from fixture_video_replays where id = ${s.replay_ids[i]!}`;
        if (row?.state !== "deleted") goneHere++;
      }
      // Review m3: a row NOT deleted whose copy the host no longer holds is a broken public replay, and this pass is the only daily
      // reader that would notice — warned here and named in the pass's one report, every day it stays so.
      if (goneHere > 0) {
        log.warn({ sid: s.id, gone: goneHere, copies: s.copies.length }, "seazn cost: a replay copy is gone from the host while its row is not deleted — nothing read for it");
        goneSessions.push(s.id);
      }
      gone += goneHere;
      if (await addMinutes("replay", { sessionId: s.id, orgId: s.org_id, minutes, readThrough: s.through, through: dayText(w.through), unlessDeleted: s.replay_ids })) written.add(s.id);
      else log.warn({ sid: s.id, half: "replay" }, "seazn cost: another pass measured this session first, or a part was deleted while it was read — nothing added; the next pass reads the window again");
    } catch (err) {
      failures.push({ sessionId: s.id, half: "replay", err });
      log.error({ sid: s.id, half: "replay", errClass: errClass(err), detail: detail(err) }, "seazn cost: a replay measurement failed — nothing written; the next pass reads its whole window");
    }
  }

  const failedSessions = new Set(failures.map((f) => f.sessionId));
  // ONE report for the pass: sessions that failed (nothing written; re-read whole next pass) and copies gone from the host while
  // their rows are not deleted (review m3).
  if (failedSessions.size > 0 || goneSessions.length > 0 || skipped > 0) {
    const first = failures[0];
    captureError(new Error("relay sweep: Seazn delivery was not all measured — failed sessions are read again whole next pass; a gone copy's row is not deleted"), {
      route: "relay.sweep.seazn_measure",
      extra: {
        failed: failedSessions.size, sessionIds: [...failedSessions].slice(0, REPORTED_IDS_MAX), firstError: first ? detail(first.err) : null,
        halves: failures.map((f) => f.half).slice(0, REPORTED_IDS_MAX),
        gone, goneSessionIds: goneSessions.slice(0, REPORTED_IDS_MAX),
        skipped, skippedSessionIds: skippedSessions.slice(0, REPORTED_IDS_MAX),
      },
    });
  }
  return { measured: written.size, failed: failedSessions.size, gone, skipped };
}

export type FinalMeasure = "off" | "measured" | "nothing_left" | "gone" | "raced" | "failed";

/** When the move's cleanup may first take a replay row a delete (the organiser's, or the purge's) has just written: one claim lease
 *  later, as a mover run holds a row it claimed (review m2). Due at once, a mover run could take the row between the delete's commit
 *  and its last read and remove the copy first — the read then answers "gone" and the copy's minutes since the last pass are lost.
 *  The delete reads and removes in well under the lease (each host call gives up after SEAZN_REPLAY_CALL_TIMEOUT_MS); the cleanup
 *  only retries a removal that failed, and its Cloudflare delete waits out `verified_at` + SEAZN_CF_DELETE_DELAY_MINUTES anyway. */
export const cleanupDueAfterDelete = (now: Date): Date => new Date(now.getTime() + SEAZN_CLAIM_LEASE_SECONDS * 1000);

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

/** Why a sweep pass deletes a replay row (V542's CHECK, widened by V551), and what its log lines and its one report say. */
type PurgeReason = "org_deleted" | "fixture_deleted";
const PURGE: Record<PurgeReason, { whose: string; report: string; route: string }> = {
  org_deleted: {
    whose: "a deleted org's replay",
    report: "relay sweep: a deleted organisation's Seazn replays were not all removed, or not all measured first",
    route: "relay.sweep.seazn_purge",
  },
  fixture_deleted: {
    whose: "a deleted fixture's replay",
    report: "relay sweep: a deleted fixture's Seazn replays were not all removed, or not all measured first",
    route: "relay.sweep.seazn_fixtureless",
  },
};

/** The two sweep purges' one body: each due row deleted as the organiser's delete does (one short transaction, FOR UPDATE, `reason`,
 *  no author, the cleanup due one lease after THIS commit), then — after the commit — its copy's last read, then the removal, then the
 *  row forgets the copy. A row deleted since the selection is left as it is. One report for the pass. */
async function deleteAndRemove(
  deps: Pick<SeaznCostDeps, "replay">, now: Date, due: readonly { id: string; org_id: string; session_id: string }[], reason: PurgeReason,
): Promise<SeaznPurgeResult> {
  const lines = PURGE[reason];
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
        // The cleanup's lease runs from THIS commit (review R1): `now` is the sweep's start, and the sweep's earlier steps can take
        // longer than the lease — counted from `now`, the row would be due before its last read.
        const commitAt = new Date(Math.max(now.getTime(), Date.now()));
        await tx`
          update fixture_video_replays
             set state = 'deleted', state_at = ${now}, deleted_at = coalesce(deleted_at, ${now}), deleted_reason = ${reason},
                 deleted_by = null, next_attempt_at = ${cleanupDueAfterDelete(commitAt)}, attempts = 0
           where id = ${row.id}`;
        return cur.bunny_video_id;
      })) as string | null | undefined;
      if (copy === undefined) continue;
      purged++;
    } catch (err) {
      failures.push({ sessionId: row.session_id, err });
      log.error({ replayId: row.id, reason, errClass: errClass(err), detail: detail(err) }, `seazn cost: ${lines.whose} could not be deleted — the next pass retries it`);
      continue;
    }
    if (copy === null) continue;
    // The minutes FIRST: once removed, the host answers nothing for the copy (ruling 2a).
    if ((await measureReplayBeforeRemoval(() => deps.replay, { sessionId: row.session_id, orgId: row.org_id, copy }, now)) === "failed") unmeasured.push(row.id);
    try {
      await deps.replay.remove(copy);
    } catch (err) {
      failures.push({ sessionId: row.session_id, err });
      log.error({ replayId: row.id, copy, reason, errClass: errClass(err), detail: detail(err) }, `seazn cost: ${lines.whose} copy could not be removed — the move's cleanup retries it`);
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
    captureError(new Error(lines.report), {
      route: lines.route,
      extra: {
        failed: failures.length, sessionIds: failures.slice(0, REPORTED_IDS_MAX).map((f) => f.sessionId),
        firstError: failures[0] ? detail(failures[0].err) : null,
        unmeasured: unmeasured.length, unmeasuredReplayIds: unmeasured.slice(0, REPORTED_IDS_MAX),
      },
    });
  }
  return { purged, failed: failures.length };
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
  return deleteAndRemove(deps, now, due, "org_deleted");
}

/** Task 31b (T23 review G1): every replay row not deleted whose fixture is gone (`fixture_id` is ON DELETE SET NULL, V542: a format
 *  change, a stage rebuild, a division delete). It plays on no page — the public view inner-joins fixtures — while its copy is stored
 *  and billed, so it is deleted (`fixture_deleted`, V551) exactly as the org purge deletes, its copy read one last time first. No grace:
 *  a fixture does not come back, and nothing shows the row meanwhile. */
export async function purgeFixturelessReplays(deps: Pick<SeaznCostDeps, "replay">, now: Date, scope: SeaznCostScope = {}): Promise<SeaznPurgeResult> {
  const orgIds = orgIdsOf(scope);
  const due = await sql<{ id: string; org_id: string; session_id: string }[]>`
    select r.id, r.org_id, r.session_id
      from fixture_video_replays r
     where r.fixture_id is null and r.state <> 'deleted'
       ${orgIds ? sql`and r.org_id in ${sql(orgIds)}` : sql``}
     order by r.org_id, r.session_id, r.part_no, r.id`;
  return deleteAndRemove(deps, now, due, "fixture_deleted");
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
