import "server-only";
// Check-in capacity plan 1, Task 5 (spec §6.2, §6.3): the presence store - the writer the webhook receiver (Task 7) calls and the
// readers plans 2 and 3 lean on, over V527's `fixture_video_presence` and `realtimekit_ended_sessions`.
//
// WHAT A ROW IS. One per (meeting, peer): open while the peer is in the room, closed by the peer's own participantLeft
// (left_by 'left') or by its session's meeting.ended (left_by 'ended'). The webhook stamps are the vendor's (`joinedAt`,
// `leftAt`, `endedAt`), never our receipt time. The fixture (and the vendor on a retry) delivers concurrently, so arrival order
// is not emit order, and two deliveries can run at once on two connections: every write path (joined, left, ended) therefore
// runs in a transaction holding `pg_advisory_xact_lock(hashtext(meeting_id))`, so the events of one meeting apply one at a time
// and each sees every earlier one committed (under READ COMMITTED a joined and an ended running together would otherwise each
// miss the other's write and leave an open peer in a dead meeting). With that, the webhook rows depend only on the SET of
// joined/left/ended events applied, never their order or repeats, with ONE exception: a session's end is the endedAt of the
// FIRST meeting.ended recorded for it (a repeat with a different endedAt is ignored, and every row it closes carries the
// recorded value). The arrival hazards each have one rule: a left before its joined inserts the row with both stamps; a joined
// after its own left leaves left_at alone; a joined after its session's end is stored closed at that end, and a joined with no
// session is stored closed at the earliest recorded end of any session of the meeting at or after its join (the rows the ended
// path closes, read from the other side). A peer's OWN leave beats its session's end. A read row (recordPresenceFromRead) takes
// no lock and is outside this claim: one written after its session ended stays open, a hint the readers trust for
// PRESENCE_READ_TRUST_MS only.
//
// WHAT A ROW IS NOT. A `source = 'read'` row is the seat's own vendor read written as a hint (plan 2); only a webhook can close
// a row, so a read row is trusted for PRESENCE_READ_TRUST_MS after it was received and then not (owner ruling R4). Nothing here
// seats a player (Global Constraints): these are facts for the readers to weigh.
//
// OWNERSHIP. A delivery is ours only if it names a meeting we hold (`heldMeeting`); the receiver gates on it and passes the
// answer in, and `applyPresenceEvent` refuses (writes nothing) when handed none.
import type postgres from "postgres";
import { log } from "@/server/logger";
import type { RealtimeKitEvent } from "./webhook-event";

type AnySql = postgres.Sql | postgres.TransactionSql;
type Side = "home" | "away";

/** Runs `fn` holding the meeting's presence lock, `pg_advisory_xact_lock(hashtext(meetingId))`: in a transaction of its own on
 *  the pool, or inside the caller's transaction (which then holds the lock to its own end). A TransactionSql is told from the pool
 *  by its `savepoint` method, as appearances.ts's ownTransaction does (`"begin" in sql` is false on lib/db's Proxy). */
async function underMeetingLock<T>(db: AnySql, meetingId: string, fn: (tx: AnySql) => Promise<T>): Promise<T> {
  const run = async (tx: AnySql) => {
    await tx`select pg_advisory_xact_lock(hashtext(${meetingId}))`;
    return fn(tx);
  };
  const open = db as Partial<Pick<postgres.TransactionSql, "savepoint">>;
  if (typeof open.savepoint === "function") return run(db);
  return (await (db as postgres.Sql).begin((tx) => run(tx))) as T;
}

export type PresenceRow = {
  meetingId: string;
  peerId: string;
  fixtureId: string | null;
  side: Side | null;
  participantId: string | null;
  customParticipantId: string;
  sessionId: string | null;
  joinedAt: Date | null;
  leftAt: Date | null;
  leftBy: "left" | "ended" | null;
  source: "webhook" | "read";
  receivedAt: Date;
};
// `seq` stays in SQL only (an int8 the postgres driver would hand back as a string): it orders rows, nothing reads its value.

