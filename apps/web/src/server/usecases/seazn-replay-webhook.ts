import "server-only";
// server/usecases/seazn-replay-webhook.ts — what one Bunny Stream webhook event does (Seazn-hosted video, Phase 2, Task 27). The
// webhook is the PRIMARY "playable" signal; the move's 15-min poll (usecases/seazn-replays.ts) is the backstop for an event Bunny
// dropped after its last retry. Called by POST /api/webhooks/bunny-stream once the signature checked out and REPLAY is on.
//
// A TRIGGER, NEVER TRUST (the binding rule): an event that says playable makes nothing playable by itself. The host's own read of
// the copy goes through the move's check (`verifyReplayCopy`: playable, ±2 s of the recording, the required rung), and only a pass
// moves `encoding → playable`, written exactly as the poll writes it (verified now; the Cloudflare delete due
// SEAZN_CF_DELETE_DELAY_MINUTES later). A fail writes NOTHING: a status 4 ("Resolution finished") can come before the 720p rendition
// exists (B6), so only the poll, which reads the host's finished status itself, sends a failing copy down the failed path.
//
// NO CLOUDFLARE (C6, recommendation 2026-11-21): this path never deletes, lists or signs a Cloudflare video — its deps carry no
// ingest port at all. The delayed Cloudflare delete is the move's (`cfDeleteGate`).
//
// IDEMPOTENT ON EventId: an event that may act is marked in `bunny_webhook_events` first (`on conflict do nothing`); a mark already
// there is `duplicate` — no read, no write, no removal. An event that THROWS has its mark released before the throw goes on, so the
// route's 500 makes Bunny redeliver it and the redelivery is acted on, not dropped as a duplicate.
//
// STRAYS: a copy no row holds, titled in the move's form (`seazn:{sessionId}:{cfVideoId}`, domain/replay-move.ts), for a recording
// this database made, is ours and stray — a lost fetch answer (Task 24), or a fetch that landed after the organiser's delete whose
// own removal failed (Task 26 review m5) — and is removed. A recording still `fetching` is skipped: the move's own answer is about to
// land (plan decision: remove rather than adopt; the fetch's stale timeout is the one recovery path). Anything else in the library
// is never touched.
import { sql } from "@/lib/db";
import { scrubScoreUrl } from "@/lib/scrub-score-url";
import { log } from "@/server/logger";
import { SEAZN_CF_DELETE_DELAY_MINUTES } from "@/server/relay/config";
import { type BunnyEvent, webhookOutcome } from "@/server/video/bunny-webhook";
import { parseReplayCopyTitle, replayFailure, verifyReplayCopy } from "@/server/video/domain/replay-move";
import type { ReplayHost } from "@/server/video/replay-ports";

const MIN = 60_000;

export interface BunnyWebhookDeps {
  /** BUNNY_STREAM_LIBRARY_ID: an event of any other library is not ours. */
  libraryId: string;
  /** The host's read of a copy and its removal — nothing else: the webhook never fetches, and never reaches Cloudflare (C6). */
  replay: Pick<ReplayHost, "video" | "remove">;
}
/** `applied`: a row moved, or a stray copy was removed. `duplicate`: this event was handled before. `ignored`: nothing to do. */
export type BunnyEventResult = "applied" | "duplicate" | "ignored";

