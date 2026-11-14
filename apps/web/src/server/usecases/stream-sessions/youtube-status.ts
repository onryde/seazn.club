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
//   * One read per YOUTUBE_STATUS_READ_EVERY_MS window however many panels and cron firings are looking, by a CLAIM (below).
//   * A CHANGE of word is ONE `youtube_status` event (source output, kind observed) written in the SAME transaction as the stored
//     word, under the session's row lock: neither half alone is safe to serve. A read that changes nothing writes nothing.
//   * An API error is NOT a word. Nor is an answer that says nothing (`youtubeLiveWordOf` -> null). Both carry the previous word and
//     record nothing: a status line that read an outage as "YouTube is receiving no video" would tell an organiser to go and fix a
//     phone that is fine. The read is also read-only on OUR side - a dead grant is not marked reconnect_needed here (the end step owns
//     that, and acts on a broadcast, not on a status line).
//   * A pasted key has no broadcast and so no claim, no call and no event (the projection says so: current.ts).
//   * The read never throws out of a tick: `failed` in the stream-tick pass counts ticks that threw, and a status line is not worth a
//     failed tick.
import { sql } from "@/lib/db";
import type { YoutubeLiveWord, YoutubeStatusView } from "@/lib/youtube";
import { log } from "@/server/logger";
import { recordEvent } from "@/server/relay/telemetry";
import { youtubeLiveWordOf } from "@/server/youtube/live-status";
import { YouTubeError, type BroadcastLife, type StreamStatusInfo } from "@/server/youtube/port";
import { openToken } from "@/server/youtube/token-store";
import { youtubeOf, type SessionDeps } from "./deps";

/** The first read of a session: this long after it went live (owner direction 2026-11-14: "first read 60 s after live_at"). */
export const YOUTUBE_STATUS_FIRST_READ_AFTER_MS = 60_000;

/** The claim window: one read of YouTube per session per this long, across every open panel and the cron. Under the 60 s of prod's
 *  every-minute stream tick (apps/cron-worker/src/schedule.ts), so the cron's firing always finds the window open - the same reason
 *  ingest-poll's window sits a second under its poll interval - and over the 5 s a panel polls, so an open panel is not a read per
 *  poll. Each read costs 2 quota units (liveBroadcasts.list + liveStreams.list) of the Cloud project's 10,000 a day, shared by every
 *  org: this window IS the quota bill (about 240 units for a two-hour match). */
export const YOUTUBE_STATUS_READ_EVERY_MS = 55_000;

/** What the claim hands the read: the session's org, the word it holds now, and what to ask YouTube about. `liveStreamId` is null when
 *  the broadcast never bound a key (then there is no stream to ask about, and a live broadcast says nothing: no evidence). */
type Claimed = { org_id: string; previous: YoutubeLiveWord | null; connection_id: string; yt_broadcast_id: string | null; live_stream_id: string | null };

/** The read's gates AND its claim, in ONE conditional UPDATE (the shape of `claimIngestPoll`, V428): a LIVE session that names a
 *  broadcast, went live at least FIRST_READ_AFTER ago, and was last claimed at least READ_EVERY ago (or never). Postgres re-checks
 *  the WHERE of a concurrent UPDATE against what the winner committed, so a poll and a cron firing racing on one session claim it
 *  ONCE. Not an advisory lock - that would be held across calls to YouTube. A failed read keeps its claim: an outage is not hammered
 *  by every poll. A session before its first read is not claimed at all (the stamp would eat the first window). The clock is
 *  `deps.now()` - the same one that stamped `live_at`. */
async function claim(sessionId: string, now: Date): Promise<Claimed | null> {
  const [row] = await sql<Claimed[]>`
    update fixture_stream_sessions s set youtube_status_read_at = ${now}
      from youtube_broadcasts b
      left join youtube_stream_keys k on k.id = b.key_id
     where s.id = ${sessionId}
       and b.id = s.youtube_broadcast_id
       and s.state = 'live'
       and s.live_at is not null and s.live_at <= ${new Date(now.getTime() - YOUTUBE_STATUS_FIRST_READ_AFTER_MS)}
       and (s.youtube_status_read_at is null or s.youtube_status_read_at <= ${new Date(now.getTime() - YOUTUBE_STATUS_READ_EVERY_MS)})
    returning s.org_id, s.youtube_status as previous, b.connection_id, b.yt_broadcast_id, k.live_stream_id`;
  return row ?? null;
}