/** A `source='read'` row is current only this long after its `received_at` (Global Constraints; spec §6.3's fallback window). */
export const PRESENCE_READ_TRUST_MS = 10_000;

/** The shadow report's tolerance for a webhook that lands after the seat's stamp: inside it, plan 2's presence path would still
 *  have seated the player before its fallback fired (spec §6.3). Compared on OUR clock (`received_at` against the seat's stamp). */
export const SHADOW_ARRIVAL_TOLERANCE_MS = 10_000;

/** The current peer of a set of rows: the latest `joinedAt` with `leftAt` null; a row with no `joinedAt` is never current; among
 *  equal `joinedAt` the LATER row in the input wins. Callers pass rows in the presence order (`joined_at, received_at, seq`
 *  ascending, Global Constraints), so the tie is deterministic: a SQL reader feeding this function must `order by` exactly that. */
export function currentPeerOf(rows: readonly Pick<PresenceRow, "peerId" | "joinedAt" | "leftAt">[]): { peerId: string; joinedAt: Date } | null {
  let best: { peerId: string; joinedAt: Date } | null = null;
  for (const r of rows) {
    if (r.joinedAt === null || r.leftAt !== null) continue;
    // `>=`: an equal joinedAt takes the later row
    if (best === null || r.joinedAt.getTime() >= best.joinedAt.getTime()) best = { peerId: r.peerId, joinedAt: r.joinedAt };
  }
  return best;
}

/** The receiver's ownership test (Global Constraints), and the board the rows are stamped with: the meeting's (fixture_id, side)
 *  from fixture_video_meetings, else from video_rooms_to_end, else from an existing presence row of that meeting; null when none
 *  (not ours: the receiver answers 200 ignored and writes nothing). The third arm reads only a presence row that CARRIES a board
 *  (fixture_id and side both non-null): a row stored with none (a read for a meeting held nowhere) never makes its meeting held. Each lookup is keyed by meeting_id alone, which the video
 *  source guard classifies `other_key` (its own rule test, `video-per-player-source-guard.test.ts` line 146), not unkeyed. */
export async function heldMeeting(db: AnySql, meetingId: string): Promise<{ fixtureId: string; side: Side } | null> {
  // One statement, three sources in priority order: the live row, the parked room, then the newest stamped presence row.
  const [r] = await db<{ fixture_id: string; side: Side }[]>`
    select fixture_id, side from (
      select 1 as pri, fixture_id, side from fixture_video_meetings where meeting_id = ${meetingId}
      union all
      select 2, fixture_id, side from video_rooms_to_end where meeting_id = ${meetingId}
      union all
      (select 3, fixture_id, side from fixture_video_presence
        where meeting_id = ${meetingId} and fixture_id is not null and side is not null
        order by received_at desc, seq desc limit 1)
    ) held
    order by pri limit 1`;
  return r ? { fixtureId: r.fixture_id, side: r.side } : null;
}

/** The participant a custom id names in a meeting, through the meeting row's (fixture_id, side): a player's row where `person_id::text =
 *  customParticipantId` (preset 'player'); else an arbiter's row where `user_id::text = split_part(customParticipantId, ':', 1)` (preset
 *  'arbiter', removed_at null): an arbiter's subject is the user id, a colon and a nonce (arbiter.ts findOrMakeArbiter, kept by plan 3), so the
 *  prefix is the match; when that user has more than one live arbiter row in the meeting (one per open tab until plan 3's V534 makes the
 *  pair unique) the newest wins: `order by created_at desc limit 1` (V451 line 280). null when neither. */
export async function resolveParticipant(db: AnySql, a: { meetingId: string; customParticipantId: string }): Promise<string | null> {
  const [r] = await db<{ participant_id: string }[]>`
    select p.participant_id
      from fixture_video_meetings m
      join fixture_video_participants p on p.fixture_id = m.fixture_id and p.side = m.side
     where m.meeting_id = ${a.meetingId}
       and ((p.preset = 'player' and p.person_id::text = ${a.customParticipantId})
         or (p.preset = 'arbiter' and p.removed_at is null and p.user_id::text = split_part(${a.customParticipantId}, ':', 1)))
     order by (p.preset = 'player') desc, p.created_at desc
     limit 1`;
  return r ? r.participant_id : null;
}

