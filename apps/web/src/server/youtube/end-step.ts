import "server-only";
// server/youtube/end-step.ts — YouTube Connect T14: the END STEP (spec §6.4 "Races", §6.6, §6.7; plan T14 with owner D15, the
// post-T1 amendment, P4, P6, R5; the controller's carry-ins). It claims the YouTube broadcasts that are due, ends them at YouTube
// (`complete`, or a delete for one that never went live), finalizes the row, writes the replay URL, and retries a failure with
// backoff. T15's stream-tick route calls `endDueBroadcasts` first on every firing.
//
// Per candidate, in THREE separate steps — no row or advisory lock is ever held across a YouTube call (global-constraints):
//   1. CLAIM  (one short tx). The row is locked `for update skip locked` and the candidate rule is RE-CHECKED under the lock (a firing
//      that listed it before another claimed it must not trust its list). An `ending` row is a retry (a crashed claim, or a row
//      admission's P7 claimed). An ORPHAN is claimed with orphan intent. Anything else asks the end rule (end-rule.ts) under the lock;
//      not due → commit, next. Due → `state = 'ending', claimed_at = now`. Every claim also LEASES the row: next_attempt_at =
//      now + 2 min. The lease is what makes two overlapping firings call YouTube once — `skip locked` only covers the claim's own
//      transaction, and the claim commits BEFORE the call, so a second firing would otherwise find a plain `ending` row and retry
//      it (spec §6.4: "a crash between leaves a claimed row the next tick retries" — the lease is how "next tick" is told apart
//      from "the call is in flight"). A crash is retried once the lease lapses; a failure replaces it with the backoff.
//   2. CALL   (no lock). An access token from the sealed refresh token, then `broadcastLife`. `ready` / `created` / `absent`, or an
//      orphan → `deleteBroadcast` → the row fails (`never_live` / `orphan`). `live` / `testing` → `complete`. `complete` → nothing
//      to call. `revoked` (Google: "removed by an administrator action" — the BROADCAST is gone, not the channel's grant) → nothing to
//      call and nothing a reconnect could change: the row fails `broadcast_revoked`, the connection is left exactly as it was.
//   3. FINALIZE (one statement). `update … where id and state = 'ending'` — finalize never moves any other state, so it cannot
//      resurrect a row something else has settled. Once it has moved a row to `complete`, the replay URL goes through
//      `setFixtureStreamUrl`, only when the fixture has no link of its own.
//
// ORPHANS (P4, the controller's binding predicate). An orphan is a broadcast NO SESSION REFERENCES that is older than 10 minutes — not
// a list of states. That one predicate covers a `created`/`bound` row nobody ever streamed into, a `created` row with a key but no
// YouTube id (a crash between the insert and the fail), a reused `bound`/`live` row whose only session failed provisioning (the FK
// nulled `last_session_id` and the session is gone), a lapsed `reserved` row, and an `ending` row prepare claimed on another channel.
// A reservation still held (`reserved_until > now`) is an admission in progress and is never an orphan. An orphan with no
// `yt_broadcast_id` is finalized `failed` with NO YouTube call; with one it is deleted at YouTube first.
//
// FAILURES (R5). Every error code, `youtube_reconnect_needed` included: `attempts + 1`, `next_attempt_at = now + min(2^(attempts-1), 60)
// minutes` (1, 2, 4, … 60: P6), `last_error_code` = OUR code (V479's `[a-z_:]{1,64}`), never Google's camelCase reason. The row stays
// `ending` (or its open state when the claim itself failed). `youtube_reconnect_needed` also moves the connection to
// `reconnect_needed` (token-store's writer) and is not counted `failed` — a known state; a reconnect clears the backoff (T8). A
// connection in `reconnect_needed` is still a candidate: retried with backoff, never skipped. An error on one broadcast never stops
// the pass — an EndRuleInvariantError (end-rule.ts: a broken fact the rule refuses to answer from) included — it is caught PER
// broadcast, reported, and the row backs off.
//
// The `complete` call is bounded (the controller's errorStreamInactive ruling): after the 5th failure of a row, a failed `complete`
// re-reads the broadcast's life; a broadcast no longer live is settled by its life (deleted/absent/ready → never_live, complete →
// complete) instead of being retried forever; one still live keeps its backoff.
//
// LOCK ORDER. T8's reconnect locks the connection row and THEN broadcast rows (connections.ts). No transaction here holds both: the
// claim locks only the broadcast row (the connection is read, unlocked, in the candidate and claim predicates), and the connection
// status moves in its own statement after the claim has committed. So the two orders cannot invert into a deadlock.
//
// SECRETS. A token, a stream key and a Google body never reach a log line, an error or a row: a port refusal is a CODE (port.ts),
// the sealed refresh token is opened in memory for one call, and what is reported carries ids only.
import { sql, type Tx } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { youtubeWatchUrl } from "@/lib/youtube";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setFixtureStreamUrl } from "@/server/usecases/fixtures";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { EndRuleInvariantError, broadcastEndDueAt, readEndFacts } from "./end-rule";
import { YouTubeError, type BroadcastLifeInfo, type YouTubePort } from "./port";
import { YoutubeTokenUnreadableError, markReconnectNeeded, openToken } from "./token-store";

