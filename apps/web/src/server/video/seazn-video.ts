import "server-only";
// server/video/seazn-video.ts — a fixture's Seazn-hosted video, as the player reads it (Seazn-hosted video, Phase 1 Task 14; spec G5,
// §5.1; recommendation 2026-11-21 G-B). One answer shape, `PublicFixtureVideo` (api-v1/schemas/public.ts), two reads:
//   seaznFixtureVideo(fixtureId, now)               the PUBLIC read (GET /api/v1/public/fixtures/{id}/video; the match page's
//                                                    island, Task 15). The fixture must be one the public may see: in
//                                                    public_fixtures_v, its division past setup — the redaction replayParts
//                                                    relies on (youtube/parts.ts, public_fixture_youtube_parts_v). Any other
//                                                    fixture answers the empty video, the same as one with no video at all,
//                                                    so a private fixture's id is not an oracle.
//   seaznFixtureVideoForOrg(orgId, fixtureId, now)  the ORGANISER's read (Match Day, the fixture panel: Task 17). Org-scoped on
//                                                    the fixture and every session, private competitions included (spec G5).
//
// `live`: the fixture's LATEST session (by creation), when it is a Seazn session in state `live` — its programme input's signed
// HLS (`signLivePlayback`). Warming, ending, ended, or an external destination: no live.
// `session` (Task 33g, T33f review m1): the same latest session's own `state` and whether it ever went live (`started_at` set), when it is
// a Seazn session; null for a session of another kind, none, or a fixture the public may not see. It rides EVERY answer, the empty one
// too, so an open page can follow a Stop, a cancel (a Go live stopped while warming records nothing) or a live it missed.
// `replay`: every recording of the fixture's ENDED Seazn sessions, one part each (domain/replay-parts.ts holds the rules):
//   * the replay host's copy (Task 25): a recording the replay move made `playable` (`fixture_video_replays`, Task 24) is an
//     `embed` part, its src the host's signed player URL (`signedEmbed`, REPLAY_EMBED_TOKEN_TTL_SECONDS), IN PLACE of its interim
//     part, under the part number discovery STORED. The public read takes it from `public_fixture_seazn_replays_v` (the redaction's
//     one place), the organiser's read from the table. A row the organiser removed is no part at all, the interim included.
//   * the interim (G-B, Task 14): a recording in `seazn_locked_videos` under the programme input of the session, not yet playable
//     on the host (no row, a row on its way, or a failed one), is an `hls` part, its signed HLS (`signRecordingPlayback`).
//     Task 39: only once Cloudflare can play it (`ready_at` set by the pass: state `ready`); a queued, in-progress or errored one is
//     no part, though its number stays held (replay-parts.ts READY).
//   ORDER: recording order. The session's (created_at, id), then, within one session, when the recording began (recorded_at,
//     V542: the lock pass stores the listing's creation, the row stores discovery's; null sorts last), then the lock (locked_at,
//     cf_video_id) (replay-entries.ts, the one read discovery numbers from too). NUMBER: a row's stored part_no; a locked recording
//     with no row yet takes the number `partNumbers` gives it (domain/replay-parts.ts: with no row at all Task 14's 1..n), which is
//     the number discovery stores (review I1). Numbers never move; a part left out leaves a gap.
//   LEFT OUT: an `hls` part whose session began DELETE_RECORDING_AFTER_DAYS or more before `now` (Cloudflare deletes a recording
//     that long after it is ready, which is never before its session began, so this never lists a deleted one; the bound is
//     Cloudflare's, so an `embed` part never meets it), and a part whose URL cannot be made right now (logged by uid or the error's
//     class, never a token). One part never fails the answer or the live.
// A LIVE whose token cannot be minted (Phase 1 review I1) is settled the same way: `live: null`, the parts still answer, and one
// line names the session and the error's class. It used to fail the whole answer, so a Cloudflare outage was a 500 on every
// viewer's poll (and a Sentry event each, v1's unhandled-error path). A failed mint is remembered for a window (cf-playback.ts),
// and a refusal from inside that window (`PlaybackTokenRecentlyFailed`) is not logged again: one line per mint, not per viewer.
// Only a `seazn_locked_videos` uid is ever signed on Cloudflare: Task 13 wrote that row after checking the recording names this input itself
// (C6) and making it need a token (C3), so an unsigned recording, a uid from a listing and a uid from the request never reach
// a viewer. A session still live has no part yet: its live plays.
//
// The flags are not read (controller ruling 2026-11-20): SEAZN_HOSTED_LIVE gates new Seazn streams, never playback of one that
// exists, and SEAZN_HOSTED_REPLAY gates the MOVE, never playing what it moved. The relay is asked only when there is a live or an
// interim part to sign, and the replay host (`replayDriver()`) only when there is an embed part: an answer of embed parts alone
// never builds the relay, and a host that cannot be built leaves the embed parts out of that answer, logged by the error's class. So a relay-disabled deployment answers a fixture with no
// Seazn video without touching it. With one, `relayDrivers()` hands back the disabled pair, whose every method rejects with
// `RelayDriversDisabled`: the live and each part are left out and logged under that name, and the answer is
// `{ live: null, replay: [] }`. A live deployment that cannot even BUILD its relay (its Cloudflare secrets missing) still throws.
//
// Secrets: a signed URL (a Cloudflare token, a replay-host token) is the answer itself and goes nowhere else — never logged, never
// in an error. The privileged `sql` client: fixture_stream_*, seazn_locked_videos and fixture_video_replays are FORCE RLS with no
// policy (V410, V541, V542), the stream pattern (parts.ts).
import { sql } from "@/lib/db";
import type { PublicFixtureVideo, StreamSessionState } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { REPLAY_EMBED_TOKEN_TTL_SECONDS, SEAZN_TOKEN_FAILURE_CACHE_SECONDS } from "@/server/relay/config";
import { relayDrivers } from "@/server/relay/drivers";
import { type PlaybackDeps, PlaybackTokenRecentlyFailed, processPlaybackTokenCache, signLivePlayback, signRecordingPlayback } from "./cf-playback";
import { type ReplayPart, replayParts } from "./domain/replay-parts";
import { readReplayEntries } from "./replay-entries";
import { replayDriver } from "./replay-driver";
import type { ReplayHost } from "./replay-ports";