/** Applies one event under the meeting's lock (`underMeetingLock`); the result depends only on the SET of events applied, never
 *  their order or repeats, save a session's end being its first recorded endedAt (the header; property in the tests).
 *  joined: insert the row with joined_at from the payload and, when the session has already ended (`realtimekit_ended_sessions`
 *  holds (meetingId, sessionId); for a null sessionId, any session of the meeting with ended_at >= joinedAt, the earliest),
 *  left_at = that ended_at and left_by 'ended'; on conflict keep an existing row's joined_at (coalesce), close it the same way when
 *  it is still open, and set source 'webhook' (a webhook upgrades a read row).
 *  left: insert with both stamps and left_by 'left'; on conflict left_at = the payload's leftAt UNLESS the row's left_by is already
 *  'left' (a peer's own leave beats its session's end; the first own leave is kept), left_by 'left', source 'webhook'.
 *  ended: upsert (meetingId, sessionId, endedAt) into realtimekit_ended_sessions (do nothing on conflict: the FIRST end recorded
 *  stays), then, with E = the RECORDED ended_at (never a repeat's payload), left_at = E, left_by 'ended' on every open row of
 *  the meeting's session, and on every row of the meeting stored without a session that joined at or before E and is open or
 *  closed by a LATER end (the earliest end at or after the join wins, whichever ended arrives first). An `ended` with a null
 *  sessionId closes nothing and records nothing (logged at warn).
 *  Every row written carries fixture_id / side from `held` (the receiver passes the heldMeeting answer it gated on; when omitted it
 *  is looked up here). "ignored" for `other`. */