export type YoutubeEndResult = { ended: number; neverLive: number; orphans: number; failed: number; deferred: number };

/** The step's own wall-clock slice of the stream tick's 45 s (T15 passes it). */
export const YOUTUBE_END_BUDGET_MS = 15_000;

/** Test seam only: called between the claim's commit and the YouTube call. */
export type EndStepHooks = { afterClaim?: (broadcastId: string) => Promise<void> };

/** Spec §6.2: an orphan `created` broadcast older than this is cleaned by the tick (P4). */
const ORPHAN_AFTER_MINUTES = 10;
/** How long a claim holds its row against another firing. A call is bounded by google.ts's 10 s request timeout × five calls, so
 *  two minutes outlasts a healthy pass and a crashed one is retried on the next firing after it. */
const CLAIM_LEASE_MINUTES = 2;
/** The 5th failure of a row: a failed `complete` re-reads the life (see the header). */
const COMPLETE_FAILURES_BEFORE_REREAD = 5;

/** Open states: a broadcast the step may still have to end. `complete` and `failed` are finished. */
const OPEN_STATES = ["created", "bound", "reserved", "live", "ending"] as const;

const MINUTE_MS = 60_000;
const plusMinutes = (at: Date, n: number): Date => new Date(at.getTime() + n * MINUTE_MS);

/** Our codes for what is not a port refusal. Each matches V479's `[a-z_:]{1,64}` shape check. */
const CODE_INVARIANT = "end_rule_invariant";
const CODE_TOKEN_MISSING = "youtube_token_missing";
const CODE_TOKEN_UNREADABLE = "youtube_token_unreadable";
const CODE_UNEXPECTED = "end_step_error";
const CODE_NEVER_LIVE = "never_live";
const CODE_ORPHAN = "orphan";
const CODE_REVOKED = "broadcast_revoked";

/** A failure with a code of ours and nothing else to say (no token, no body). */
class EndStepCodeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EndStepCodeError";
  }
}

interface Candidate { id: string; org_id: string; connection_id: string }
interface Claimed {
  id: string; org_id: string; connection_id: string; fixture_id: string; yt_broadcast_id: string | null; attempts: number;
  intent: "end" | "orphan";
}

type Outcome =
  | { kind: "complete"; startedAt: Date | null; endedAt: Date | null }
  | { kind: "failed"; code: typeof CODE_NEVER_LIVE | typeof CODE_ORPHAN | typeof CODE_REVOKED };
type Tag = "ended" | "neverLive" | "orphan" | "failed" | "reconnect" | "none";

/** What a report names: the row, never a fact from it. */
type Reportable = { id: string; org_id: string };

/** A port call. Whatever it throws becomes a YouTubeError: a driver maps Google's answers already, and anything else it lets
 *  through (it should not) is YouTube not answering. The original is dropped, never wrapped: it may hold what must not be kept.
 *  It is REPORTED, though — a driver bug that backs off forever must not be silent — as a fresh error that names only the original's
 *  class and the broadcast's id. */
