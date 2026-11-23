import "server-only";
// server/video/organiser-replays.ts — the organiser's side of a fixture's Seazn replays: the list (Task 25), the delete and the
// download (Task 26).
//
//   fixtureSeaznReplays(orgId, fixtureId)  the fixture stream panel's list: each part the replay move made (fixture_video_replays),
//                                          by its STORED number, in the organiser's three words, and whether the public match
//                                          page shows it (`onMatchPage`: the competition public or unlisted, its division past
//                                          setup — public_fixture_seazn_replays_v's own conditions, Task 25 review m3). Org-scoped:
//                                          the fixture must be the org's (another org's read is 404, never an empty list, as the
//                                          session view's is), and so must every row. A removed part (`deleted`, or `deleted_at`
//                                          set) is not listed. It rides the session view (`currentSession().seaznReplays`), which
//                                          the panel already polls.
//   deleteSeaznReplay(auth, fixtureId, replayId)
//                                          the organiser's delete. ONE short transaction takes the row FOR UPDATE — it waits at
//                                          most for one of the move's own single-statement writes, because the move holds no
//                                          transaction across a provider call — and writes the delete (`deleted`, `deleted_at`,
//                                          `deleted_by`, reason `organiser`, the cleanup due now). That write wins over the move:
//                                          the move's next write is conditional on the state it read, and finds nothing. AFTER the
//                                          commit, and never inside it, the host's copy the row named is removed; a failure there
//                                          still answers the delete, and the move's cleanup step (Task 24) retries it, removes any
//                                          copy still in flight and deletes the Cloudflare copy. A second delete answers the same.
//   seaznReplayDownload(auth, fixtureId, replayId)
//                                          a playable part's file, as the host's own stream (never buffered, never a URL), named
//                                          for the match and the part (`replayFileName`). Anything but a playable part is 409; so is
//                                          the host's own "not ready" (ReplayNotDownloadable), which a row can read past (Task 22
//                                          review m6). The host not answering is 503 (try again); the host refusing OUR
//                                          credentials or address is 500 replay_host_refused (a configuration fault, reported),
//                                          anything else 500; a viewer who left first is 499, never an error (T26 re-review m1).
//
// The delete and the download are an editor's, with a session: never an API key, a device link or a Match Day code (the routes are
// NEVER_KEY_ROUTES too), and another org's part, or another fixture's, is 404.
//
// The words: `processing` while the move is on its way (found, downloading, fetching, encoding), `playable` once the copy is
// verified, `failed` when it failed its check. A state outside REPLAY_ROW_STATES (V542's CHECK forbids one) is refused by name.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { replayFileName } from "@/lib/poster-file-name";
import { scrubScoreUrl } from "@/lib/scrub-score-url";
import { EDITOR_ROLES } from "@/lib/types";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import type { ReplayRowState } from "./domain/replay-move";
import { replayDriver } from "./replay-driver";
import { type ReplayCredential, type ReplayHost, ReplayHostRefused, ReplayHostUnavailable, ReplayNotDownloadable } from "./replay-ports";

export type OrganiserReplayState = "processing" | "playable" | "failed";
export interface OrganiserReplay {
  id: string;
  partNo: number;
  state: OrganiserReplayState;
  lengthSeconds: number | null;
  /** The public match page shows this part (a playable copy, or a failed copy's interim recording): the competition is public or
   *  unlisted and its division past setup. False for a private competition, whose parts only its organisation sees. */
  onMatchPage: boolean;
}

/** A row state with no organiser word: one V542's CHECK does not admit, or `deleted` (never listed). */
export class UnknownOrganiserReplayState extends Error {
  override readonly name = "UnknownOrganiserReplayState";
  constructor(state: string) {
    super(`a fixture_video_replays state with no organiser word: ${JSON.stringify(state)}`);
  }
}

const WORD_OF: Record<Exclude<ReplayRowState, "deleted">, OrganiserReplayState> = {
  found: "processing",
  downloading: "processing",
  fetching: "processing",
  encoding: "processing",
  playable: "playable",
  failed: "failed",
};