export async function applyPresenceEvent(db: AnySql, ev: RealtimeKitEvent, receivedAt: Date, held?: { fixtureId: string; side: Side } | null): Promise<"applied" | "ignored"> {
  if (ev.kind === "other") return "ignored";
  // Ownership: a meeting we do not hold writes nothing, not even an ended-session row (Global Constraints).
  const board = held === undefined ? await heldMeeting(db, ev.meetingId) : held;
  if (board === null) return "ignored";

  if (ev.kind === "ended") {
    if (ev.sessionId === null) {
      // Without a session there is nothing to scope the end to, and closing by meeting alone would close another session's peers.
      log.warn({ meetingId: ev.meetingId }, "presence: meeting.ended carried no sessionId; nothing closed or recorded");
      return "ignored";
    }
    const sessionId = ev.sessionId;
    await underMeetingLock(db, ev.meetingId, async (tx) => {
      await tx`
        insert into realtimekit_ended_sessions (meeting_id, session_id, ended_at, received_at)
        values (${ev.meetingId}, ${sessionId}, ${ev.endedAt}, ${receivedAt})
        on conflict (meeting_id, session_id) do nothing`;
      // A second statement, so it sees the recorded row (a CTE's insert is invisible to its own statement's update).
      await tx`
        with s as (select ended_at from realtimekit_ended_sessions where meeting_id = ${ev.meetingId} and session_id = ${sessionId})
        update fixture_video_presence p
           set left_at = s.ended_at, left_by = 'ended'
          from s
         where p.meeting_id = ${ev.meetingId}
           and ((p.session_id = ${sessionId} and p.left_at is null)
             or (p.session_id is null and p.joined_at <= s.ended_at
                 and (p.left_at is null or (p.left_by = 'ended' and p.left_at > s.ended_at))))`;
    });
    return "applied";
  }

  const participantId = await resolveParticipant(db, { meetingId: ev.meetingId, customParticipantId: ev.customParticipantId });
  if (participantId === null) {
    // Never dropped: the row is stored with a null participant (the readers still match it by custom id) and the miss is logged.
    log.warn({ meetingId: ev.meetingId, peerId: ev.peerId }, "presence: custom participant id names nobody on file in this meeting; stored without a participant");
  }

  if (ev.kind === "joined") {
    await underMeetingLock(db, ev.meetingId, (tx) => tx`
      with e as (
        -- the session's recorded end; for a joined with no session, the earliest end of any session at or after the join
        select ended_at from realtimekit_ended_sessions
         where meeting_id = ${ev.meetingId}
           and (session_id = ${ev.sessionId} or (${ev.sessionId}::text is null and ended_at >= ${ev.joinedAt}))
         order by ended_at
         limit 1
      )
      insert into fixture_video_presence
        (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, session_id, joined_at, left_at, left_by, source, received_at)
      values (
        ${ev.meetingId}, ${ev.peerId}, ${board.fixtureId}, ${board.side}, ${participantId}, ${ev.customParticipantId}, ${ev.sessionId}, ${ev.joinedAt},
        (select ended_at from e),
        case when exists (select 1 from e) then 'ended' end,
        'webhook', ${receivedAt})
      on conflict (meeting_id, peer_id) do update
        set joined_at      = coalesce(fixture_video_presence.joined_at, excluded.joined_at),
            participant_id = coalesce(fixture_video_presence.participant_id, excluded.participant_id),
            session_id     = coalesce(fixture_video_presence.session_id, excluded.session_id),
            fixture_id     = coalesce(fixture_video_presence.fixture_id, excluded.fixture_id),
            side           = coalesce(fixture_video_presence.side, excluded.side),
            -- an open row (a read hint written after the end) is closed like a fresh insert; a closed one keeps its stamps
            left_at        = case when fixture_video_presence.left_at is null then excluded.left_at else fixture_video_presence.left_at end,
            left_by        = case when fixture_video_presence.left_at is null then excluded.left_by else fixture_video_presence.left_by end,
            source         = 'webhook'`);
    logStay("joined", ev.meetingId, board, ev.peerId, ev.joinedAt, null);
    return "applied";
  }

  await underMeetingLock(db, ev.meetingId, (tx) => tx`
    insert into fixture_video_presence
      (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, session_id, joined_at, left_at, left_by, source, received_at)
    values (${ev.meetingId}, ${ev.peerId}, ${board.fixtureId}, ${board.side}, ${participantId}, ${ev.customParticipantId}, ${ev.sessionId}, ${ev.joinedAt},
            ${ev.leftAt}, 'left', 'webhook', ${receivedAt})
    on conflict (meeting_id, peer_id) do update
      set joined_at      = coalesce(fixture_video_presence.joined_at, excluded.joined_at),
          participant_id = coalesce(fixture_video_presence.participant_id, excluded.participant_id),
          session_id     = coalesce(fixture_video_presence.session_id, excluded.session_id),
          fixture_id     = coalesce(fixture_video_presence.fixture_id, excluded.fixture_id),
          side           = coalesce(fixture_video_presence.side, excluded.side),
          left_at        = case when fixture_video_presence.left_by = 'left' then fixture_video_presence.left_at else excluded.left_at end,
          left_by        = 'left',
          source         = 'webhook'`);
  logStay("left", ev.meetingId, board, ev.peerId, ev.leftAt, "left");
  return "applied";
}

/** One info line per recorded join and leave, so a drop can be read off the log beside the browser's Sentry warning
 *  (owner 2026-11-22: "we have logger and sentry"). Ids only - never the custom participant id (a person id) or a name.
 *  `at` is the vendor's own stamp; `leftBy` is what the event says ('left' for a leave, null for a join). */
function logStay(kind: "joined" | "left", meetingId: string, board: { fixtureId: string; side: Side }, peerId: string, at: Date, leftBy: "left" | null): void {
  log.info({ meetingId, fixtureId: board.fixtureId, side: board.side, peerId, at: at.toISOString(), leftBy }, `presence: participant ${kind}`);
}

type Who = { meetingId: string; participantId: string; customParticipantId: string };