const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);
/** A provider's error, for a log line: through the shared scrubber, and short (the move's own rule). */
const detail = (err: unknown) => scrubScoreUrl(err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function applyBunnyEvent(deps: BunnyWebhookDeps, ev: BunnyEvent, now: Date): Promise<BunnyEventResult> {
  if (ev.libraryId !== deps.libraryId) {
    log.info({ libraryId: ev.libraryId, status: ev.status }, "seazn replay webhook: an event of another library — ignored");
    return "ignored";
  }
  const outcome = webhookOutcome(ev.status);
  // Bunny's early statuses (queued, processing, encoding; they can come before the move has written the guid) and its other events
  // act on nothing: no mark, no lookup, no read of the host.
  if (outcome === "ignore") return "ignored";
  const marked = await sql`
    insert into bunny_webhook_events (event_id, received_at) values (${ev.eventId}, ${now}) on conflict (event_id) do nothing returning event_id`;
  if (marked.length === 0) return "duplicate";
  try {
    return await act(deps, ev, outcome, now);
  } catch (err) {
    // Released, so the route's 500 has Bunny redeliver this event and the redelivery is acted on. A release that fails too leaves
    // the mark: the poll still judges a held copy; a stray then stays on the host (logged here by its id).
    await sql`delete from bunny_webhook_events where event_id = ${ev.eventId}`.catch((e: unknown) => {
      log.error({ eventId: ev.eventId, guid: ev.videoId, errClass: errClass(e) }, "seazn replay webhook: a failed event's mark could not be released — its redelivery will read as a duplicate");
    });
    throw err;
  }
}

interface HeldRow { id: string; state: string; cf_duration_seconds: number | null; cf_height: number | null; attempts: number }

async function act(deps: BunnyWebhookDeps, ev: BunnyEvent, outcome: "playable" | "failed", now: Date): Promise<BunnyEventResult> {
  // At most one row names a copy: V543's unique index (fixture_video_replays_bunny_video_id_key), which this read also rides.
  const [held] = await sql<HeldRow[]>`
    select id, state, cf_duration_seconds, cf_height, attempts from fixture_video_replays where bunny_video_id = ${ev.videoId}`;
  if (held) return heldCopy(deps, held, ev, outcome, now);
  return strayCopy(deps, ev);
}

/** A copy a row holds. Only an `encoding` row is the webhook's: every other state is the move's (a verified copy, a failed one whose
 *  removal is retried, an organiser's delete awaiting cleanup), and an event for it changes nothing. */
async function heldCopy(deps: BunnyWebhookDeps, row: HeldRow, ev: BunnyEvent, outcome: "playable" | "failed", now: Date): Promise<BunnyEventResult> {
  const guid = ev.videoId;
  if (row.state !== "encoding") {
    log.info({ replayId: row.id, guid, state: row.state, status: ev.status }, "seazn replay webhook: the row is past encoding — the move owns it; nothing to do");
    return "ignored";
  }
  if (outcome === "playable") {
    const copy = await deps.replay.video(guid);
    const check = verifyReplayCopy({ cfDurationSeconds: row.cf_duration_seconds, cfHeight: row.cf_height }, copy);
    if (!check.ok) {
      log.info({ replayId: row.id, guid, status: ev.status, reason: check.reason }, "seazn replay webhook: the copy does not pass the check yet — left encoding; the poll judges it");
      return "ignored";
    }
    const verified = await sql`
      update fixture_video_replays
         set state = 'playable', state_at = ${now}, verified_at = ${now}, length_seconds = ${copy.lengthSeconds},
             next_attempt_at = ${new Date(now.getTime() + SEAZN_CF_DELETE_DELAY_MINUTES * MIN)}
       where id = ${row.id} and state = 'encoding' and bunny_video_id = ${guid}
       returning id`;
    if (verified.length === 0) return "ignored";   // the move got there first
    log.info({ replayId: row.id, guid, status: ev.status }, "seazn replay webhook: the copy passed the check — playable");
    return "applied";
  }
  // Failed: the row goes `failed` FIRST, still naming the copy (the move's poll order, re-review N2); the copy is removed; only a
  // removal that succeeded clears it. A removal that fails leaves it on the row, and the move's retry removes it before refetching.
  const f = replayFailure(row, now);
  const failed = await sql`
    update fixture_video_replays set state = 'failed', state_at = ${now}, attempts = ${f.attempts}, next_attempt_at = ${f.nextAttemptAt}
     where id = ${row.id} and state = 'encoding' and bunny_video_id = ${guid}
     returning id`;
  if (failed.length === 0) return "ignored";
  try {
    await deps.replay.remove(guid);
  } catch (err) {
    log.error({ replayId: row.id, guid, errClass: errClass(err), detail: detail(err) }, "seazn replay webhook: the host failed the copy and it could not be removed — kept on the row; the move's retry removes it first");
    return "applied";
  }
  await sql`update fixture_video_replays set bunny_video_id = null where id = ${row.id} and state = 'failed' and bunny_video_id = ${guid}`;
  log.warn({ replayId: row.id, guid, attempts: f.attempts }, "seazn replay webhook: the host failed the copy — removed; the move starts again after the backoff");
  return "applied";
}

/** A copy no row holds: removed only when it is ours — titled in the move's form, for a recording this database made, whose row is
 *  not still `fetching` and does not hold this very copy now (the move's write can land while the title is read). A removal that
 *  throws goes on to the route's 500. */
async function strayCopy(deps: BunnyWebhookDeps, ev: BunnyEvent): Promise<BunnyEventResult> {
  const guid = ev.videoId;
  const copy = await deps.replay.video(guid);
  const named = parseReplayCopyTitle(copy.title);
  if (named === null) {
    log.info({ guid, state: copy.state }, "seazn replay webhook: a copy no row holds, not titled as ours (or no longer on the host) — left alone");
    return "ignored";
  }
  const [row] = await sql<{ id: string; state: string; bunny_video_id: string | null }[]>`
    select id, state, bunny_video_id from fixture_video_replays where cf_video_id = ${named.cfVideoId} and session_id = ${named.sessionId}`;
  if (!row) {
    // Our form, but no recording of THIS database: another deployment's copy in a shared library is never ours to remove.
    log.warn({ guid, cfVideoId: named.cfVideoId }, "seazn replay webhook: a copy titled as ours names no recording here — left alone");
    return "ignored";
  }
  if (row.state === "fetching" || row.bunny_video_id === guid) {
    log.info({ replayId: row.id, guid, state: row.state }, "seazn replay webhook: the move's own answer for this copy is landing — left to it");
    return "ignored";
  }
  await deps.replay.remove(guid);
  log.info({ replayId: row.id, guid, state: row.state }, "seazn replay webhook: a stray copy of ours removed");
  return "applied";
}
