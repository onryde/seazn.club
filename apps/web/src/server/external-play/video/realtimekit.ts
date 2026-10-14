import "server-only";
// Cloudflare RealtimeKit — meeting and participant lifecycle for the camera
// tile beside the board (spec §5). REST shapes verified against Cloudflare's
// published OpenAPI spec on 2026-10-09.
//
// WHAT THIS MODULE CANNOT DO, and why that is written here rather than
// discovered later: RealtimeKit exposes NO synchronous per-participant
// video-publishing signal to a server. `active-session` gives a status and a
// live-participant COUNT; session participants give joined_at/left_at and peer
// events (PEER_CREATED | PEER_JOINING | PEER_LEAVING). `videoEnabled` and
// `onVideoUpdate` exist only in the CLIENT SDK — which is exactly the
// forgeable surface spec §5.2 rejects. So `hasLiveVideoPublisher` proves
// "joined to a live session and not left", and CAMERA-ON IS ENFORCED BY THE
// PRESET: the player preset must be configured with video on at join and the
// video toggle DENIED. That is server-side configuration we hold, never a
// claim the browser makes. See plan premise P-B2-6.
//
// There IS after-the-fact evidence: the peer report (`videoOffCoverage`
// below). It is SDK telemetry — encoder-side stats the RealtimeKit client
// uploads — so it is harder to fake than a client boolean but it is not an
// independent observation by any server. Measured 2026-10-09
// (docs/superpowers/specs/evidence/2026-10-09-chess-spikes/rtk-peer-report.log):
// it stays frozen at the join snapshot for the whole session and is final
// about 70 s after the participant leaves, so it is organiser evidence after a
// match and never an input to the seat gate.
//
// No credential has a default, and there is no mock fallback. The POC
// returns `mock-token-*` whenever credentials are missing; here an
// unconfigured process refuses loudly, because a silently-mocked camera gate
// on a Required division is a tournament played with no camera at all.
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { liveMintClaimSince } from "@/server/external-play/window";
import { log } from "@/server/logger";

export const REALTIMEKIT_TIMEOUT_MS = 10_000;

export type RealtimeKitCode = "unconfigured" | "unauthorized" | "not_found" | "unavailable";

export class RealtimeKitError extends Error {
  constructor(
    readonly status: number,
    readonly code: RealtimeKitCode,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeKitError";
  }
}

export type RealtimeKitDeps = { fetch?: typeof fetch; baseUrl?: string };

type Config = {
  accountId: string;
  apiToken: string;
  appId: string;
  presets: { player: string; arbiter: string };
};

function readConfig(): Config | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  // NOT CLOUDFLARE_API_TOKEN: that name is the GitHub Actions secret that
  // deploys the cron worker with wrangler, with different scopes.
  const apiToken = process.env.REALTIMEKIT_API_TOKEN ?? "";
  const appId = process.env.REALTIMEKIT_APP_ID ?? "";
  const player = process.env.REALTIMEKIT_PLAYER_PRESET ?? "";
  const arbiter = process.env.REALTIMEKIT_ARBITER_PRESET ?? "";
  if (!accountId || !apiToken || !appId || !player || !arbiter) return null;
  return { accountId, apiToken, appId, presets: { player, arbiter } };
}

function requireConfig(): Config {
  const cfg = readConfig();
  if (!cfg) {
    throw new RealtimeKitError(
      503,
      "unconfigured",
      "RealtimeKit is not configured (account id, API token, app id and both preset names are all required)",
    );
  }
  return cfg;
}

const CF_BASE = "https://api.cloudflare.com/client/v4";

export type MeetingRef = { meetingId: string };
export type ParticipantToken = { participantId: string; authToken: string };

type CfBody = { success?: unknown; data?: unknown; paging?: unknown; error?: { code?: unknown } | null; errors?: unknown };

/** RealtimeKit's own "not found", for every endpoint except active-session
 *  (which has its own reading, below). OpenAPI documents RealtimeKit's error
 *  body as `{ success: false, error: { code, message } }`, both required,
 *  with `code` the HTTP status. A 404 in any other shape (Cloudflare's own
 *  routing envelope with `errors[]`, an HTML page from a proxy, a wrong
 *  REALTIMEKIT_BASE_URL) is not "nothing there": it is an answer we cannot
 *  read. */
function isRealtimeKitNotFound(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as CfBody;
  return b.success === false && typeof b.error === "object" && b.error !== null && b.error.code === 404;
}

/** Cloudflare's API gateway answers a path it cannot route with its own v4
 *  envelope, `errors: [{ code: 7000 "No route for that URI" | 7003 "Could not
 *  route to …" }]`. That is never RealtimeKit saying "no session". */
const CF_GATEWAY_NO_ROUTE = new Set([7000, 7003]);

/** The active-session 404: "no live session yet" — the NORMAL state before
 *  the first player joins, and what the T8 seat gate meets on every Required
 *  fixture's first claim. Measured: an ended meeting answers HTTP 404
 *  (progress.md); the body is still unrecorded (T17 owes it), so this reads
 *  the envelope rather than its exact typing — `success === false` and
 *  `Number(error.code) === 404`, extra fields and a string "404" allowed.
 *  Anything else (HTML, an empty or non-JSON body, a gateway no-route code
 *  anywhere in `errors[]`) is an answer we cannot read, and reading it as
 *  "no session" would turn an outage into "camera off". */
