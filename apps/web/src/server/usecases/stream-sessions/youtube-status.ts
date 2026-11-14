import "server-only";
// The YouTube live status read of a session streaming into a YouTube Connect broadcast (see ./index.ts). Owner direction 2026-11-14.
//
// While such a session is LIVE the tick (the stream-tick cron pass AND the organiser's poll are both `tickSession`) asks YouTube
// two things, read-only: the BROADCAST's life (`broadcastLife`) and, when that is live, the STREAM's status and health
// (`streamStatus`). `youtubeLiveWordOf` reduces the answers to one word - live_receiving | not_live | live_no_video - which is stored on
// the session row and shown by the stream panel.
//
//   * The first read is YOUTUBE_STATUS_FIRST_READ_AFTER_MS (60 s) after the session went live (`live_at`), never before: YouTube takes
//     that long to settle after the phone starts sending, and a read before it would only say "not live" about a broadcast that is
//     about to be.
//   * One read per window however many panels and cron firings are looking, by a CLAIM (below). The window is
//     YOUTUBE_STATUS_READ_EVERY_MS - until `live_receiving` has held for YOUTUBE_STATUS_STEADY_AFTER_READS reads in a row, and then
//     YOUTUBE_STATUS_STEADY_EVERY_MS: a stream that has been fine three times running is read every five minutes, not every minute
//     (the quota is shared by every org; the word that most needs a fast answer is the one that is not `live_receiving`). ANY other
//     word zeroes the run and the fast window is back.
//   * A CHANGE of word is ONE `youtube_status` event (source output, kind observed) written in the SAME transaction as the stored
//     word, under the session's row lock: neither half alone is safe to serve. A read that changes nothing writes no event.
//   * An API error is NOT a word. Nor is an answer that says nothing (`youtubeLiveWordOf` -> null). Both carry the previous word and
//     record nothing: a status line that read an outage as "YouTube is receiving no video" would tell an organiser to go and fix a
//     phone that is fine.
//   * A DEAD GRANT is not an outage: the club's connection is revoked, or Google says the grant is no longer valid
//     (`isDeadGrantRefusal`). Then the stored word is not the truth any more and nothing will refresh it, so it is CLEARED (one event,
//     word -> null; the panel shows no line) instead of left saying what was true before the grant died. The read stays read-only on
//     OUR side - the connection is not moved to `reconnect_needed` here (the end step and the daily check own that).
//   * A pasted key has no broadcast and so no claim, no call and no event (the projection says so: current.ts).
//   * The read never throws out of a tick: `failed` in the stream-tick pass counts ticks that threw, and a status line is not worth a
//     failed tick.
import { sql, type Tx } from "@/lib/db";
import type { YoutubeLiveWord, YoutubeStatusView } from "@/lib/youtube";
import { log } from "@/server/logger";
import { recordEvent } from "@/server/relay/telemetry";
import { youtubeLiveWordOf } from "@/server/youtube/live-status";
import { YouTubeError, isDeadGrantRefusal, type LifeCycle, type StreamStatusInfo } from "@/server/youtube/port";
import { openToken } from "@/server/youtube/token-store";
import { youtubeOf, type SessionDeps } from "./deps";

/** The first read of a session: this long after it went live (owner direction 2026-11-14: "first read 60 s after live_at"). */
export const YOUTUBE_STATUS_FIRST_READ_AFTER_MS = 60_000;

/** The claim window: one read of YouTube per session per this long, across every open panel and the cron. Under the 60 s of prod's
 *  every-minute stream tick (apps/cron-worker/src/schedule.ts), so the cron's firing always finds the window open - the same reason
 *  ingest-poll's window sits a second under its poll interval - and over the 5 s a panel polls, so an open panel is not a read per
 *  poll. Each read costs 2 quota units (liveBroadcasts.list + liveStreams.list) of the Cloud project's 10,000 a day, shared by every
 *  org: this window IS the quota bill while the stream is not steady (about 240 units for a two-hour match that never settles). */
export const YOUTUBE_STATUS_READ_EVERY_MS = 55_000;

/** Back-off: once this many reads IN A ROW have said `live_receiving`, the window widens to YOUTUBE_STATUS_STEADY_EVERY_MS. Three: one
 *  read can be a blip, two a coincidence, three is a stream that is plainly fine. */
export const YOUTUBE_STATUS_STEADY_AFTER_READS = 3;

/** The back-off window: five minutes, less the same 5 s early-cron allowance the fast window carries (a firing a few seconds early
 *  must still find the window open, or a whole extra minute goes by). A match that streams fine for two hours then costs about 48
 *  quota units, not 240. The price is a slower first word when a steady stream then drops (up to five minutes - the fast window is
 *  back as soon as that read changes the word). */
export const YOUTUBE_STATUS_STEADY_EVERY_MS = 5 * 60_000 - 5_000;