async function viaPort<T>(call: () => Promise<T>, row: Reportable): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof YouTubeError) throw err;
    const kind = (err instanceof Error ? err.name : typeof err).replace(/[^A-Za-z]/g, "").slice(0, 64);
    captureError(new Error(`youtube end step: a port call raised a non-port error (${kind})`), {
      orgId: row.org_id, route: "youtube.end_step.port", extra: { broadcastId: row.id },
    });
    throw new YouTubeError("youtube_unavailable");
  }
}

/** The broadcast ids the step might act on, oldest first. A non-revoked connection (`reconnect_needed` included: retried with backoff,
 *  never skipped); an open state; not backed off or leased. `orgIds` is test-only. */
async function candidatesOf(now: Date, orgIds: readonly string[] | undefined): Promise<Candidate[]> {
  return sql<Candidate[]>`
    select b.id, b.org_id, b.connection_id
      from youtube_broadcasts b
      join org_youtube_connections c on c.id = b.connection_id and c.org_id = b.org_id
     where b.state in ${sql([...OPEN_STATES])}
       and (b.next_attempt_at is null or b.next_attempt_at <= ${now})
       and c.status <> 'revoked'
       ${orgIds ? sql`and b.org_id in ${sql(orgIds)}` : sql``}
     order by b.created_at, b.id`;
}

/** Step 1. null: not this firing's (locked by another, backed off or leased meanwhile, no longer open, or not due). */
async function claim(c: Candidate, now: Date): Promise<Claimed | null> {
  return sql.begin(async (tx: Tx) => {
    // `skip locked`: a row another firing (or an admission) holds is that one's. The candidate rule is re-read under the lock.
    const [row] = await tx<{
      id: string; org_id: string; connection_id: string; fixture_id: string; state: string; yt_broadcast_id: string | null; attempts: number;
      orphan: boolean;
    }[]>`
      select b.id, b.org_id, b.connection_id, b.fixture_id, b.state, b.yt_broadcast_id, b.attempts,
             (b.created_at < ${plusMinutes(now, -ORPHAN_AFTER_MINUTES)}
              and not exists (select 1 from fixture_stream_sessions s where s.youtube_broadcast_id = b.id)
              and (b.reserved_until is null or b.reserved_until <= ${now})) as orphan
        from youtube_broadcasts b
       where b.id = ${c.id} and b.org_id = ${c.org_id}
         and b.state in ${tx([...OPEN_STATES])}
         and (b.next_attempt_at is null or b.next_attempt_at <= ${now})
         and exists (select 1 from org_youtube_connections k where k.id = b.connection_id and k.org_id = b.org_id and k.status <> 'revoked')
         for update skip locked`;
    if (!row) return null;
    const lease = plusMinutes(now, CLAIM_LEASE_MINUTES);
    const claimed: Claimed = {
      id: row.id, org_id: row.org_id, connection_id: row.connection_id, fixture_id: row.fixture_id, yt_broadcast_id: row.yt_broadcast_id,
      attempts: row.attempts, intent: row.orphan ? "orphan" : "end",
    };
    if (row.state === "ending") {
      // A retry: a crashed claim past its lease, or a row admission claimed (P7; no lease on it). Take the lease.
      await tx`update youtube_broadcasts set next_attempt_at = ${lease} where id = ${row.id}`;
      return claimed;
    }
    if (!row.orphan) {
      // May throw EndRuleInvariantError: the caller handles it per broadcast (the tx rolls back, nothing was changed).
      const due = broadcastEndDueAt(await readEndFacts(tx, row.id), now);
      if (due === null || due.getTime() > now.getTime()) return null;
    }
    await tx`
      update youtube_broadcasts
         set state = 'ending', claimed_at = ${now}, reserved_until = null, next_attempt_at = ${lease}
       where id = ${row.id}`;
    return claimed;
  });
}