export type { PublicFixtureVideo };
/** The signers a read uses: the relay's (the live, the interim parts) and the replay host (the embed parts). A test seam;
 *  production signs through this process's relay, its one token cache (Task 13) and its replay driver. */
export type VideoDeps = PlaybackDeps & { replay?: ReplayHost };

/** The identity a signed part carries: an `hls` one has it (cf-playback.ts `SignedPlayback.id`), the replay host's `embed` one does not. */
const partId = (signed: { src: string; expiresAt: string; id?: string }): string | undefined => signed.id;

const EMPTY = (): PublicFixtureVideo => ({ live: null, replay: [], session: null });
/** A fixture id is a uuid; anything else names no fixture, and is answered before it reaches a query (22P02 would be a 500). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The PUBLIC read: the fixture's Seazn video, or the empty video when the public may not see the fixture. `playback`: VideoDeps. */
export async function seaznFixtureVideo(fixtureId: string, now: Date, playback?: VideoDeps): Promise<PublicFixtureVideo> {
  if (!UUID.test(fixtureId)) return EMPTY();
  const [visible] = await sql<{ id: string }[]>`
    select v.id from public_fixtures_v v join divisions d on d.id = v.division_id
     where v.id = ${fixtureId} and d.status <> 'setup'`;
  return visible ? videoOf(fixtureId, null, now, playback) : EMPTY();
}

/** The ORGANISER's read: the same answer for this organisation's fixture, whatever its competition's visibility. Another
 *  organisation's fixture answers the empty video. */
export async function seaznFixtureVideoForOrg(orgId: string, fixtureId: string, now: Date, playback?: VideoDeps): Promise<PublicFixtureVideo> {
  if (!UUID.test(fixtureId) || !UUID.test(orgId)) return EMPTY();
  const [own] = await sql<{ id: string }[]>`select id from fixtures where id = ${fixtureId} and org_id = ${orgId}`;
  return own ? videoOf(fixtureId, orgId, now, playback) : EMPTY();
}

