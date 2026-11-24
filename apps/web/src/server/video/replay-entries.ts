import "server-only";
// server/video/replay-entries.ts — a fixture's recordings, in recording order, as the replay merge reads them (Seazn-hosted video,
// Task 25 review I1). ONE read for both sides of the part numbering: the video read (seazn-video.ts) turns these into parts, and
// discovery (usecases/seazn-replays.ts) numbers the rows it is about to store from the SAME entries, through the same pure rule
// (domain/replay-parts.ts `partNumbers`), so a number a viewer has seen is the number discovery stores.
//
// A recording is the full join, on the Cloudflare id, of the Seazn pass's locked recordings (`seazn_locked_videos`, of the fixture's
// ENDED Seazn sessions) and the replay move's rows (`fixture_video_replays`, removed ones included: they keep their numbers).
// Discovery adds `pending`: the recordings it is about to store that neither side holds yet (a recording the lock pass has not
// locked), placed in the same order, so the numbers it gives are the ones the merge will read back.
//
// ORDER (Task 14's rule): the session's (created_at, id), then when the recording began (the lock's, else the row's; null last),
// then the lock (null last), then the Cloudflare id. `orgId` null is the PUBLIC reader (a playable copy counts as listed only
// through `public_fixture_seazn_replays_v`); otherwise the organiser's, scoped to that org. The numbering never reads `listedVideo`.
import { sql, type Tx } from "@/lib/db";
import { TERMINAL_STATES } from "@/server/relay/domain/session";
import type { ReplayEntry } from "./domain/replay-parts";

export interface PendingRecordings {
  sessionId: string;
  sessionCreatedAt: Date;
  recordings: readonly { cfVideoId: string; recordedAt: Date }[];
}
/** A recording of the fixture; `pending` when it is one discovery is about to store and no side holds yet. */
export type ReplayEntryRead = ReplayEntry & { pending: boolean };

interface EntryRow {
  cf_video_id: string; session_id: string; session_created_at: Date | string; locked: boolean; input_discovered: boolean;
  part_no: number | null; state: string | null; removed: boolean | null; listed_video: string | null; pending: boolean;
}

export async function readReplayEntries(
  exec: typeof sql | Tx,
  a: { fixtureId: string; orgId: string | null; pending?: PendingRecordings },
): Promise<ReplayEntryRead[]> {
  const inOrg = a.orgId === null ? exec`` : exec`and s.org_id = ${a.orgId}`;
  const rowInOrg = a.orgId === null ? exec`` : exec`and r.org_id = ${a.orgId}`;
  const listedVideo = a.orgId === null
    ? exec`(select pv.bunny_video_id from public_fixture_seazn_replays_v pv where pv.fixture_id = r.fixture_id and pv.part_no = r.part_no)`
    : exec`case when r.state = 'playable' and r.deleted_at is null then r.bunny_video_id end`;
  const pendingSource = a.pending === undefined || a.pending.recordings.length === 0
    ? exec`select null::text as cf_video_id, null::uuid as session_id, null::timestamptz as session_created_at, null::timestamptz as recorded_at where false`
    : exec`select p.cf_video_id, ${a.pending.sessionId}::uuid as session_id, ${a.pending.sessionCreatedAt}::timestamptz as session_created_at, p.recorded_at
             from unnest(${a.pending.recordings.map((r) => r.cfVideoId)}::text[], ${a.pending.recordings.map((r) => r.recordedAt.toISOString())}::timestamptz[])
                  as p(cf_video_id, recorded_at)`;
  const rows = await exec<EntryRow[]>`
    with locked as (
      select v.cf_video_id, s.id as session_id, s.created_at as session_created_at, v.recorded_at, v.locked_at,
             i.replays_discovered_at is not null as input_discovered
        from seazn_locked_videos v
        join fixture_stream_inputs i on i.id = v.input_row_id
        join fixture_stream_sessions s on s.id = i.session_id
       where s.fixture_id = ${a.fixtureId} ${inOrg}
         and s.destination_kind = 'seazn' and i.role = 'programme' and s.state in ${exec([...TERMINAL_STATES])}
    ), listed as (
      select r.cf_video_id, r.session_id, s.created_at as session_created_at, r.recorded_at, r.part_no, r.state,
             (r.state = 'deleted' or r.deleted_at is not null) as removed, ${listedVideo} as listed_video
        from fixture_video_replays r
        join fixture_stream_sessions s on s.id = r.session_id
       where r.fixture_id = ${a.fixtureId} ${rowInOrg}
    ), pending as (
      select n.* from (${pendingSource}) n
       where not exists (select 1 from locked l where l.cf_video_id = n.cf_video_id)
         and not exists (select 1 from listed p where p.cf_video_id = n.cf_video_id)
    ), merged as (
      select coalesce(l.cf_video_id, p.cf_video_id) as cf_video_id,
             coalesce(l.session_id, p.session_id) as session_id,
             coalesce(l.session_created_at, p.session_created_at) as session_created_at,
             l.cf_video_id is not null as locked,
             coalesce(l.input_discovered, false) as input_discovered,
             p.part_no, p.state, p.removed, p.listed_video, false as pending,
             coalesce(l.recorded_at, p.recorded_at) as sort_recorded_at, l.locked_at as sort_locked_at
        from locked l full join listed p on p.cf_video_id = l.cf_video_id
      union all
      select n.cf_video_id, n.session_id, n.session_created_at, false, false, null, null, null, null, true, n.recorded_at, null
        from pending n
    )
    select cf_video_id, session_id, session_created_at, locked, input_discovered, part_no, state, removed, listed_video, pending
      from merged
     order by session_created_at, session_id, sort_recorded_at nulls last, sort_locked_at nulls last, cf_video_id`;
  return rows.map((r) => ({
    cfVideoId: r.cf_video_id,
    sessionId: r.session_id,
    sessionCreatedAt: new Date(r.session_created_at),
    locked: r.locked,
    inputDiscovered: r.input_discovered,
    pending: r.pending,
    row: r.part_no === null ? null : { partNo: r.part_no, state: r.state!, removed: r.removed!, listedVideo: r.listed_video },
  }));
}