/** The current peer of this participant in this meeting, matched by participant_id OR (participant_id null and custom_participant_id
 *  = `customParticipantId`), in the presence order. Open rows only (`left_at is null`, the partial live index's predicate): the
 *  same answer as reading every row, since currentPeerOf skips a closed one. A `source='read'` row older than PRESENCE_READ_TRUST_MS at `now` (default: the
 *  wall clock) is skipped, so a fallback seat's row is a hint for one claim, never a standing fact (owner ruling R4). `source` and
 *  `receivedAt` are returned so the caller can tell a read hint from a webhook. */
export async function currentPresence(
  db: AnySql,
  a: Who & { now?: Date },
): Promise<{ peerId: string; sessionId: string | null; joinedAt: Date; source: "webhook" | "read"; receivedAt: Date } | null> {
  const now = a.now ?? new Date();
  const cutoff = new Date(now.getTime() - PRESENCE_READ_TRUST_MS);
  const rows = await db<{ peer_id: string; session_id: string | null; joined_at: Date | null; left_at: Date | null; source: "webhook" | "read"; received_at: Date }[]>`
    select peer_id, session_id, joined_at, left_at, source, received_at
      from fixture_video_presence
     where meeting_id = ${a.meetingId}
       and (participant_id = ${a.participantId} or (participant_id is null and custom_participant_id = ${a.customParticipantId}))
       and left_at is null
       and (source = 'webhook' or received_at > ${cutoff})
     order by joined_at, received_at, seq`;
  const cur = currentPeerOf(rows.map((r) => ({ peerId: r.peer_id, joinedAt: r.joined_at, leftAt: r.left_at })));
  if (cur === null) return null;
  const row = rows.find((r) => r.peer_id === cur.peerId)!;
  return { peerId: cur.peerId, sessionId: row.session_id, joinedAt: cur.joinedAt, source: row.source, receivedAt: row.received_at };
}

/** Has this participant EVER had a presence row (any source, open or closed) in this meeting? The same matching rule as
 *  currentPresence. Plan 3's arbiter refusal calls this, so the match rule ships once. */
export async function everJoined(db: AnySql, a: Who): Promise<boolean> {
  const [r] = await db<{ ever: boolean }[]>`
    select exists (
      select 1 from fixture_video_presence
       where meeting_id = ${a.meetingId}
         and (participant_id = ${a.participantId} or (participant_id is null and custom_participant_id = ${a.customParticipantId}))
    ) as ever`;
  return r!.ever;
}

/** A row from the seat's own vendor read (plan 2): source 'read'; an existing row (of either source) is never overwritten.
 *
 *  It takes the receiver's KEY SHARE on the board's fixture row (webhook.ts step 4) before it writes, in a transaction of its own or
 *  the caller's: a read racing the fixture's delete either commits first (the delete waits, and its V527 trigger purges the row) or
 *  finds the fixture gone and writes none. A deleted board's meeting is still HELD through the room the delete parked (V460), so
 *  without the lock a read after the delete would re-insert a person's id into the sealed table. A meeting held nowhere has no board
 *  to lock and keeps its row with no board, as before. Still lock-free with respect to the MEETING's advisory lock, by ruling: a
 *  read row is trusted PRESENCE_READ_TRUST_MS at most, and a webhook for the same peer upgrades it. */
export async function recordPresenceFromRead(
  db: AnySql,
  a: Who & { peerId: string; sessionId: string | null; joinedAt: Date },
  receivedAt: Date,
): Promise<void> {
  const write = async (tx: AnySql) => {
    // The row carries the board like every other row (the shadow report scopes by it); null only when the meeting is held nowhere.
    const board = await heldMeeting(tx, a.meetingId);
    if (board !== null) {
      const [alive] = await tx`select 1 from fixtures where id = ${board.fixtureId} for key share`;
      if (!alive) return;
    }
    await tx`
      insert into fixture_video_presence
        (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, session_id, joined_at, source, received_at)
      values (${a.meetingId}, ${a.peerId}, ${board?.fixtureId ?? null}, ${board?.side ?? null}, ${a.participantId}, ${a.customParticipantId}, ${a.sessionId},
              ${a.joinedAt}, 'read', ${receivedAt})
      on conflict (meeting_id, peer_id) do nothing`;
  };
  // A TransactionSql is told from the pool by its `savepoint` method (as underMeetingLock does).
  const open = db as Partial<Pick<postgres.TransactionSql, "savepoint">>;
  if (typeof open.savepoint === "function") return write(db);
  await (db as postgres.Sql).begin((tx) => write(tx));
}