function isActiveSessionAbsent(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as CfBody;
  const gatewayNoRoute =
    Array.isArray(b.errors) &&
    b.errors.some((e) => CF_GATEWAY_NO_ROUTE.has(Number((e as { code?: unknown } | null)?.code)));
  if (gatewayNoRoute) return false;
  return b.success === false && Number(b.error?.code) === 404;
}

/** One request. Maps transport and HTTP failure onto RealtimeKitError, and
 *  NEVER puts the API token or a response body into the message — a
 *  RealtimeKit error body can echo the request, and these messages reach
 *  logs and Sentry. A 404 is `not_found` only when `notFound` (default:
 *  RealtimeKit's documented error body) recognises its body; any other 404
 *  is `unavailable` — but both carry status 404. */
async function cf(
  cfg: Config,
  path: string,
  init: { method: string; body?: unknown; notFound?: (body: unknown) => boolean },
  deps: RealtimeKitDeps,
): Promise<unknown> {
  return (await cfEnvelope(cfg, path, init, deps)).data;
}

/** `cf`, keeping the envelope: `data` (checked present) and the siblings a
 *  list endpoint documents beside it — `paging` (review M5). */
async function cfEnvelope(
  cfg: Config,
  path: string,
  init: { method: string; body?: unknown; notFound?: (body: unknown) => boolean },
  deps: RealtimeKitDeps,
): Promise<CfBody & { data: NonNullable<unknown> }> {
  const base = (deps.baseUrl ?? process.env.REALTIMEKIT_BASE_URL ?? CF_BASE).replace(/\/$/, "");
  const url = `${base}/accounts/${cfg.accountId}/realtime/kit/${cfg.appId}${path}`;
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REALTIMEKIT_TIMEOUT_MS),
    });
  } catch {
    throw new RealtimeKitError(503, "unavailable", `RealtimeKit ${init.method} ${path} did not complete`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RealtimeKitError(
      res.status,
      "unauthorized",
      `RealtimeKit ${init.method} ${path} rejected our credentials`,
    );
  }
  if (res.status === 404) {
    const notFound = await res.json().then(init.notFound ?? isRealtimeKitNotFound, () => false);
    if (notFound) {
      throw new RealtimeKitError(404, "not_found", `RealtimeKit ${init.method} ${path} returned 404`);
    }
    throw new RealtimeKitError(
      404,
      "unavailable",
      `RealtimeKit ${init.method} ${path} returned a 404 that is not RealtimeKit's not-found answer`,
    );
  }
  if (!res.ok) {
    throw new RealtimeKitError(
      res.status,
      "unavailable",
      `RealtimeKit ${init.method} ${path} failed with ${res.status}`,
    );
  }
  // Every 2xx we call is documented with a `data` member (OpenAPI; none
  // documents a 204). A body we cannot parse, or one without data, is an
  // outage — never an empty answer a caller could read as "not live".
  let body: CfBody | null;
  try {
    body = (await res.json()) as CfBody | null;
  } catch {
    throw new RealtimeKitError(
      502,
      "unavailable",
      `RealtimeKit ${init.method} ${path} returned an unreadable body (${res.status})`,
    );
  }
  if (typeof body !== "object" || body === null || body.success === false) {
    throw new RealtimeKitError(
      res.status,
      "unavailable",
      `RealtimeKit ${init.method} ${path} failed with ${res.status}`,
    );
  }
  if (body.data === undefined || body.data === null) {
    throw new RealtimeKitError(502, "unavailable", `RealtimeKit ${init.method} ${path} returned no data`);
  }
  return body as CfBody & { data: NonNullable<unknown> };
}

/** `fixture_id` is the table's primary key, so a fixture has exactly one
 *  meeting row at a time — an ENDED one included. Once torn down (at the
 *  result, or at T+20 when nobody came — spec §5.2) there is nothing left to
 *  join for THAT pairing, and creating another would only make a billable
 *  meeting the row can never point at. */
function meetingEnded(fixtureId: string): HttpError {
  return new HttpError(409, `video meeting for fixture ${fixtureId} has ended`, "VIDEO_MEETING_ENDED");
}

/** R2-2: a meeting made for another pairing with a game behind it. Cannot happen through the product — M-10's lock
 *  (stages.ts lockBoardsRefusingOnlineGames) refuses a re-pair over a game — so it is refused by name: the meeting
 *  is that game's camera evidence, never replaced and never joined by a new pairing. */
function pairingChanged(fixtureId: string): HttpError {
  return new HttpError(409, `the video meeting for fixture ${fixtureId} belongs to an earlier pairing's game`, "VIDEO_MEETING_PAIRING_CHANGED");
}

/** R2-2, the empty case: a board with no pairing (unpaired, or a bye) has nobody to meet. */
function unpaired(fixtureId: string): HttpError {
  return new HttpError(409, `fixture ${fixtureId} has no pairing to make a video meeting for`, "VIDEO_MEETING_UNPAIRED");
}

/** A board whose meeting is a GAME's camera evidence: a game IS or MAY BE on file behind the bridge row `ep` at
 *  `now` — a recorded challenge, a sent create (T9's marker), or a LIVE mint claim (T9 in flight, before its
 *  marker; R2-3, the bound is the sweep's: liveMintClaimSince). The one rule for a meeting a re-pair left behind:
 *  the re-open spares it (N-2), and ensureMeeting never replaces it (R2-2). Reads the alias `ep`. */