/** T47: the PUBLIC reader's entries for MANY fixtures in ONE statement (the competition hub's camera icon asks it once per rebuild, never
 *  once per match). The same join, the same order and the same public `listedVideo` as `readReplayEntries` with `orgId: null` and nothing
 *  pending, and `hub-stream-flags-db.test.ts` holds the two to each other fixture by fixture. Each fixture's entries are in recording
 *  order; a fixture with none is absent from the map. */
export async function readPublicReplayEntriesMany(
  exec: typeof sql | Tx,
  fixtureIds: readonly string[],
): Promise<Map<string, ReplayEntryRead[]>> {
  const out = new Map<string, ReplayEntryRead[]>();
  if (fixtureIds.length === 0) return out;
  const ids = exec([...fixtureIds]);
  const rows = await exec<(EntryRow & { fixture_id: string })[]>`
    with locked as (
      select s.fixture_id, v.cf_video_id, s.id as session_id, s.created_at as session_created_at, v.recorded_at, v.locked_at,
             i.replays_discovered_at is not null as input_discovered
        from seazn_locked_videos v
        join fixture_stream_inputs i on i.id = v.input_row_id
        join fixture_stream_sessions s on s.id = i.session_id
       where s.fixture_id in ${ids}
         and s.destination_kind = 'seazn' and i.role = 'programme' and s.state in ${exec([...TERMINAL_STATES])}
    ), listed as (
      select r.fixture_id, r.cf_video_id, r.session_id, s.created_at as session_created_at, r.recorded_at, r.part_no, r.state,
             (r.state = 'deleted' or r.deleted_at is not null) as removed,
             (select pv.bunny_video_id from public_fixture_seazn_replays_v pv where pv.fixture_id = r.fixture_id and pv.part_no = r.part_no) as listed_video
        from fixture_video_replays r
        join fixture_stream_sessions s on s.id = r.session_id
       where r.fixture_id in ${ids}
    ), merged as (
      select coalesce(l.fixture_id, p.fixture_id) as fixture_id,
             coalesce(l.cf_video_id, p.cf_video_id) as cf_video_id,
             coalesce(l.session_id, p.session_id) as session_id,
             coalesce(l.session_created_at, p.session_created_at) as session_created_at,
             l.cf_video_id is not null as locked,
             coalesce(l.input_discovered, false) as input_discovered,
             p.part_no, p.state, p.removed, p.listed_video,
             coalesce(l.recorded_at, p.recorded_at) as sort_recorded_at, l.locked_at as sort_locked_at
        from locked l full join listed p on p.cf_video_id = l.cf_video_id
    )
    select fixture_id, cf_video_id, session_id, session_created_at, locked, input_discovered, part_no, state, removed, listed_video, false as pending
      from merged
     order by fixture_id, session_created_at, session_id, sort_recorded_at nulls last, sort_locked_at nulls last, cf_video_id`;
  for (const r of rows) {
    const entry: ReplayEntryRead = {
      cfVideoId: r.cf_video_id,
      sessionId: r.session_id,
      sessionCreatedAt: new Date(r.session_created_at),
      locked: r.locked,
      inputDiscovered: r.input_discovered,
      pending: false,
      row: r.part_no === null ? null : { partNo: r.part_no, state: r.state!, removed: r.removed!, listedVideo: r.listed_video },
    };
    const list = out.get(r.fixture_id);
    if (list) list.push(entry);
    else out.set(r.fixture_id, [entry]);
  }
  return out;
}