/** What YouTube said: the broadcast's life, and its stream's status when the broadcast was live (null: not asked, or no stream to ask). */
type Seen = { life: BroadcastLife; stream: StreamStatusInfo | null };

/** One read of YouTube for a claimed session: the broadcast's life and, only when that is live, its stream's status. Throws what
 *  the port or the token store throws - the caller carries the previous word. A broadcast that is not live needs no stream read (one
 *  quota unit saved, and its word does not depend on the stream). */
async function ask(c: Claimed, deps: SessionDeps): Promise<Seen | null> {
  if (c.yt_broadcast_id === null) return null;   // a broadcast YouTube never made: nothing to ask
  const port = youtubeOf(deps);
  const refresh = await openToken(sql, c.org_id, c.connection_id);
  if (refresh === null) return null;             // no grant to read with (revoked, or sealed under another key): not evidence
  const at = await port.accessToken(refresh);
  const { life } = await port.broadcastLife(at, c.yt_broadcast_id);
  if (life !== "live") return { life, stream: null };
  return { life, stream: c.live_stream_id === null ? null : await port.streamStatus(at, c.live_stream_id) };
}

/** Record a change of word: the event and the stored word, one transaction, under the session's row lock. Re-decided on the LOCKED
 *  row: a Stop that landed while YouTube was being asked leaves a session this no longer applies to (the word is for a live one), and
 *  a word that already is `word` writes nothing. */
async function record(sessionId: string, orgId: string, word: YoutubeLiveWord, seen: Seen, now: Date): Promise<void> {
  await sql.begin(async (tx) => {
    const [locked] = await tx<{ state: string; youtube_status: YoutubeLiveWord | null }[]>`
      select state, youtube_status from fixture_stream_sessions where id = ${sessionId} for update`;
    if (!locked || locked.state !== "live" || locked.youtube_status === word) return;
    await recordEvent(tx, {
      sessionId, orgId, source: "output", kind: "observed", type: "youtube_status", from: locked.youtube_status, to: word, occurredAt: now,
      payload: {
        broadcastLife: seen.life,
        ...(seen.stream ? { streamStatus: seen.stream.status, ...(seen.stream.health ? { healthStatus: seen.stream.health } : {}) } : {}),
      },
    });
    await tx`update fixture_stream_sessions set youtube_status = ${word} where id = ${sessionId}`;
  });
}

/** What the session projection says (`youtubeStatus`): only a LIVE session has a status line. An API-backed session (`api_backed`:
 *  written once at admission, never changes) carries its stored word - null until the first read, and after the previous session's
 *  words never (a restart is a new row). A session on a YouTube target that is NOT api-backed streams to a pasted key: no API, so
 *  `pasted_key`. Anything else (another platform, an ended session) has nothing to say. */
export async function youtubeStatusOf(sessionId: string, state: string, targetKind: string): Promise<YoutubeStatusView | null> {
  if (state !== "live") return null;
  const [s] = await sql<{ api_backed: boolean; youtube_status: YoutubeLiveWord | null }[]>`
    select api_backed, youtube_status from fixture_stream_sessions where id = ${sessionId}`;
  if (!s) return null;
  if (s.api_backed) return s.youtube_status;
  return targetKind === "youtube" ? "pasted_key" : null;
}

/** One tick's status read for a session (called by `tickSession`, after the phone-lost ends and before the automatic stop). Never throws. */
export async function readYoutubeStatus(sessionId: string, deps: SessionDeps): Promise<void> {
  try {
    const now = deps.now();
    const claimed = await claim(sessionId, now);
    if (claimed === null) return;
    const seen = await ask(claimed, deps).catch((err: unknown) => {
      // An API error, a dead token, an unreadable one: the previous word stands. Only the code is logged - never the error's text.
      log.warn({ sessionId, code: err instanceof YouTubeError ? err.code : err instanceof Error ? err.name : "unknown" },
        "youtube status: the read failed; the previous word is carried");
      return null;
    });
    if (seen === null) return;
    const word = youtubeLiveWordOf(seen.life, seen.stream);
    if (word === null) return;   // YouTube said nothing about video: no evidence, no word
    await record(sessionId, claimed.org_id, word, seen, now);
  } catch (err) {
    // The write (or the claim) failed: the status line is best-effort and must never fail a tick. Logged, and the next window retries.
    log.warn({ sessionId, err: err instanceof Error ? err.name : "unknown" }, "youtube status: could not record the read; the next window retries");
  }
}