/** Every peer of a participant in a meeting, in the presence order (oldest join first). A row with a null joined_at (a left that
 *  carried no joinedAt, its joined not yet arrived) sorts LAST, Postgres's ascending default; such a row is never current
 *  (currentPeerOf skips it), so where it sits changes no answer, and the order is left as the shared one rather than `nulls first`. */
export async function peersOf(db: AnySql, a: Who): Promise<Pick<PresenceRow, "peerId" | "sessionId" | "joinedAt" | "leftAt" | "leftBy" | "source">[]> {
  const rows = await db<{ peer_id: string; session_id: string | null; joined_at: Date | null; left_at: Date | null; left_by: "left" | "ended" | null; source: "webhook" | "read" }[]>`
    select peer_id, session_id, joined_at, left_at, left_by, source
      from fixture_video_presence
     where meeting_id = ${a.meetingId}
       and (participant_id = ${a.participantId} or (participant_id is null and custom_participant_id = ${a.customParticipantId}))
     order by joined_at, received_at, seq`;
  return rows.map((r) => ({ peerId: r.peer_id, sessionId: r.session_id, joinedAt: r.joined_at, leftAt: r.left_at, leftBy: r.left_by, source: r.source }));
}

export type ShadowScope = { since: Date; fixtureIds?: readonly string[] };
export type ShadowReport = {
  /** player participants in scope whose seat verified the camera (`last_publisher_seen_at >= since`) */
  verified: number;
  /** of those, the ones a `source='webhook'` row was OPEN for at the stamp: received_at <= stamp + SHADOW_ARRIVAL_TOLERANCE_MS
   *  and (left_at is null or left_at > stamp). A row is the seat's when it names the seat's participant, or names none and carries
   *  the seat's person id as its custom id in the seat's meeting (the readers' rule). CAVEAT: a webhook that UPGRADES a read row
   *  keeps the read's received_at, so for such a row the tolerance measures the read's arrival, not the webhook's: once plan 2
   *  writes read rows, a webhook that came late but upgraded an early read hint counts as covered. Rows here are written by
   *  webhooks alone until then; plan 2 and the shadow script (Task 9) must read `covered` with that in mind. */
  covered: number;
  missing: { fixtureId: string; side: Side; participantId: string; seenAt: Date }[];
  /** presence rows in scope with left_at null at report time. Read at a quiescent point (every meeting in scope ended), any is a
   *  phantom: the dangerous direction, a peer that looks current after it went */
  open: { meetingId: string; peerId: string; participantId: string | null; source: "webhook" | "read"; receivedAt: Date }[];
  /** rows in scope closed only by meeting.ended (left_by 'ended'): each is a participantLeft that never arrived, or a reload's old
   *  peer the vendor never reported leaving. Measured and printed, not gated (spec §3: the vendor's leave-on-reload is unmeasured) */
  closedByEnded: number;
  /** of closedByEnded, the rows that were their participant's NEWEST peer in the meeting (no newer row of the same custom id): still
   *  in the room when it ended. Reported, not the R4 risk */
  endedWhileNewest: number;
  /** of closedByEnded, the rows a NEWER row of the same participant (custom id) in the same meeting superseded, by the presence order:
   *  a reload's old peer the vendor never reported leaving, the R4 risk. The script's `blocksProofFlag` keys on this */
  endedSuperseded: number;
  /** spec §6.8 step 3: join -> webhook latency, `received_at - joined_at` in ms over the `source='webhook'` rows in scope with a
   *  joined_at, nearest-rank (`percentile_disc`) p50/p95; null when `n` is 0. CAVEAT: a row's received_at is the FIRST delivery that
   *  wrote it, so a row whose participantLeft arrived before its joined measures the leave's arrival, and a webhook that upgraded a
   *  read row keeps the read's (the `covered` caveat above); rows are webhook-written alone until plan 2. Feeds owner ruling R4. */
  joinLatencyMs: { p50: number | null; p95: number | null; n: number };
  /** `source='webhook'` rows in scope stored with NO participant: their customParticipantId named nobody on file, i.e. the vendor did
   *  not echo the id we minted (spec §6.8 step 3's customParticipantId echo). */
  noEcho: number;
};