/** What the claim hands the read: the session's org, and what to ask YouTube about. `live_stream_id` is null when the broadcast never
 *  bound a key (then there is no stream to ask about, and a live broadcast says nothing: no evidence). */
type Claimed = { org_id: string; connection_id: string; yt_broadcast_id: string | null; live_stream_id: string | null };

/** The read's gates AND its claim, in ONE conditional UPDATE (the shape of `claimIngestPoll`, V428): a LIVE session that names a
 *  broadcast, went live at least FIRST_READ_AFTER ago, and was last claimed at least one WINDOW ago (or never) - the fast window, or
 *  the steady one once `youtube_status_steady` has reached the threshold. Postgres re-checks the WHERE of a concurrent UPDATE against
 *  what the winner committed, so a poll and a cron firing racing on one session claim it ONCE. Not an advisory lock - that would be
 *  held across calls to YouTube. A failed read keeps its claim: an outage is not hammered by every poll. A session before its first
 *  read is not claimed at all (the stamp would eat the first window). The clock is `deps.now()` - the same one that stamped `live_at`. */
async function claim(sessionId: string, now: Date): Promise<Claimed | null> {
  const fastCut = new Date(now.getTime() - YOUTUBE_STATUS_READ_EVERY_MS);
  const steadyCut = new Date(now.getTime() - YOUTUBE_STATUS_STEADY_EVERY_MS);
  const [row] = await sql<Claimed[]>`
    update fixture_stream_sessions s set youtube_status_read_at = ${now}
      from youtube_broadcasts b
      left join youtube_stream_keys k on k.id = b.key_id
     where s.id = ${sessionId}
       and b.id = s.youtube_broadcast_id
       and s.state = 'live'
       and s.live_at is not null and s.live_at <= ${new Date(now.getTime() - YOUTUBE_STATUS_FIRST_READ_AFTER_MS)}
       and (s.youtube_status_read_at is null
            or s.youtube_status_read_at <= case when s.youtube_status_steady >= ${YOUTUBE_STATUS_STEADY_AFTER_READS}
                                                then ${steadyCut}::timestamptz else ${fastCut}::timestamptz end)
    returning s.org_id, b.connection_id, b.yt_broadcast_id, k.live_stream_id`;
  return row ?? null;
}

/** What YouTube said: the broadcast's RAW life cycle (`lifeCycle`: `liveStarting` is not `live`), and its stream's status when the
 *  broadcast was live (null: not asked, or no stream to ask). */
type Seen = { lifeCycle: LifeCycle | "absent"; stream: StreamStatusInfo | null };

/** One read of YouTube for a claimed session: the broadcast's life and, only when that is live, its stream's status. Throws what
 *  the port or the token store throws - the caller carries the previous word, except for a dead grant (which it clears). A broadcast
 *  that is not live needs no stream read (one quota unit saved, and its word does not depend on the stream). */
async function ask(c: Claimed, deps: SessionDeps): Promise<Seen | null> {
  if (c.yt_broadcast_id === null) return null;   // a broadcast YouTube never made: nothing to ask
  const port = youtubeOf(deps);
  const refresh = await openToken(sql, c.org_id, c.connection_id);
  // No token: the connection is revoked (V479: a revoked row is exactly the row with none). Nothing to read with, and nothing will
  // ever refresh the word - a dead grant, said the way Google says it, so ONE branch handles both.
  if (refresh === null) throw new YouTubeError("youtube_reconnect_needed", "noGrant");
  const at = await port.accessToken(refresh);
  const { lifeCycle } = await port.broadcastLife(at, c.yt_broadcast_id);
  if (lifeCycle !== "live") return { lifeCycle, stream: null };
  return { lifeCycle, stream: c.live_stream_id === null ? null : await port.streamStatus(at, c.live_stream_id) };
}

type Locked = { state: string; youtube_status: YoutubeLiveWord | null; youtube_status_steady: number };
const lockSession = async (tx: Tx, sessionId: string): Promise<Locked | undefined> =>
  (await tx<Locked[]>`select state, youtube_status, youtube_status_steady from fixture_stream_sessions where id = ${sessionId} for update`)[0];

/** Record one read's word: the run of `live_receiving` reads, always; and, when the word CHANGED, the event - the event and the stored
 *  word in one transaction, under the session's row lock. Re-decided on the LOCKED row: a Stop that landed while YouTube was being
 *  asked leaves a session this no longer applies to (the word is for a live one), and a word that already is `word` writes no event. */