interface LatestSession { id: string; state: StreamSessionState; destination_kind: string; programme_uid: string | null; went_live: boolean }

/** What a rejected mint is logged as: its class alone. A message could quote a request, and a request can carry a token. */
const errorClass = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
/** The provider's status and code on a failed mint (Task 25, coordinator's addition): read off the Cloudflare adapter's refusal
 *  (ingest-cf.ts `fail`: `cloudflare <what>: HTTP <status> code <code> <text>`) as NUMBERS alone, so the provider's free text, which
 *  can quote a request, never reaches the line. Anything else (a transport failure, a timeout, another adapter) is null, null. */
function providerCodeOf(e: unknown): { httpStatus: number | null; providerCode: string | null } {
  const m = e instanceof Error ? /^cloudflare [a-z ]+: HTTP (\d{3})(?: code (\d{1,9}))?(?:\s|$)/.exec(e.message) : null;
  return { httpStatus: m ? Number(m[1]) : null, providerCode: m?.[2] ?? null };
}
/** A failure worth a line: a mint that was asked and failed. A refusal inside a failed mint's window asked nothing (review I1). */
const freshFailure = (e: unknown): boolean => !(e instanceof PlaybackTokenRecentlyFailed);

/** The fixture's parts a reader may be offered, in recording order, each with its player and number (domain/replay-parts.ts): the
 *  locked recordings of its ENDED Seazn sessions merged with the replay move's rows. The one authority for the parts: `videoOf`
 *  signs these, and the match page's plan reads their numbers (`seaznReplayPartNos`) to hold the picker's row before the first read.
 *  `orgId` null is the PUBLIC reader: a playable copy is listed only through `public_fixture_seazn_replays_v`. Otherwise the
 *  organiser's, scoped to that org: its own playable, not removed, rows. Every row of the fixture is read for the numbering, a
 *  removed one's included (its number stays taken), through the same read discovery numbers from (replay-entries.ts). */
async function listedParts(fixtureId: string, orgId: string | null, now: Date): Promise<ReplayPart[]> {
  return replayParts(await readReplayEntries(sql, { fixtureId, orgId }), now);
}

/** The part numbers the PUBLIC read would offer for a fixture right now, with no signing (no relay, no token): the match page's plan
 *  uses them to hold the replay picker's row from the server render (Phase 1 visual re-capture R1). One that cannot be signed at
 *  answer time is left out of the answer and not of this list; the page's hint is as of its render, as every plan fact is. */
export async function seaznReplayPartNos(fixtureId: string, now: Date): Promise<number[]> {
  if (!UUID.test(fixtureId)) return [];
  return (await listedParts(fixtureId, null, now)).map((p) => p.partNo);
}

/** Review m2: when the replay host last failed to build, logged. A host that cannot be built fails on EVERY viewer read, so it is
 *  logged once per failure window per process (client-ip.ts's throttle; the window is the mint's own, SEAZN_TOKEN_FAILURE_CACHE_SECONDS),
 *  never once per read. */
let hostFailureLoggedAtMs: number | null = null;

/** The replay host this answer signs with, or null when it cannot be built (logged by the error's class, once per window). */
function hostOf(playback: VideoDeps | undefined, now: Date): ReplayHost | null {
  try {
    return playback?.replay ?? replayDriver();
  } catch (err) {
    const nowMs = now.getTime();
    if (hostFailureLoggedAtMs === null || nowMs - hostFailureLoggedAtMs >= SEAZN_TOKEN_FAILURE_CACHE_SECONDS * 1000) {
      hostFailureLoggedAtMs = nowMs;
      log.warn({ err: errorClass(err) }, "seazn video: the replay host could not be built; its parts are left out of this answer");
    }
    return null;
  }
}
/** Tests only: a fresh process's throttle. */
export function __resetReplayHostLogForTests(): void {
  hostFailureLoggedAtMs = null;
}