/** Step 2: what YouTube says and does. Throws on a refusal; the caller records it. */
async function callYouTube(port: YouTubePort, row: Claimed): Promise<Outcome> {
  const orphan = row.intent === "orphan";
  const ytId = row.yt_broadcast_id;
  // Nothing was ever made at YouTube for this row: there is nothing to ask. (An `ending` row with a session is never in this state:
  // admission's attach needs the id.) It finalizes failed — never `complete`, which V479's complete_has_facts would refuse forever.
  if (ytId === null) return { kind: "failed", code: orphan ? CODE_ORPHAN : CODE_NEVER_LIVE };

  const refresh = await openToken(sql, row.org_id, row.connection_id);
  if (refresh === null) throw new EndStepCodeError(CODE_TOKEN_MISSING);
  const at = await viaPort(() => port.accessToken(refresh), row);
  if (orphan) {
    await viaPort(() => port.deleteBroadcast(at, ytId), row);
    return { kind: "failed", code: CODE_ORPHAN };
  }
  const info = await viaPort(() => port.broadcastLife(at, ytId), row);
  const settled = await settleNotLive(port, at, row, ytId, info);
  if (settled) return settled;
  // live | testing: end it.
  try {
    await viaPort(() => port.complete(at, ytId), row);
  } catch (err) {
    const rest = await rereadAfterFailure(port, at, row, ytId);
    if (rest) return rest;
    throw err;
  }
  return completedTimes(port, at, row, ytId, info);
}

/** What a life that is NOT live says to do; null for `live` / `testing` (the caller ends those). */
async function settleNotLive(port: YouTubePort, at: string, row: Reportable, ytId: string, info: BroadcastLifeInfo): Promise<Outcome | null> {
  switch (info.life) {
    case "revoked":
      // YouTube removed the broadcast (an administrator action — Google's definition of `revoked`). Terminal and nothing to ask: no
      // complete, no delete, and no reconnect prompt (the channel's grant is fine; a reconnect would clear the backoff and read
      // `revoked` again). The row fails and, like any failed row, frees its key.
      return { kind: "failed", code: CODE_REVOKED };
    case "created":
    case "ready":
    case "absent":
      await viaPort(() => port.deleteBroadcast(at, ytId), row);   // never went live: nothing to replay (a delete of an absent one resolves)
      return { kind: "failed", code: CODE_NEVER_LIVE };
    case "complete":
      return { kind: "complete", startedAt: info.actualStartAt, endedAt: info.actualEndAt };
    case "live":
    case "testing":
      return null;
  }
}

/** After `complete` succeeds: YouTube's actual times. The transition's response does not say (the port's `complete` returns nothing and
 *  the driver asks for `part=status` only), so ONE `liveBroadcasts.list` (1 quota unit) reads both. Informational: a failed read, or a
 *  time YouTube leaves out, is null and never keeps the broadcast from finishing. */
async function completedTimes(port: YouTubePort, at: string, row: Reportable, ytId: string, before: BroadcastLifeInfo): Promise<Outcome> {
  try {
    const after = await viaPort(() => port.broadcastLife(at, ytId), row);
    return { kind: "complete", startedAt: after.actualStartAt ?? before.actualStartAt, endedAt: after.actualEndAt };
  } catch (err) {
    // Reported, not swallowed: the row completes without its end time and nothing will fetch it later. `err` is a YouTubeError here
    // (viaPort makes it one): a code, never a body.
    captureError(err, { orgId: row.org_id, route: "youtube.end_step.actual_times", extra: { broadcastId: row.id } });
    return { kind: "complete", startedAt: before.actualStartAt, endedAt: null };
  }
}

/** The bounded retry: from the 5th failure of a row, a failed `complete` re-reads the life. null → keep backing off (the broadcast is
 *  still live, or the re-read itself failed: the original failure stands). */
async function rereadAfterFailure(port: YouTubePort, at: string, row: Claimed, ytId: string): Promise<Outcome | null> {
  if (row.attempts + 1 < COMPLETE_FAILURES_BEFORE_REREAD) return null;
  let info: BroadcastLifeInfo;
  try {
    info = await viaPort(() => port.broadcastLife(at, ytId), row);
  } catch {
    return null;
  }
  return settleNotLive(port, at, row, ytId, info);
}