async function record(sessionId: string, orgId: string, word: YoutubeLiveWord, seen: Seen, now: Date): Promise<void> {
  await sql.begin(async (tx) => {
    const locked = await lockSession(tx, sessionId);
    if (!locked || locked.state !== "live") return;
    if (locked.youtube_status !== word) {
      await recordEvent(tx, {
        sessionId, orgId, source: "output", kind: "observed", type: "youtube_status", from: locked.youtube_status, to: word, occurredAt: now,
        // The RAW life cycle, so a `not_live` that is a broadcast still `liveStarting` says so in the capture.
        payload: {
          broadcastLife: seen.lifeCycle,
          ...(seen.stream ? { streamStatus: seen.stream.status, ...(seen.stream.health ? { healthStatus: seen.stream.health } : {}) } : {}),
        },
      });
    }
    // The run: one more `live_receiving` (capped - the claim only asks "has it reached the threshold"), any other word zeroes it.
    const steady = word === "live_receiving" ? Math.min(locked.youtube_status_steady + 1, YOUTUBE_STATUS_STEADY_AFTER_READS) : 0;
    await tx`update fixture_stream_sessions set youtube_status = ${word}, youtube_status_steady = ${steady} where id = ${sessionId}`;
  });
}

/** A dead grant: the stored word (if any) is no longer the truth. ONE event (word -> null) and the word cleared, in one transaction
 *  under the row lock; a session with no word has nothing to clear and records nothing (the claim keeps the quiet reads quiet). */
async function clearWord(sessionId: string, orgId: string, now: Date): Promise<void> {
  await sql.begin(async (tx) => {
    const locked = await lockSession(tx, sessionId);
    if (!locked || locked.state !== "live" || locked.youtube_status === null) return;
    await recordEvent(tx, {
      sessionId, orgId, source: "output", kind: "observed", type: "youtube_status", from: locked.youtube_status, to: null, occurredAt: now,
      payload: { reason: "reconnect_needed" },
    });
    await tx`update fixture_stream_sessions set youtube_status = null, youtube_status_steady = 0 where id = ${sessionId}`;
  });
}

/** What the session projection says (`youtubeStatus`): only a LIVE session has a status line. An API-backed session (`api_backed`:
 *  written once at admission, never changes) carries its stored word - null until the first read, and after the previous session's
 *  words never (a restart is a new row). A session on a YouTube target that is NOT api-backed streams to a pasted key: no API, so
 *  `pasted_key`. Anything else (another platform, an ended session) has nothing to say.
 *
 *  `liveForMs` is how long the session has been live, on THIS server's clock at this response (the shape of `output.elapsedMs`,
 *  current.ts: the browser's clock is never asked) - what the panel judges "still not live" on (lib/youtube.ts NOT_LIVE_WARN_MS).
 *  Only a stored word has one; null for no word, a pasted key, and a session with no `live_at`. */
export async function youtubeStatusOf(sessionId: string, state: string, targetKind: string, now: Date):
  Promise<{ status: YoutubeStatusView | null; liveForMs: number | null }> {
  const none = { status: null, liveForMs: null };
  if (state !== "live") return none;
  const [s] = await sql<{ api_backed: boolean; youtube_status: YoutubeLiveWord | null; live_at: Date | null }[]>`
    select api_backed, youtube_status, live_at from fixture_stream_sessions where id = ${sessionId}`;
  if (!s) return none;
  if (!s.api_backed) return { status: targetKind === "youtube" ? "pasted_key" : null, liveForMs: null };
  if (s.youtube_status === null) return none;
  return { status: s.youtube_status, liveForMs: s.live_at === null ? null : Math.max(0, now.getTime() - new Date(s.live_at).getTime()) };
}

/** One tick's status read for a session (called by `tickSession`, after the phone-lost ends and before the automatic stop). Never throws. */
export async function readYoutubeStatus(sessionId: string, deps: SessionDeps): Promise<void> {
  try {
    const now = deps.now();
    const claimed = await claim(sessionId, now);
    if (claimed === null) return;
    let seen: Seen | null;
    try {
      seen = await ask(claimed, deps);
    } catch (err) {
      if (isDeadGrantRefusal(err)) {
        await clearWord(sessionId, claimed.org_id, now);
        return;
      }
      // An API error, a quota refusal, an unreadable token: the previous word stands. Only the code is logged - never the error's text.
      log.warn({ sessionId, code: err instanceof YouTubeError ? err.code : err instanceof Error ? err.name : "unknown" },
        "youtube status: the read failed; the previous word is carried");
      return;
    }
    if (seen === null) return;
    const word = youtubeLiveWordOf(seen.lifeCycle, seen.stream);
    if (word === null) return;   // YouTube said nothing about video: no evidence, no word
    await record(sessionId, claimed.org_id, word, seen, now);
  } catch (err) {
    // The write (or the claim) failed: the status line is best-effort and must never fail a tick. Logged, and the next window retries.
    log.warn({ sessionId, err: err instanceof Error ? err.name : "unknown" }, "youtube status: could not record the read; the next window retries");
  }
}