async function videoOf(fixtureId: string, orgId: string | null, now: Date, playback: VideoDeps | undefined): Promise<PublicFixtureVideo> {
  const inOrg = orgId === null ? sql`` : sql`and s.org_id = ${orgId}`;
  // The programme input is the session's lowest programme slot (readFirstInput's row), read for its uid alone: nothing
  // sealed is opened on a viewer's request.
  const [latest] = await sql<LatestSession[]>`
    select s.id, s.state, s.destination_kind, s.started_at is not null as went_live,
           (select i.ingest_input_id from fixture_stream_inputs i
             where i.session_id = s.id and i.role = 'programme' order by i.slot asc limit 1) as programme_uid
      from fixture_stream_sessions s
     where s.fixture_id = ${fixtureId} ${inOrg}
     order by s.created_at desc, s.id desc
     limit 1`;
  const parts = await listedParts(fixtureId, orgId, now);

  // Task 33g: what the open page needs to follow the session (its own state, never a new vocabulary), for a Seazn session only: a
  // session of another kind is not this player's to wait for (the page's plan reads `latest_kind` the same way).
  const session: PublicFixtureVideo["session"] = latest !== undefined && latest.destination_kind === "seazn" ? { state: latest.state, wentLive: latest.went_live } : null;
  const onAir = latest !== undefined && latest.destination_kind === "seazn" && latest.state === "live";
  const liveUid = onAir ? latest.programme_uid : null;
  if (onAir && liveUid === null) {
    // A live Seazn session has a provisioned programme input; one without a uid has nothing to sign, so it shows no live.
    log.warn({ sessionId: latest.id }, "seazn video: a live Seazn session has no programme input uid; no live is shown");
  }
  if (liveUid === null && parts.length === 0) return { ...EMPTY(), session };

  const interim = parts.filter((p) => p.player === "hls");
  // The relay is built only for a live or an interim part; the replay host only for an embed part.
  const deps = liveUid === null && interim.length === 0 ? null : (playback ?? { ingest: relayDrivers().ingest, tokenCache: processPlaybackTokenCache() });
  const host = parts.some((p) => p.player === "embed") ? hostOf(playback, now) : null;
  // The live and each part are signed on their own: one that cannot be minted is left out of this answer, never the answer.
  const [liveSigned, signed] = await Promise.all([
    liveUid === null ? null : signLivePlayback(deps!, liveUid, now).then((v) => ({ ok: v }), (err: unknown) => ({ err })),
    Promise.allSettled(parts.map(async (p) => {
      if (p.player === "hls") return signRecordingPlayback(deps!, p.cfVideoId, now);
      if (host === null) return null;   // logged by hostOf, once per window
      return host.signedEmbed(p.bunnyVideoId, now, REPLAY_EMBED_TOKEN_TTL_SECONDS);
    })),
  ]);
  let live: PublicFixtureVideo["live"] = null;
  if (liveSigned !== null && "ok" in liveSigned) live = liveSigned.ok;
  else if (liveSigned !== null && freshFailure(liveSigned.err)) {
    log.warn(
      { fixtureId, sessionId: latest!.id, err: errorClass(liveSigned.err), ...providerCodeOf(liveSigned.err) },
      "seazn video: the live could not be signed; this answer has no live",
    );
  }
  const replay: PublicFixtureVideo["replay"] = [];
  signed.forEach((s, i) => {
    const p = parts[i]!;
    if (s.status === "fulfilled") {
      if (s.value !== null) replay.push({ partNo: p.partNo, player: p.player, src: s.value.src, expiresAt: s.value.expiresAt, ...(partId(s.value) === undefined ? {} : { id: partId(s.value) }) });
    } else if (freshFailure(s.reason)) {
      log.warn(
        { fixtureId, sessionId: p.sessionId, cfVideoId: p.cfVideoId, err: errorClass(s.reason), ...providerCodeOf(s.reason) },
        "seazn video: a replay part could not be signed; it is left out of this answer",
      );
    }
  });
  return { live, replay, session };
}