/** The replay URL (spec §6.4, "Part 1" rule): `fixtures.stream_url` takes the watch URL only while it is null — a club's own link wins,
 *  and a later part never replaces an earlier one. Written through the ONE stream-link path (`setFixtureStreamUrl`: validation,
 *  tenant scope, revalidation) as `fillReplayUrl`'s actor: the last session's creator, or — when `last_session_id` was nulled by a session
 *  delete — the connection's. When the link is already taken (a later part, or the club's own) nothing is written, but the public match
 *  page's parts list just grew, so the division's pages are expired here instead (T16). Best effort, and AFTER the row is complete: the parts list reads the complete rows themselves, so a link that could not
 *  be written (or a crash between the two) costs only the back-compat link, and a failure here must never leave an `ending` row
 *  holding its key for good. */
async function writeReplayUrl(row: Claimed, ytId: string): Promise<void> {
  try {
    const [r] = await sql<{ stream_url: string | null; actor: string; division_id: string; competition_id: string }[]>`
      select f.stream_url, coalesce(s.created_by, c.created_by) as actor, f.division_id, d.competition_id
        from youtube_broadcasts b
        join fixtures f on f.id = b.fixture_id
        join divisions d on d.id = f.division_id
        join org_youtube_connections c on c.id = b.connection_id and c.org_id = b.org_id
        left join fixture_stream_sessions s on s.id = b.last_session_id
       where b.id = ${row.id} and b.org_id = ${row.org_id}`;
    if (!r) return;
    if (r.stream_url !== null) {
      // The link is taken (Part 1's, or the club's own), so there is nothing to write - but this completion still changed what the public
      // match page lists: the part is a new row in the parts view. Writing the link is what used to expire the page (through
      // `setFixtureStreamUrl`), so a later part must expire it itself or it shows up only when the cache window runs out.
      fireDivisionRevalidate(r.division_id, r.competition_id);
      return;
    }
    const actor: AuthCtx = { orgId: row.org_id, via: "session", userId: r.actor, role: "owner", keyId: null };
    await setFixtureStreamUrl(actor, row.fixture_id, youtubeWatchUrl(ytId));
  } catch (err) {
    captureError(err, { orgId: row.org_id, route: "youtube.end_step.replay_url", extra: { broadcastId: row.id } });
  }
}

/** Step 3. True when this call moved the row (it was still `ending`). Then, and only then, the replay link: a row something else
 *  settled in between is not this step's to announce. */
async function finalize(row: Claimed, outcome: Outcome, now: Date): Promise<boolean> {
  const done = outcome.kind === "complete";
  const rows = await sql<{ id: string }[]>`
    update youtube_broadcasts
       set state = ${done ? "complete" : "failed"}, completed_at = ${now}, reserved_until = null, next_attempt_at = null,
           last_error_code = ${done ? null : outcome.code},
           actual_start_at = ${done ? outcome.startedAt : null}, actual_end_at = ${done ? outcome.endedAt : null}
     where id = ${row.id} and org_id = ${row.org_id} and state = 'ending'
    returning id`;
  if (rows.length !== 1) return false;
  if (done && row.yt_broadcast_id !== null) await writeReplayUrl(row, row.yt_broadcast_id);
  return true;
}

/** The code a failure is stored under: a port refusal's own code, or one of ours. Never Google's reason, never a message. */
function codeOf(err: unknown): string {
  if (err instanceof YouTubeError) return err.code;
  if (err instanceof EndStepCodeError) return err.code;
  if (err instanceof EndRuleInvariantError) return CODE_INVARIANT;
  if (err instanceof YoutubeTokenUnreadableError) return CODE_TOKEN_UNREADABLE;
  return CODE_UNEXPECTED;
}

/** Record a failure: `attempts + 1`, backoff 1, 2, 4, … 60 minutes (P6: `2^(attempts-1)` for the new count, so the first retry is a minute
 *  on), OUR code. Open states only — a row something else finished is left as it is. */