export function gameEvidenceOn(now: Date) {
  return sql`(ep.challenge_id is not null or ep.create_sent_at is not null
              or (ep.status = 'pending' and ep.mint_claimed_at >= ${liveMintClaimSince(now)}))`;
}

type MeetingOnFile = { meetingId: string; endedAt: Date | null; samePair: boolean; evidence: boolean };

/** The board's meeting row, and whether it was made for the board's CURRENT pairing (R2-2). */
async function meetingOnFile(fixtureId: string, now: Date): Promise<MeetingOnFile | null> {
  const [row] = await sql<MeetingOnFile[]>`
    select m.meeting_id as "meetingId", m.ended_at as "endedAt",
           (m.home_entrant_id, m.away_entrant_id) is not distinct from (f.home_entrant_id, f.away_entrant_id) as "samePair",
           exists (select 1 from fixture_external_play ep where ep.fixture_id = m.fixture_id and ${gameEvidenceOn(now)}) as evidence
      from fixture_video_meetings m
      join fixtures f on f.id = m.fixture_id
     where m.fixture_id = ${fixtureId}`;
  return row ?? null;
}

/** R2-2: retire the board's meeting if it is (still) another pairing's with no game behind it — its row (its
 *  participants cascade: the player who moved, and the one who stayed, who re-seats into the new pairing's meeting),
 *  then the room at RealtimeKit, so no token of the old pairing is live in it. ONE statement judges and deletes, so
 *  a meeting a concurrent seat has just made for this pairing, or one a game has since appeared behind, is never
 *  taken: the caller's next read decides. An ended meeting is not asked again. Ending is best effort and never
 *  silent — its row is gone, so nothing hands out a token for it. */
async function retireStaleMeeting(fixtureId: string, now: Date, deps: RealtimeKitDeps): Promise<void> {
  const gone = await sql<{ meeting_id: string; ended_at: Date | null }[]>`
    delete from fixture_video_meetings m
     using fixtures f
     where m.fixture_id = ${fixtureId} and f.id = m.fixture_id
       and (m.home_entrant_id, m.away_entrant_id) is distinct from (f.home_entrant_id, f.away_entrant_id)
       and not exists (select 1 from fixture_external_play ep where ep.fixture_id = m.fixture_id and ${gameEvidenceOn(now)})
    returning m.meeting_id, m.ended_at`;
  const retired = gone[0];
  if (!retired || retired.ended_at !== null) return;
  try {
    await endMeeting(retired.meeting_id, deps);
  } catch (err) {
    log.error(
      { fixtureId, meetingId: retired.meeting_id, err: err instanceof Error ? err.message : String(err) },
      "realtimekit: could not end an earlier pairing's meeting — its row is gone and it is no longer used",
    );
  }
}

/** Created when the FIRST player arrives in the window, not after both check
 *  in — preflight needs something to join (spec §5.2). Idempotent per
 *  PAIRING (final re-review 2, R2-2): a re-pair keeps the fixture, so the
 *  meeting records the two entrants it was made for, and one made for
 *  another pair is retired and a fresh one made — every path to a seat
 *  (the lobby, a re-open, a direct link) and the arbiter's watch come
 *  through here. The loser of a creation race deactivates its own meeting
 *  rather than leaving a billable room nobody joins. */
