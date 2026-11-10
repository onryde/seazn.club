import "server-only";
// The coalesced ingest read: poll sample, D3's since, the claim window, carried words (see ./index.ts).
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import type { Command, Session } from "@/server/relay/domain/session";
import type { IngestProtocol, IngestState, OutputState } from "@/server/relay/ports";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";

/** The latest POLL sample — the one row the poll compares a new reading against (Ruling 13) and, for G-a, the phone's
 *  previous reading. Read from the DB, not from process memory, so a carry survives a restart and any number of
 *  processes. Undefined before any poll has recorded one. */
export async function latestPollSample(sessionId: string): Promise<PollSample | undefined> {
  const [prev] = await sql<PollSample[]>`
    select ingest_state, output_state, sampled_at, raw->>'protocol' as protocol
      from fixture_stream_samples where session_id = ${sessionId} and source = 'poll' order by id desc limit 1`;
  return prev;
}
type PollSample = { ingest_state: string | null; output_state: string | null; sampled_at: Date; protocol: string | null };

/** D3's `since` as ONE SQL expression — the rule `currentSession` explains above its use: the first ingest_status event
 *  after the last one on the other side of ok, clamped to `live_at` and, for a non-ok word, to the phone's latest
 *  reconnect. `ok` says which side of ok the timed word is on: a literal for a poll that READ, or the sample's own column
 *  for a coalesced poll, so one rule serves both and the coalesced word and its since share a statement (I-1). */
export function outputSinceExpr(sessionId: string, ok: boolean | postgres.Fragment): postgres.Fragment {
  return sql`greatest(
    (select occurred_at from fixture_stream_events
      where session_id = ${sessionId} and type = 'ingest_status'
        and seq > coalesce((select max(seq) from fixture_stream_events
                             where session_id = ${sessionId} and type = 'ingest_status'
                               and (coalesce(payload->>'outputState', '') = 'ok') <> ${ok}), 0)
      order by seq asc limit 1),
    (select live_at from fixture_stream_sessions where id = ${sessionId}),
    (select max(occurred_at) from fixture_stream_events
      where not ${ok} and session_id = ${sessionId} and type = 'ingest_status'
        and to_state = 'connected' and coalesce(from_state, '') <> 'connected'))`;
}

/** B0 fix round 1 (I-1): a coalesced poll's whole reading — the latest poll sample AND D3's `since` for its word — in ONE
 *  statement, so ONE snapshot. Read in two (the sample at the top of currentSession, the events several statements
 *  later), a reading poll's sample-and-event commit (R-1) landing between them served the OLD word timed by the NEW
 *  event: `since` fell back to live_at and the stream-key box flashed. A statement sees one snapshot under any isolation
 *  level, so nothing here depends on the transaction mode. */
export async function latestPollSampleWithSince(sessionId: string): Promise<(PollSample & { since: Date | null }) | undefined> {
  const [s] = await sql<(PollSample & { since: Date | null })[]>`
    select p.ingest_state, p.output_state, p.sampled_at, p.raw->>'protocol' as protocol,
           ${outputSinceExpr(sessionId, sql`coalesce(p.output_state = 'ok', false)`)} as since
      from (select ingest_state, output_state, sampled_at, raw from fixture_stream_samples
             where session_id = ${sessionId} and source = 'poll' order by id desc limit 1) p`;
  return s;
}

/** I-1 (final review; controller ruling 2026-10-01): coalesce the organiser poll's Cloudflare reads ACROSS tabs, viewers
 *  and processes. Every open organiser fixture page polls `current` every STREAM_POLL_MS, and each poll read the input
 *  and its outputs: N tabs were N × 2 reads per 5 s against Cloudflare's account-wide API limit, and past that limit
 *  every read 429s — so no poll could observe warming → live, and the D3 box went silent.
 *
 *  The mechanism is a CONDITIONAL WRITE (V428): a poll claims the read by stamping `ingest_polled_at`, and only when the
 *  previous claim is at least POLL_CLAIM_WINDOW_MS old. Postgres re-checks the WHERE of a concurrent UPDATE against the row
 *  the winner committed, so two polls racing on one session claim it ONCE: the loser gets no row back and reads nothing.
 *  Not an advisory lock: the lock would have to be held across the two Cloudflare calls, which carry no timeout, so a
 *  slow provider would pin a pooled connection per session. A claim also coalesces the reads that FAIL (a 429 or a 5xx
 *  records no sample), which is the storm this exists to stop. The clock is deps.now(), the poll's own clock. */