async function recordFailure(orgId: string, id: string, code: string, now: Date): Promise<void> {
  await sql`
    update youtube_broadcasts
       set attempts = attempts + 1,
           next_attempt_at = ${now}::timestamptz + (least(power(2, least(attempts, 10)), 60)::int * interval '1 minute'),
           last_error_code = ${code}
     where id = ${id} and org_id = ${orgId} and state in ${sql([...OPEN_STATES])}`;
}

/** One candidate, start to finish. Anything it throws is the caller's per-broadcast failure. */
async function endOne(port: YouTubePort, c: Candidate, o: { now: () => Date; hooks?: EndStepHooks }): Promise<Tag> {
  const now = o.now();
  const row = await claim(c, now);
  if (!row) return "none";
  await o.hooks?.afterClaim?.(row.id);
  const outcome = await callYouTube(port, row);
  const moved = await finalize(row, outcome, o.now());
  if (!moved) return "none";
  if (outcome.kind === "complete") return "ended";
  // `neverLive` counts every failed row that is not an orphan: it ran no replay (never live, or removed by YouTube).
  return outcome.code === CODE_ORPHAN ? "orphan" : "neverLive";
}

/** A failed broadcast: reported where it is ours to fix, the connection moved when the grant is dead, the row backed off. */
async function failOne(c: Candidate, err: unknown, now: Date): Promise<Tag> {
  const code = codeOf(err);
  // A port refusal is an expected state, recorded in the row; what is ours to look at (a broken fact, a token that will not open, a
  // database fault) is reported. Ids only: no fact, token or body.
  if (!(err instanceof YouTubeError)) {
    captureError(err, { orgId: c.org_id, route: "youtube.end_step", extra: { broadcastId: c.id, code } });
  }
  if (code === "youtube_reconnect_needed") {
    try {
      await markReconnectNeeded(sql, c.org_id, c.connection_id);
    } catch (e) {
      captureError(e, { orgId: c.org_id, route: "youtube.end_step.mark_reconnect", extra: { connectionId: c.connection_id } });
    }
  }
  await recordFailure(c.org_id, c.id, code, now);
  return code === "youtube_reconnect_needed" ? "reconnect" : "failed";
}

/** Run one pass of the end step. `orgIds` (test-only) scopes the selection; an empty list is refused — `org_id in ()` read as "no
 *  filter" would end every organisation's broadcasts. `wallClock` scripts the budget's clock; rows not started before `budgetMs` has gone
 *  are counted `deferred` (not a failure: the next firing reaches them). */
export async function endDueBroadcasts(
  port: YouTubePort,
  o: { now: () => Date; budgetMs: number; wallClock?: () => number; orgIds?: readonly string[]; hooks?: EndStepHooks },
): Promise<YoutubeEndResult> {
  const orgIds = o.orgIds === undefined ? undefined : [...o.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) {
    throw new Error("youtube end step: orgIds is empty — omit it to cover every organisation, or name at least one");
  }
  const wallClock = o.wallClock ?? Date.now;
  const started = wallClock();
  const out: YoutubeEndResult = { ended: 0, neverLive: 0, orphans: 0, failed: 0, deferred: 0 };
  const candidates = await candidatesOf(o.now(), orgIds);
  for (let i = 0; i < candidates.length; i++) {
    if (wallClock() - started >= o.budgetMs) {
      out.deferred = candidates.length - i;
      break;
    }
    const c = candidates[i]!;
    let tag: Tag;
    try {
      tag = await endOne(port, c, o);
    } catch (err) {
      try {
        tag = await failOne(c, err, o.now());
      } catch (inner) {
        // Even the bookkeeping failed (the database is down): reported, counted, and the pass goes on.
        captureError(inner, { orgId: c.org_id, route: "youtube.end_step.record_failure", extra: { broadcastId: c.id } });
        tag = "failed";
      }
    }
    if (tag === "ended") out.ended++;
    else if (tag === "neverLive") out.neverLive++;
    else if (tag === "orphan") out.orphans++;
    else if (tag === "failed") out.failed++;
  }
  return out;
}