export function organiserReplayState(state: string): OrganiserReplayState {
  if (!Object.hasOwn(WORD_OF, state)) throw new UnknownOrganiserReplayState(state);
  return WORD_OF[state as keyof typeof WORD_OF];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fixtureSeaznReplays(orgId: string, fixtureId: string): Promise<OrganiserReplay[]> {
  if (!UUID.test(fixtureId)) throw new HttpError(404, "fixture not found");
  // One read: the fixture (scoped to the org through its competition), whether the public sees it, and its listed rows. No fixture
  // row: 404.
  const rows = await sql<{ id: string | null; part_no: number | null; state: string | null; length_seconds: number | null; on_match_page: boolean }[]>`
    select r.id, r.part_no, r.state, r.length_seconds,
           (d.status <> 'setup' and c.visibility in ('public','unlisted')) as on_match_page
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id and c.org_id = ${orgId}
      left join fixture_video_replays r
        on r.fixture_id = f.id and r.org_id = ${orgId} and r.state <> 'deleted' and r.deleted_at is null
     where f.id = ${fixtureId}
     order by r.part_no`;
  if (rows.length === 0) throw new HttpError(404, "fixture not found");
  return rows
    .filter((r): r is typeof r & { id: string; part_no: number; state: string } => r.id !== null)
    .map((r) => ({ id: r.id, partNo: r.part_no, state: organiserReplayState(r.state), lengthSeconds: r.length_seconds, onMatchPage: r.on_match_page }));
}

// ─── Task 26: the delete and the download ────────────────────────────────────────────────────────────────────────────────

/** A test seam: the clock the delete stamps and the host the copy is removed from / read through. Production: now, this process's
 *  replay driver. */
export interface OrganiserReplayDeps {
  now?: Date;
  replay?: ReplayHost;
  /** The download's cancel (the route's request.signal), handed to the host so an abandoned download stops pulling (review m1). */
  signal?: AbortSignal;
}

const REPLAY_NOT_FOUND = "replay not found";
/** The answer to a download of a part that has no file to give yet (or any more): the panel offers Download on playable parts only. */
export const REPLAY_NOT_DOWNLOADABLE = "This replay is not ready to download";
/** The answer when the video host fails to start the file (no headers in its 4 s, a network fault; review m1): retryable, and
 *  never the host's own words, which name its video. */
export const REPLAY_HOST_UNAVAILABLE = "The video host did not answer. Try the download again in a moment";
/** The answer when the download fails for a reason on OUR side — the host refused our credentials or address (a configuration
 *  fault: T26 re-review m1 a), or anything else unexpected: never "try again", which would not help. Both are reported. */
export const REPLAY_DOWNLOAD_FAULT = "The download could not start because of a fault on our side. It has been reported";
/** The refusal's log line names the one setting to fix: the credential the host refused (Task 27 review m3). */
const REFUSED_LINE: Record<ReplayCredential, string> = {
  api_key: "seazn replay: the host refused our API key — a configuration fault: check BUNNY_STREAM_API_KEY",
  delivery_token:
    "seazn replay: the host's file delivery refused our token or address — a configuration fault: check BUNNY_TOKEN_KEY and the library's allowed referrers (SEAZN_VIDEO_ORIGINS)",
};
/** A download the viewer left before the host answered (T26 re-review m1 b): nobody reads this answer, and it is not an error. */
const REPLAY_DOWNLOAD_CANCELLED = "The download was cancelled";

/** An editor (owner or admin) signed in with a session; anything else — an API key, a device link, a Match Day code, a viewer — is
 *  403. The routes' door already asks for an editor; this is the use case's own guard, so a second caller cannot skip it. */
function requireReplayEditor(auth: AuthCtx): void {
  if (auth.via !== "session" || !auth.userId) throw new HttpError(403, "Replays can only be managed with a session login");
  if (auth.role === null || !(EDITOR_ROLES as readonly string[]).includes(auth.role)) throw new HttpError(403, "Insufficient permissions");
}

const errClass = (err: unknown) => (err instanceof Error ? err.name : typeof err);
/** A provider's error, for a log line: through the shared scrubber, and short (the move's own rule, seazn-replays.ts). */
const detail = (err: unknown) => scrubScoreUrl(err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function deleteSeaznReplay(auth: AuthCtx, fixtureId: string, replayId: string, deps: OrganiserReplayDeps = {}): Promise<{ deleted: true }> {
  requireReplayEditor(auth);
  if (!UUID.test(fixtureId) || !UUID.test(replayId)) throw new HttpError(404, REPLAY_NOT_FOUND);
  const now = deps.now ?? new Date();
  const copy = await sql.begin(async (tx) => {
    const [row] = await tx<{ state: string; bunny_video_id: string | null }[]>`
      select state, bunny_video_id from fixture_video_replays
       where id = ${replayId} and fixture_id = ${fixtureId} and org_id = ${auth.orgId}
         for update`;
    if (!row) throw new HttpError(404, REPLAY_NOT_FOUND);
    // Already deleted (a double tap, a second tab, the org's own deletion): the same answer, and nothing more to do.
    if (row.state === "deleted") return null;
    await tx`
      update fixture_video_replays
         set state = 'deleted', state_at = ${now}, deleted_at = coalesce(deleted_at, ${now}), deleted_reason = 'organiser',
             deleted_by = ${auth.userId}, next_attempt_at = ${now}, attempts = 0
       where id = ${replayId}`;
    return row.bunny_video_id;
  });
  if (copy !== null) await removeCopy(replayId, copy, deps);
  return { deleted: true };
}

/** The host's copy goes now, outside any transaction. Once it has, the row forgets it — only while the row is still deleted and still
 *  names that copy — so the cleanup step has no second call to make. A failure is logged and left to the cleanup step, which
 *  retries it (its window counts from the delete: `deleted_at`, T24 I1). */
async function removeCopy(replayId: string, guid: string, deps: OrganiserReplayDeps): Promise<void> {
  try {
    await (deps.replay ?? replayDriver()).remove(guid);
  } catch (err) {
    log.error({ replayId, guid, errClass: errClass(err), detail: detail(err) }, "seazn replays: the organiser's delete could not remove the copy — the move's cleanup retries it");
    return;
  }
  try {
    await sql`update fixture_video_replays set bunny_video_id = null where id = ${replayId} and state = 'deleted' and bunny_video_id = ${guid}`;
  } catch (err) {
    // The copy is gone; the row still names it, so the cleanup asks the host once more and is told `absent`.
    log.error({ replayId, errClass: errClass(err) }, "seazn replays: the removed copy could not be forgotten — the move's cleanup reads it absent");
  }
}

/** A playable part's file: the host's stream, its size when the host says it, and the name the download is saved under. */
export interface SeaznReplayFile {
  body: ReadableStream<Uint8Array>;
  bytes: number | null;
  fileName: string;
}

export async function seaznReplayDownload(auth: AuthCtx, fixtureId: string, replayId: string, deps: OrganiserReplayDeps = {}): Promise<SeaznReplayFile> {
  requireReplayEditor(auth);
  if (!UUID.test(fixtureId) || !UUID.test(replayId)) throw new HttpError(404, REPLAY_NOT_FOUND);
  const [row] = await sql<{ state: string; deleted_at: Date | null; bunny_video_id: string | null; part_no: number; home: string | null; away: string | null }[]>`
    select r.state, r.deleted_at, r.bunny_video_id, r.part_no, he.display_name as home, ae.display_name as away
      from fixture_video_replays r
      join fixtures f on f.id = r.fixture_id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
     where r.id = ${replayId} and r.fixture_id = ${fixtureId} and r.org_id = ${auth.orgId}`;
  if (!row) throw new HttpError(404, REPLAY_NOT_FOUND);
  if (row.state !== "playable" || row.deleted_at !== null || row.bunny_video_id === null) {
    throw new HttpError(409, REPLAY_NOT_DOWNLOADABLE, "replay_not_downloadable");
  }
  let file;
  try {
    file = await (deps.replay ?? replayDriver()).openDownload(row.bunny_video_id, deps.signal);
  } catch (err) {
    if (err instanceof ReplayNotDownloadable) throw new HttpError(409, REPLAY_NOT_DOWNLOADABLE, "replay_not_downloadable");
    // The host's own words (redacted by its adapter: no key, no signed URL) go to the log through the file's scrubber, never to the
    // caller. Each kind of failure has its own answer and its own level (T26 re-review m1 a, b, d).
    const fields = { replayId, guid: row.bunny_video_id, errClass: errClass(err), detail: detail(err) };
    if (deps.signal?.aborted) {
      // The viewer left first: whatever the host then threw is the cancel's echo. Below 500, so v1() never reports it to Sentry.
      log.info(fields, "seazn replay: the download was cancelled before the host answered — the viewer left");
      throw new HttpError(499, REPLAY_DOWNLOAD_CANCELLED, "download_cancelled");
    }
    if (err instanceof ReplayHostUnavailable) {
      log.warn(fields, "seazn replay: the host did not start the download — retryable");
      throw new HttpError(503, REPLAY_HOST_UNAVAILABLE, "replay_host_unavailable");
    }
    if (err instanceof ReplayHostRefused) {
      log.error({ ...fields, status: err.status, credential: err.credential }, REFUSED_LINE[err.credential]);
      throw new HttpError(500, REPLAY_DOWNLOAD_FAULT, "replay_host_refused");
    }
    log.error(fields, "seazn replay: the download failed to start");
    throw new HttpError(500, REPLAY_DOWNLOAD_FAULT, "replay_download_failed");
  }
  return { body: file.body, bytes: file.bytes, fileName: replayFileName(row.home ?? "", row.away ?? "", row.part_no) };
}