export async function ensureMeeting(fixtureId: string, deps: RealtimeKitDeps = {}): Promise<MeetingRef> {
  const cfg = requireConfig();
  const now = new Date();
  const existing = await meetingOnFile(fixtureId, now);
  if (existing) {
    if (existing.samePair) {
      if (existing.endedAt !== null) throw meetingEnded(fixtureId);
      return { meetingId: existing.meetingId };
    }
    if (existing.evidence) throw pairingChanged(fixtureId);
    await retireStaleMeeting(fixtureId, now, deps);
  }

  const [fixture] = await sql<{ org_id: string; home: string | null; away: string | null }[]>`
    select org_id, home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
  if (!fixture) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  if (fixture.home === null || fixture.away === null) throw unpaired(fixtureId);

  // Outside any transaction — an open transaction across an outbound HTTP
  // call holds a row lock, or a pooled connection, for the whole round trip
  // (the same rule as mintIfReady's doc comment, usecases/external-play/room.ts).
  const data = (await cf(
    cfg,
    "/meetings",
    { method: "POST", body: { title: `seazn-fixture-${fixtureId}` } },
    deps,
  )) as { id?: unknown };
  if (typeof data.id !== "string" || data.id === "") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit create meeting returned no id");
  }
  // The pair stamped is the one READ above, before the create: a re-pair landing during the round trip leaves this
  // meeting stale on arrival, so the next read retires it — it never labels an older pairing's room as the new one's.
  const inserted = await sql<{ meeting_id: string }[]>`
    insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id)
    values (${fixtureId}, ${fixture.org_id}, ${data.id}, ${fixture.home}, ${fixture.away})
    on conflict (fixture_id) do nothing
    returning meeting_id`;
  const mine = inserted[0];
  if (mine) return { meetingId: mine.meeting_id };

  // Lost the race. Someone else's meeting is the one both players will be
  // added to, so ours must be stood down.
  await cf(
    cfg,
    `/meetings/${encodeURIComponent(data.id)}`,
    { method: "PATCH", body: { status: "INACTIVE" } },
    deps,
  ).catch(() => undefined);
  const winner = await meetingOnFile(fixtureId, now);
  if (!winner) throw new RealtimeKitError(503, "unavailable", "meeting row vanished mid-race");
  // The winner is the board's only if it was made for this pairing (R2-2): a stale row on file now — a game appeared
  // behind it before the retire, or another pairing's create landed after it — is refused, never handed to a new
  // pairing.
  if (!winner.samePair) {
    if (winner.evidence) throw pairingChanged(fixtureId);
    throw new RealtimeKitError(503, "unavailable", "the board's meeting changed while one was being made");
  }
  if (winner.endedAt !== null) throw meetingEnded(fixtureId);
  return { meetingId: winner.meetingId };
}

/** Presets, not code, are what make the camera mandatory: the `player`
 *  preset must be configured with video on at join and the video toggle
 *  DENIED. `addParticipant` therefore only ever names a preset from env —
 *  it never sends media permissions itself, so a preset change in the
 *  dashboard is the one place that rule lives. Mic muted by default is the
 *  same preset's job (spec §5.3: chess needs no audio).
 *
 *  `subject` becomes `custom_participant_id`; it must be an internal id (a
 *  person UUID), never an email or a name — Cloudflare's own guidance, and
 *  the same reason `name` is omitted below. The returned `participantId` is
 *  RealtimeKit's persistent participant id (the SDK's `self.userId`), which a
 *  session-participant row carries as `user_id` — see hasLiveVideoPublisher. */
export async function addParticipant(
  a: { meetingId: string; subject: string; preset: "player" | "arbiter" },
  deps: RealtimeKitDeps = {},
): Promise<ParticipantToken> {
  const cfg = requireConfig();
  const data = (await cf(
    cfg,
    `/meetings/${encodeURIComponent(a.meetingId)}/participants`,
    {
      method: "POST",
      // `name` is deliberately omitted: a player sees only their own tile
      // (D7), an arbiter already has the fixture's names from our own page,
      // and sending a child's display name to a third party for no product
      // reason is not something to do by default.
      body: { custom_participant_id: a.subject, preset_name: cfg.presets[a.preset] },
    },
    deps,
  )) as { id?: unknown; token?: unknown };
  if (typeof data.id !== "string" || typeof data.token !== "string" || data.token === "") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit add participant returned no id/token");
  }
  return { participantId: data.id, authToken: data.token };
}

/** A fresh authToken for a participant that already exists — what a
 *  returning player gets, so they keep ONE participant and peer discovery
 *  stays on one `user_id`. Tokens are deliberately never stored (a token at
 *  rest is a token to leak). Measured 2026-10-09 (rtk-token-regen.log):
 *  the regenerated token is a different JWT, and the earlier one keeps
 *  working — a tab already joined with it is not disconnected. */
export async function refreshParticipantToken(
  a: { meetingId: string; participantId: string },
  deps: RealtimeKitDeps = {},
): Promise<ParticipantToken> {
  const cfg = requireConfig();
  const data = (await cf(
    cfg,
    `/meetings/${encodeURIComponent(a.meetingId)}/participants/${encodeURIComponent(a.participantId)}/token`,
    { method: "POST" },
    deps,
  )) as { token?: unknown };
  if (typeof data.token !== "string" || data.token === "") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit token refresh returned no token");
  }
  return { participantId: a.participantId, authToken: data.token };
}

/** Removes one participant from a meeting (T15 fix round 1, I2): what ends
 *  an arbiter's access, because nothing else does — a token lasts 100 days
 *  and a refresh leaves the old one working (measured 2026-10-09). Two calls:
 *  - POST active-session/kick `{participant_ids: [id]}` takes it out of the
 *    live session. `id` is addParticipant's, which a session row carries as
 *    `user_id`. OpenAPI documents a 404 for "no participant found", and a
 *    room with nobody in it has no active session: ANY 404 is nothing to
 *    kick, as for endMeeting's kick-all — the DELETE that follows travels the
 *    same path prefix and is the proof;
 *  - DELETE participants/{id} retires it, so its token can never re-join.
 *    RealtimeKit's OWN not-found body is "already gone" (a repeat, or a race
 *    with another remover); any other failure throws, and the caller keeps
 *    its record to try again.
 *  Whether the kick disconnects a client already joined is the real SDK's to
 *  show (T17), never assumed here. */
export async function removeParticipant(
  a: { meetingId: string; participantId: string },
  deps: RealtimeKitDeps = {},
): Promise<void> {
  const cfg = requireConfig();
  const meeting = `/meetings/${encodeURIComponent(a.meetingId)}`;
  try {
    await cf(cfg, `${meeting}/active-session/kick`, { method: "POST", body: { participant_ids: [a.participantId] } }, deps);
  } catch (err) {
    if (!(err instanceof RealtimeKitError) || err.status !== 404) throw err;
  }
  try {
    await cf(cfg, `${meeting}/participants/${encodeURIComponent(a.participantId)}`, { method: "DELETE" }, deps);
  } catch (err) {
    if (!(err instanceof RealtimeKitError) || err.code !== "not_found") throw err;
  }
}

/** The largest page GET /sessions/{id}/participants serves (OpenAPI: default
 *  25, maximum 200). Every reload adds a row for the same participant, so the
 *  default page is the one most likely to run out. */
const PARTICIPANTS_PER_PAGE = 200;

/** Server-verified presence, which is the strongest thing RealtimeKit's REST
 *  surface can tell us (see this file's header and plan premise P-B2-6):
 *  TRUE means "a live session exists for this meeting and this participant is
 *  in it and has not left". It does NOT read a video track — no REST
 *  endpoint and no webhook exposes one. Camera-on is the preset's job.
 *
 *  `participantId` is what addParticipant returned. In a session-participant
 *  row that value is `user_id`; the row's own `id` is the session participant
 *  id, which is neither our id nor a peer id (measured 2026-10-09,
 *  rtk-peer-report.log tail / 7dde4a246; the recorded report agrees). Whether
 *  a reload adds a row or only new peer events is unmeasured, so the question
 *  is whether ANY of this participant's rows has not left.
 *
 *  RealtimeKit's own well-formed 404 on the active session is a normal
 *  "nobody has joined yet" and answers false, as does an exact ENDED; any
 *  other failure, and any answer we cannot read, THROWS,
 *  because a silent false would refuse a seat during a vendor outage, and
 *  D11's organiser override exists precisely so an outage is handled by a
 *  person, not by a guess. */
export async function hasLiveVideoPublisher(
  a: { meetingId: string; participantId: string },
  deps: RealtimeKitDeps = {},
): Promise<boolean> {
  const cfg = requireConfig();
  let session: { id?: unknown; status?: unknown };
  try {
    session = (await cf(
      cfg,
      `/meetings/${encodeURIComponent(a.meetingId)}/active-session`,
      { method: "GET", notFound: isActiveSessionAbsent },
      deps,
    )) as { id?: unknown; status?: unknown };
  } catch (err) {
    if (err instanceof RealtimeKitError && err.code === "not_found") return false;
    throw err;
  }
  // OpenAPI closes the enum at LIVE | ENDED. Only an exact ENDED (or the
  // well-formed 404 above) means "not live"; any other value is an answer we
  // cannot read, and a false would refuse the seat as "camera off".
  if (session.status === "ENDED") return false;
  if (session.status !== "LIVE") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit active session has a status outside LIVE | ENDED");
  }
  if (typeof session.id !== "string" || session.id === "") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit active session is LIVE but has no id");
  }
  const data = (await cf(
    cfg,
    `/sessions/${encodeURIComponent(session.id)}/participants?per_page=${PARTICIPANTS_PER_PAGE}`,
    { method: "GET" },
    deps,
  )) as { participants?: unknown };
  if (!Array.isArray(data.participants)) {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit session participants returned no list");
  }
  const rows = data.participants as unknown[];
  const present = rows.some((r) => {
    const p = r as { user_id?: unknown; left_at?: unknown };
    return p.user_id === a.participantId && (p.left_at === null || p.left_at === undefined);
  });
  if (present) return true;
  // A full page that does not contain us cannot prove absence: the live row
  // may be on the next page. Say so rather than answer "camera off".
  if (rows.length >= PARTICIPANTS_PER_PAGE) {
    throw new RealtimeKitError(
      502,
      "unavailable",
      `RealtimeKit session has ${PARTICIPANTS_PER_PAGE}+ participant rows; presence not provable from one page`,
    );
  }
  return false;
}

/** Torn down at the result, or at T+20 if nobody came (spec §5.2). There is
 *  no "delete meeting" endpoint — the recipe is kick-all then
 *  status INACTIVE, which is what stops anyone joining afterwards. The
 *  kick's 404 ("no active session") is the ordinary quiet-room case and must
 *  not skip the deactivate. OpenAPI documents no 404 for kick-all, so ANY
 *  404 there is tolerated, whatever its body: the PATCH that follows travels
 *  the same path prefix, so a routing or proxy 404 fails it too, and its
 *  success is the proof of teardown. The row is stamped only AFTER the deactivate
 *  succeeds — a failed PATCH leaves a joinable meeting upstream, so the row
 *  must stay unended for the next sweep to retry — and only once: a repeat
 *  call keeps the first teardown time. The room's arbiter watches are
 *  stamped removed with it (T15 fix round 1, I2). */
export async function endMeeting(meetingId: string, deps: RealtimeKitDeps = {}): Promise<void> {
  const cfg = requireConfig();
  const id = encodeURIComponent(meetingId);
  try {
    await cf(cfg, `/meetings/${id}/active-session/kick-all`, { method: "POST" }, deps);
  } catch (err) {
    if (!(err instanceof RealtimeKitError) || err.status !== 404) throw err;
  }
  await cf(cfg, `/meetings/${id}`, { method: "PATCH", body: { status: "INACTIVE" } }, deps);
  // T15 fix round 1, I2: every arbiter watch of this room ends with it, at
  // the same instant (one statement) — the kick-all took them out and
  // INACTIVE keeps every token out, so nothing is left to remove one by one
  // at the vendor. A watch whose room already ended is the sweep's to stamp.
  await sql`
    with ended as (
      update fixture_video_meetings set ended_at = now()
       where meeting_id = ${meetingId} and ended_at is null
      returning fixture_id
    )
    update fixture_video_participants vp set removed_at = now()
      from ended
     where vp.fixture_id = ended.fixture_id and vp.preset = 'arbiter' and vp.removed_at is null`;
}

// ─── Camera evidence after the match: the peer report ──────────────────────
//
// GET /sessions/peer-report/{peer_id}. SDK telemetry (see the header): the
// RealtimeKit client uploads encoder-side `video_producer` samples and
// `metadata.events`. Measured 2026-10-09 (rtk-peer-report.log): frozen at the
// join snapshot until the participant leaves, final ~70 s after; a camera
// turned off is a GAP in the samples plus `video_off`/`video_on` events, and
// `video_producer_cumulative.issues.no_video_fraction` stayed 0 through three
// minutes off — so that field is never read here. Organiser evidence only:
// never a seat-gate input, never an automatic outcome (spec §5.2).

/** Sample cadence measured in the spike: 51 samples ~7 s apart (web SDK
 *  2.0.2). Used when a report has too few samples to measure its own, and as
 *  a CEILING on the measured one — see videoOffCoverage. */
export const PEER_REPORT_SAMPLE_CADENCE_MS = 7_000;
/** FLOOR on the cadence. The spike's 50 deltas were 6.99–7.003 s, so a
 *  median under 5 s is a data-shape artefact (duplicate or burst samples),
 *  not the SDK's cadence — and left alone it collapses the threshold to
 *  ~0 and reads a camera that was on throughout as off for the whole match
 *  (review I3). 5 s keeps the gap threshold at >= 15 s. */
export const PEER_REPORT_MIN_CADENCE_MS = 5_000;
/** A gap is camera-off when consecutive points are MORE than this many
 *  cadences apart (controller ruling 2026-10-09). */
export const VIDEO_OFF_GAP_CADENCES = 3;

export type VideoOffInterval = {
  /** ISO timestamps of the last sample (or joined_at) before the gap and the
   *  first sample (or left_at) after it. The interval BRACKETS the time the
   *  camera was off, so it overstates by up to one cadence on each side. */
  from: string;
  to: string;
  seconds: number;
  /** A `video_off`…`video_on` span from the events overlaps this gap. */
  confirmedByEvents: boolean;
};

export type VideoOffCoverage =
  | {
      /** Not final yet — the report is frozen until the participant leaves and
       *  settles ~70 s later. The caller retries; it never shows a partial. */
      incomplete: true;
      reason: "not_left" | "not_finalised";
      sampleCount: number;
    }
  | {
      incomplete: false;
      /** The connection's own span, ISO — what a match unions across reloads
       *  and rejoins (T13, controller ruling C1). */
      joinedAt: string;
      leftAt: string;
      /** Seconds of [joined_at, left_at] this report covers — the denominator. */
      coveredSeconds: number;
      /** Sum of offIntervals' seconds. */
      offSeconds: number;
      offIntervals: VideoOffInterval[];
      /** `video_producer` samples in the report. */
      sampleCount: number;
      /** The cadence the gap threshold was computed from. */
      cadenceSeconds: number;
      /** Seconds the `video_off`/`video_on` events alone say the camera was
       *  off, clamped to the window. Shown beside offSeconds, so a
       *  disagreement between the two sources is visible, not resolved by us. */
      eventOffSeconds: number;
    };

function malformed(what: string): RealtimeKitError {
  return new RealtimeKitError(502, "unavailable", `RealtimeKit peer report is malformed: ${what}`);
}

function parseTime(v: unknown, what: string): number {
  const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(ms)) throw malformed(what);
  return ms;
}

/** Off-coverage over [joined_at, left_at] from ONE peer report's `data`.
 *
 *  Points are joined_at, every sample inside the window, and left_at; any two
 *  consecutive points more than VIDEO_OFF_GAP_CADENCES × cadence apart are an
 *  off interval — which covers the join→first-sample and last-sample→leave
 *  edges, and a report with no samples at all (the whole window is off).
 *
 *  Cadence is the median gap between distinct sample times, clamped to
 *  [5 s, 7 s]. The 7 s CAP is not cosmetic: a camera flashed on for one
 *  sample every three minutes has a median gap of 180 s, a raw threshold of
 *  540 s, and would read as 0 s off. The 5 s FLOOR stops duplicate or burst
 *  samples dragging the median to ~0 and reading a camera that was on
 *  throughout as off.
 *
 *  A report that cannot be read THROWS rather than reading as camera on or
 *  off; an unfinished one returns `incomplete` so the caller retries. */
export function videoOffCoverage(data: unknown): VideoOffCoverage {
  const p = (data as { participant?: unknown } | null)?.participant as
    | {
        joined_at?: unknown;
        left_at?: unknown;
        duration?: unknown;
        peer_report?: {
          metadata?: { events?: unknown };
          quality?: { video_producer?: unknown };
        };
      }
    | undefined;
  if (typeof p !== "object" || p === null) throw malformed("no participant");
  const joined = parseTime(p.joined_at, "joined_at");
  const rawSamples = p.peer_report?.quality?.video_producer ?? [];
  if (!Array.isArray(rawSamples)) throw malformed("video_producer is not a list");
  const sampleCount = rawSamples.length;

  if (p.left_at === null || p.left_at === undefined) return { incomplete: true, reason: "not_left", sampleCount };
  if (typeof p.duration !== "number" || !(p.duration > 0)) {
    return { incomplete: true, reason: "not_finalised", sampleCount };
  }
  const left = parseTime(p.left_at, "left_at");
  if (left < joined) throw malformed("left_at is before joined_at");

  // De-duplicated: a sample reported twice at the same instant is one
  // sample, not a 0 s cadence.
  const inWindow = [
    ...new Set(
      rawSamples
        .map((s, i) => parseTime((s as { timestamp?: unknown } | null)?.timestamp, `video_producer[${i}].timestamp`))
        .filter((t) => t >= joined && t <= left),
    ),
  ].sort((a, b) => a - b);

  const deltas: number[] = [];
  for (let i = 1; i < inWindow.length; i += 1) deltas.push(inWindow[i]! - inWindow[i - 1]!);
  const cadence =
    deltas.length === 0
      ? PEER_REPORT_SAMPLE_CADENCE_MS
      : Math.max(PEER_REPORT_MIN_CADENCE_MS, Math.min(median(deltas), PEER_REPORT_SAMPLE_CADENCE_MS));
  const threshold = VIDEO_OFF_GAP_CADENCES * cadence;

  const eventSpans = videoOffEventSpans(p.peer_report?.metadata?.events, joined, left);

  const points = [joined, ...inWindow, left];
  const offIntervals: VideoOffInterval[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]!;
    const to = points[i]!;
    if (to - from > threshold) {
      offIntervals.push({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        seconds: (to - from) / 1000,
        confirmedByEvents: eventSpans.some(([a, b]) => a < to && b > from),
      });
    }
  }
  return {
    incomplete: false,
    joinedAt: new Date(joined).toISOString(),
    leftAt: new Date(left).toISOString(),
    coveredSeconds: (left - joined) / 1000,
    offSeconds: offIntervals.reduce((n, iv) => n + iv.seconds, 0),
    offIntervals,
    sampleCount,
    cadenceSeconds: cadence / 1000,
    eventOffSeconds: eventSpans.reduce((n, [a, b]) => n + (b - a), 0) / 1000,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** `video_off` opens a span (a repeat while already off is ignored),
 *  `video_on` closes it, and a span still open at the end closes at left_at.
 *  Spans are clamped to [joined, left]; empty ones are dropped. Every other
 *  event name is ignored. */
function videoOffEventSpans(raw: unknown, joined: number, left: number): [number, number][] {
  const events = (Array.isArray(raw) ? raw : [])
    .map((e, i) => {
      const ev = e as { name?: unknown; timestamp?: unknown } | null;
      return { name: ev?.name, at: parseTime(ev?.timestamp, `events[${i}].timestamp`) };
    })
    .filter((e) => e.name === "video_off" || e.name === "video_on")
    .sort((a, b) => a.at - b.at);
  const spans: [number, number][] = [];
  let offSince: number | null = null;
  for (const e of events) {
    if (e.name === "video_off" && offSince === null) offSince = e.at;
    else if (e.name === "video_on" && offSince !== null) {
      spans.push([offSince, e.at]);
      offSince = null;
    }
  }
  if (offSince !== null) spans.push([offSince, left]);
  return spans
    .map(([a, b]): [number, number] => [Math.max(a, joined), Math.min(b, left)])
    .filter(([a, b]) => b > a);
}

/** Fetch one peer's report and return ONLY its off-coverage. The unredacted
 *  report carries IP, device and browser metadata; nothing of it leaves this
 *  function except the coverage, so a caller cannot store it by accident.
 *
 *  `peerId` is a PEER id — the SDK's `meeting.self.id`, or a `peer_id` from
 *  the session participant's `peer_events` — never the participant id
 *  addParticipant returned (that 404s: Cloudflare RealtimeKit FAQ). Fetch it
 *  at least ~2 minutes after the participant leaves (final ~70 s after,
 *  measured) and retry while the answer is `incomplete`. */
export async function fetchVideoOffCoverage(
  peerId: string,
  deps: RealtimeKitDeps = {},
): Promise<VideoOffCoverage> {
  const cfg = requireConfig();
  const data = await cf(cfg, `/sessions/peer-report/${encodeURIComponent(peerId)}`, { method: "GET" }, deps);
  return videoOffCoverage(data);
}

function malformedList(what: string): RealtimeKitError {
  return new RealtimeKitError(502, "unavailable", `RealtimeKit session participants are malformed: ${what}`);
}

/** Every PEER id one participant had in one session — the ids the peer report
 *  takes (fetchVideoOffCoverage). MEASURED 2026-10-09 on the spike's ended
 *  session (rtk-peer-report.log tail, 7dde4a246): with
 *  `include_peer_events=true` a row carries `id` (the session participant id —
 *  NOT a peer id, whatever the OpenAPI wording says), `user_id` (our
 *  add-participant id) and `peer_events[]` (PEER_JOINING / PEER_LEAVING) whose
 *  `peer_id` is the client's `meeting.self.id`. Discovered server-side, so
 *  the evidence never rests on a peer id a client chose to report.
 *
 *  The answer is the union of peer_events[].peer_id over every row whose
 *  `user_id` matches, first-seen order, each once — a reload may add a row or
 *  only new events, and both are covered. A body that cannot prove the list
 *  complete THROWS: a short list would hide a reconnect's coverage, and an
 *  empty one reads as "never joined". */
export async function listPeerIds(
  sessionId: string,
  participantUserId: string,
  deps: RealtimeKitDeps = {},
): Promise<string[]> {
  if (!sessionId || !participantUserId) {
    throw new Error("listPeerIds needs a session id and a participant user id");
  }
  const cfg = requireConfig();
  const data = (await cf(
    cfg,
    `/sessions/${encodeURIComponent(sessionId)}/participants?include_peer_events=true&per_page=${PARTICIPANTS_PER_PAGE}`,
    { method: "GET" },
    deps,
  )) as { participants?: unknown };
  if (!Array.isArray(data.participants)) throw malformedList("no participants list");
  const rows = data.participants as unknown[];
  if (rows.length >= PARTICIPANTS_PER_PAGE) {
    throw malformedList(`${PARTICIPANTS_PER_PAGE}+ rows; the peer list is not provable from one page`);
  }
  const peers: string[] = [];
  rows.forEach((r, i) => {
    const row = r as { user_id?: unknown; peer_events?: unknown } | null;
    if (typeof row !== "object" || row === null || typeof row.user_id !== "string") {
      throw malformedList(`participants[${i}] has no user_id`);
    }
    if (row.user_id !== participantUserId) return;
    if (!Array.isArray(row.peer_events)) throw malformedList(`participants[${i}].peer_events is not a list`);
    (row.peer_events as unknown[]).forEach((e, j) => {
      const peer = (e as { peer_id?: unknown } | null)?.peer_id;
      if (typeof peer !== "string" || peer === "") {
        throw malformedList(`participants[${i}].peer_events[${j}] has no peer_id`);
      }
      if (!peers.includes(peer)) peers.push(peer);
    });
  });
  return peers;
}

/** The page size GET /sessions is asked for. Completeness is never read off
 *  the page size (a server cap under it would read a short list as whole —
 *  review M5): the envelope's `paging.total_count` must equal the rows. */
const SESSIONS_PER_PAGE = 100;

export type MeetingSession = {
  id: string;
  status: "LIVE" | "ENDED";
  startedAt: string;
  /** Null while LIVE, and when the API omits it. */
  endedAt: string | null;
};

function malformedSessions(what: string): RealtimeKitError {
  return new RealtimeKitError(502, "unavailable", `RealtimeKit sessions are malformed: ${what}`);
}

/** Every session one meeting ever had (T13, controller ruling C1). A reload
 *  is a new PEER in the same session; a rejoin after everyone left is a new
 *  SESSION — so a match's camera evidence is read over all of them.
 *
 *  `GET /sessions?associated_id=<meeting id>` (Cloudflare's API reference,
 *  "Fetch all sessions of an App": `data.sessions[]` with id, associated_id,
 *  status LIVE | ENDED, started_at, ended_at). NOT measured live — T17 owes
 *  that. Rows of another meeting are dropped by `associated_id` whatever the
 *  filter did; a row whose meeting cannot be read, a malformed row of ours,
 *  and a page that is not the WHOLE list — `paging.total_count` (the OpenAPI
 *  envelope, beside `data`) absent, unreadable, or not exactly the rows on
 *  the page — all THROW: a short list would hide a rejoin's coverage and read
 *  as "camera off", and an outage must never read as that. */
export async function listMeetingSessions(meetingId: string, deps: RealtimeKitDeps = {}): Promise<MeetingSession[]> {
  if (!meetingId) throw new Error("listMeetingSessions needs a meeting id");
  const cfg = requireConfig();
  const body = await cfEnvelope(
    cfg,
    `/sessions?associated_id=${encodeURIComponent(meetingId)}&per_page=${SESSIONS_PER_PAGE}`,
    { method: "GET" },
    deps,
  );
  const data = body.data as { sessions?: unknown };
  if (!Array.isArray(data.sessions)) throw malformedSessions("no sessions list");
  const rows = data.sessions as unknown[];
  const total = (body.paging as { total_count?: unknown } | null | undefined)?.total_count;
  // Exactly the rows: more is a page cut short, fewer an envelope that
  // contradicts itself, and anything not a number (absent included) is no
  // count at all.
  if (total !== rows.length) {
    throw malformedSessions(
      `${rows.length} rows, paging.total_count ${JSON.stringify(total) ?? "absent"}; the session list is not provable whole`,
    );
  }
  const out: MeetingSession[] = [];
  rows.forEach((r, i) => {
    const row = r as {
      id?: unknown;
      associated_id?: unknown;
      status?: unknown;
      started_at?: unknown;
      ended_at?: unknown;
    } | null;
    if (typeof row !== "object" || row === null || typeof row.associated_id !== "string") {
      throw malformedSessions(`sessions[${i}] has no associated_id`);
    }
    if (row.associated_id !== meetingId) return;
    if (typeof row.id !== "string" || row.id === "") throw malformedSessions(`sessions[${i}] has no id`);
    if (row.status !== "LIVE" && row.status !== "ENDED") {
      throw malformedSessions(`sessions[${i}] has a status outside LIVE | ENDED`);
    }
    const startedAt = new Date(parseSessionTime(row.started_at, `sessions[${i}].started_at`)).toISOString();
    const endedAt =
      row.ended_at === null || row.ended_at === undefined
        ? null
        : new Date(parseSessionTime(row.ended_at, `sessions[${i}].ended_at`)).toISOString();
    out.push({ id: row.id, status: row.status, startedAt, endedAt });
  });
  return out;
}

function parseSessionTime(v: unknown, what: string): number {
  const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(ms)) throw malformedSessions(`${what} is not a date`);
  return ms;
}