export async function claimIngestPoll(sessionId: string, now: Date): Promise<boolean> {
  const claimed = await sql<{ id: string }[]>`
    update fixture_stream_sessions set ingest_polled_at = ${now}
     where id = ${sessionId}
       and (ingest_polled_at is null or ingest_polled_at <= ${new Date(now.getTime() - POLL_CLAIM_WINDOW_MS)})
    returning id`;
  return claimed.length === 1;
}

/** I-1 window (controller ruling 2026-10-01: "under 5 s" meant coalescing CONCURRENT viewers, not a hard number). A lone
 *  tab polls on STREAM_POLL_MS by setInterval, so its next request lands about one interval after its own claim, give or
 *  take timer and network jitter; with the window AT the interval, a request even 1 ms early was served the previous
 *  reading and the lone viewer's Cloudflare cadence halved to 10 s. A second of allowance keeps every on-cadence poll a
 *  read while polls from other tabs inside it still coalesce. */
const POLL_JITTER_ALLOWANCE_MS = 1_000;
const POLL_CLAIM_WINDOW_MS = STREAM_POLL_MS - POLL_JITTER_ALLOWANCE_MS;

/** I-1: how old the latest poll sample may be for a poll that did NOT claim the read to answer from it — one poll
 *  interval behind the claim it deferred to (whose own sample may still be in flight). Older than that is not this
 *  poll's reading, and serving it would present a stale word as current: such a poll answers like a failed read
 *  (ingest and output null) and decides nothing. */
export const COALESCED_SAMPLE_MAX_AGE_MS = 2 * STREAM_POLL_MS;

/** I-1: the stored words of a poll sample, each guarded to its port type (the poll writes only those). */
export function sampledOutput(w: string | null): OutputState | null {
  return w === "ok" || w === "connecting" || w === "rejected" || w === "unknown" ? w : null;
}
export function sampledProtocol(w: string | null): IngestProtocol | null {
  return w === "srt" || w === "rtmps" ? w : null;
}

/** G-a (controller ruling 2026-10-01): the word a no-evidence read (ports.ts IngestStatus.state null) carries forward —
 *  the latest poll sample's. Null when there is none; and a stored word outside the port's three is a guard, not a
 *  carry: the poll writes only those three, so anything else is not a reading this code can vouch for. */
export function carriedIngest(prev: { ingest_state: string | null } | undefined): IngestState | null {
  const w = prev?.ingest_state ?? null;
  return w === "connected" || w === "disconnected" || w === "unknown" ? w : null;
}

/** N1: an ingest status read that threw — reported ONCE per failed read (Sentry + a log line), never thrown at the reader.
 *  Names the session and the input uid (not a secret, Dg); never a URL or key. `site` says which read: the expiry's
 *  observation or the organiser's poll. */
export function reportIngestReadFailure(err: unknown, extra: { sessionId: string; orgId: string; inputUid: string; site: "expiry" | "poll" }): void {
  captureError(err, { orgId: extra.orgId, route: "relay.ingest_status", extra: { sessionId: extra.sessionId, inputUid: extra.inputUid, site: extra.site } });
  log.warn({ ...extra, err: String(err) }, "stream session: the ingest status read failed — reported; the read answers without it and the next one retries (a warming timeout is held until the ingest can be seen)");
}

/** `ingest_connected` as a T5-a command function: only a passthrough session still `warming` on the LOCKED row goes live
 *  on an observed connection; a row that moved on (stopped, expired, already live) writes nothing. Both observers use it:
 *  the expiry's (I1, above) and the organiser's poll (m1). */
export function connectIfWarming(s: Session): Command | null {
  return s.mode === "passthrough" && s.state === "warming" ? { type: "ingest_connected" } : null;
}