/** Shadow mode's TWO-SIDED comparison over `scope`: player participants whose seat read found the camera on
 *  (`fixture_video_participants.last_publisher_seen_at`, V451 line 279, stamped by preflight.ts line ~530 with the seat's `now` at the
 *  claim that verified the camera) against the webhook rows, and the rows that are still open. Scope: `since` (seats by
 *  last_publisher_seen_at, presence rows by received_at), and when `fixtureIds` is given only those fixtures (seats by
 *  `fixture_video_participants.fixture_id`, presence rows by their own `fixture_id`) - a test or a run never reads another suite's
 *  seats on a shared DB. */
export async function presenceShadowReport(db: AnySql, scope: ShadowScope): Promise<ShadowReport> {
  // null = no fixture filter; an empty list is an empty scope (`= any('{}')` matches nothing), never "everything".
  const ids = scope.fixtureIds === undefined ? null : [...scope.fixtureIds];

  const seats = await db<{ fixture_id: string; side: Side; participant_id: string; seen_at: Date; covered: boolean }[]>`
    select p.fixture_id, p.side, p.participant_id, p.last_publisher_seen_at as seen_at,
           exists (
             select 1 from fixture_video_presence w
              where w.fixture_id = p.fixture_id
                -- the readers' match rule (currentPresence): the participant, or a row stored without one (its custom id named
                -- nobody on file when it arrived) whose custom id is the seat's subject, a player's person id, in the seat's meeting
                and (w.participant_id = p.participant_id
                  or (w.participant_id is null and w.side = p.side and w.custom_participant_id = p.person_id::text))
                and w.source = 'webhook'
                and w.received_at <= p.last_publisher_seen_at + (${SHADOW_ARRIVAL_TOLERANCE_MS}::int * interval '1 millisecond')
                and (w.left_at is null or w.left_at > p.last_publisher_seen_at)
           ) as covered
      from fixture_video_participants p
     where p.preset = 'player'
       and p.last_publisher_seen_at >= ${scope.since}
       and (${ids}::uuid[] is null or p.fixture_id = any(${ids}::uuid[]))
     order by p.last_publisher_seen_at, p.participant_id`;

  const open = await db<{ meeting_id: string; peer_id: string; participant_id: string | null; source: "webhook" | "read"; received_at: Date }[]>`
    select meeting_id, peer_id, participant_id, source, received_at
      from fixture_video_presence
     where left_at is null
       and received_at >= ${scope.since}
       and (${ids}::uuid[] is null or fixture_id = any(${ids}::uuid[]))
     order by received_at, seq`;

  // One pass over the scope's rows: the end count, and the spec §6.8 step 3 numbers (join latency on OUR receipt clock against the
  // vendor's joinedAt, nearest-rank percentiles; and how many webhook rows stored no participant, i.e. their customParticipantId did not
  // echo back to a participant on file).
  // An ended row is SUPERSEDED when a newer row (the presence order: joined_at, received_at, seq) of the same participant (its custom
  // id) exists in the same meeting: a reload's old peer the vendor never reported leaving, the R4 risk. Otherwise it was its
  // participant's newest peer, still in the room when the meeting ended. A row with no joined_at compares as no newer and is newest.
  const [agg] = await db<{ ended: number; ended_superseded: number; no_echo: number; lat_n: number; lat_p50: number | null; lat_p95: number | null }[]>`
    select count(*) filter (where left_by = 'ended')::int as ended,
           count(*) filter (where left_by = 'ended' and exists (
             select 1 from fixture_video_presence n
              where n.meeting_id = x.meeting_id
                and n.custom_participant_id = x.custom_participant_id
                and (n.joined_at, n.received_at, n.seq) > (x.joined_at, x.received_at, x.seq)))::int as ended_superseded,
           count(*) filter (where source = 'webhook' and participant_id is null)::int as no_echo,
           count(*) filter (where source = 'webhook' and joined_at is not null)::int as lat_n,
           (percentile_disc(0.5) within group (order by round(extract(epoch from (received_at - joined_at)) * 1000))
             filter (where source = 'webhook' and joined_at is not null))::int as lat_p50,
           (percentile_disc(0.95) within group (order by round(extract(epoch from (received_at - joined_at)) * 1000))
             filter (where source = 'webhook' and joined_at is not null))::int as lat_p95
      from fixture_video_presence x
     where x.received_at >= ${scope.since}
       and (${ids}::uuid[] is null or x.fixture_id = any(${ids}::uuid[]))`;

  return {
    verified: seats.length,
    covered: seats.filter((s) => s.covered).length,
    missing: seats.filter((s) => !s.covered).map((s) => ({ fixtureId: s.fixture_id, side: s.side, participantId: s.participant_id, seenAt: s.seen_at })),
    open: open.map((o) => ({ meetingId: o.meeting_id, peerId: o.peer_id, participantId: o.participant_id, source: o.source, receivedAt: o.received_at })),
    closedByEnded: agg!.ended,
    endedWhileNewest: agg!.ended - agg!.ended_superseded,
    endedSuperseded: agg!.ended_superseded,
    joinLatencyMs: { p50: agg!.lat_p50, p95: agg!.lat_p95, n: agg!.lat_n },
    noEcho: agg!.no_echo,
  };
}

/** Dedupe needs only the vendor's retry horizon (unmeasured; spec §3): a week is generous. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A presence row outlives any stay, round and shadow-report window (`--since` is at most days). */
export const PRESENCE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Retention (Task 10b). Deletes delivery rows received before `now - WEBHOOK_DELIVERY_RETENTION_MS`, and presence and ended-session
 *  rows received before `now - PRESENCE_RETENTION_MS`: one statement per table, each on its `received_at` index. Returns the counts.
 *  A row exactly at its cutoff stays (strictly before). The external-play sweep calls it once a pass (sweep/run.ts).
 *
 *  WHAT THIS IS NOT. It is the age bound only. A row that outlives its FIXTURE is the fixture delete's to remove (V527's trigger on
 *  `fixtures`, which deletes the rows COMMITTED when it runs). The webhook writer keeps that complete: it takes KEY SHARE on the held
 *  board's fixture row before writing (webhook.ts step 4), so a delete either waits for the delivery to commit and then purges its
 *  rows, or ran first and the delivery (its meeting still held through the room the delete parked) writes none. The READ writer
 *  (`recordPresenceFromRead`, plan 2's seat) takes the same key share (plan 2 Task 6), so it cannot leave one either. A row carries a person's id (a player's `custom_participant_id` is the
 *  person id, an arbiter's the user id and a nonce): when a PERSON or USER is deleted, their rows stay until this prune takes them,
 *  up to PRESENCE_RETENTION_MS (30 days). That is deliberate and not purged by custom id: the ids are pseudonymous (no name, email or
 *  contact detail sits in any of these tables, and the tables are sealed from every tenant role), the window is short, and the fixture
 *  delete above already removes them with the board. */
export async function prunePresence(db: AnySql, now: Date): Promise<{ deliveries: number; presence: number; endedSessions: number }> {
  const deliveryCutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS);
  const presenceCutoff = new Date(now.getTime() - PRESENCE_RETENTION_MS);
  const deliveries = await db`delete from realtimekit_webhook_deliveries where received_at < ${deliveryCutoff}`;
  const presence = await db`delete from fixture_video_presence where received_at < ${presenceCutoff}`;
  const endedSessions = await db`delete from realtimekit_ended_sessions where received_at < ${presenceCutoff}`;
  return { deliveries: deliveries.count, presence: presence.count, endedSessions: endedSessions.count };
}
