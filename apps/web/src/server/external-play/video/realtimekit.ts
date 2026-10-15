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
// forgeable surface spec §5.2 rejects. Presence alone proves only "joined to
// a live session and not left" — and the preset does NOT enforce camera-on
// (T17B, measured live 2026-10-14: a player whose browser DENIED the camera
// joined, was seated, and a game was created). P-B2-6's "camera-on is the
// preset's job" was false.
//
// What does tell the two apart is the peer report (GET
// /sessions/peer-report/{peer_id}): SDK telemetry the RealtimeKit client
// uploads — `metadata.events` (`media_permission`, `video_on`/`video_off`)
// and `quality.video_producer` samples. It is NOT frozen at the join
// snapshot (the 2026-10-09 spike's reading was wrong): measured live on
// 2026-10-14 it accumulates during the session — `media_permission` was on
// the report 1.4 s after PEER_JOINING — while the producer SAMPLES arrive
// late and in batches (none for 90 s from a peer publishing 6 MB), so they
// are never a seat-time signal. The seat reads the current peer's
// permission and its latest on/off event (`seatCameraEvidence`); the
// samples stay organiser evidence after a match (`videoOffCoverage`).
// Residual, accepted: it is client-uploaded, so a tampered client could
// forge it — it closes the honest-browser gap, not a determined forger.
//
// No credential has a default, and there is no mock fallback. The POC
// returns `mock-token-*` whenever credentials are missing; here an
// unconfigured process refuses loudly, because a silently-mocked camera gate
// on a Required division is a tournament played with no camera at all.
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { liveMintClaimSince } from "@/server/external-play/window";
import { log } from "@/server/logger";
import { budgetKey, takeRealtimeKitCall, type CallBudget } from "./budget";

export const REALTIMEKIT_TIMEOUT_MS = 10_000;

export type RealtimeKitCode = "unconfigured" | "unauthorized" | "not_found" | "unavailable" | "deferred";

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

/** The request was NOT made: the platform's RealtimeKit call budget (budget.ts, D21) is spent. Not an outage and not an
 *  answer — "ask again shortly". A subtype, so a caller that only knows `RealtimeKitError` still treats it as "video,
 *  not now"; a caller that can wait (the seat, the sweep) tells it apart with `instanceof`, because reading it as an
 *  outage would tell a player their video is down, and reading it as "no camera" would flag a camera that is fine. */
export class RealtimeKitDeferred extends RealtimeKitError {
  constructor(message: string) {
    super(429, "deferred", message);
    this.name = "RealtimeKitDeferred";
  }
}

/** `budget` — who spends a token for each request. Default: the platform's database bucket for the real `fetch` to
 *  Cloudflare's own API (the path that counts against the vendor's limit), and none otherwise (cfEnvelope says why).
 *  A test passes its own to drive a refusal without a database. */
export type RealtimeKitDeps = { fetch?: typeof fetch; baseUrl?: string; budget?: CallBudget };

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

let warnedUnmetered = false;
/** Once per process, in production only: RealtimeKit calls are going to a base URL that is not Cloudflare's, so the call
 *  budget (budget.ts) is NOT spending for them. Right for a fixture; wrong for a proxy in front of the real API, whose
 *  traffic would count against the account's limit unmetered. The warning names the base and nothing else (no token). */
function warnUnmetered(base: string): void {
  if (warnedUnmetered || process.env.NODE_ENV !== "production") return;
  warnedUnmetered = true;
  log.warn(
    { base },
    "RealtimeKit: REALTIMEKIT_BASE_URL is not Cloudflare's API, so the call budget does not meter these calls. Expected for a test fixture; a forwarding proxy to the real account needs its own limit",
  );
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
  // D21: ONE token per request, taken BEFORE it is made (never after — a refused request must not reach the vendor, whose
  // limit is the account's and blocks every call for five minutes once passed). Metered by default on the path that
  // counts against the vendor — the real `fetch` to Cloudflare's own API — so a new caller cannot forget. Exempt: a
  // caller-supplied `fetch` (a test double that never leaves the process) and a base URL that is not Cloudflare's (a
  // fixture, where a bucket would only throttle the suites and the e2e run that use it). The gate FAILS OPEN on a base
  // that is not Cloudflare's: a forwarding proxy, or a misspelt URL, spends the real account's budget and is NOT metered
  // - which is why that case warns once per process in production (warnUnmetered) and why .env.example says so. A
  // caller can always pass its own `budget`.
  const metered = deps.fetch === undefined && base === CF_BASE;
  if (!metered && deps.budget === undefined && deps.fetch === undefined) warnUnmetered(base);
  const spend = deps.budget ?? (metered ? takeRealtimeKitCall : null);
  if (spend && !(await spend(budgetKey(base, cfg.accountId)))) {
    throw new RealtimeKitDeferred(`RealtimeKit ${init.method} ${path} deferred: the platform's call budget is spent`);
  }
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
  // added to, so ours must be stood down. Best effort: a refusal (the call budget, D21) leaves our unused meeting active
  // at the vendor - nothing holds its id, so nothing retries it.
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

/** The preset names the role — the player publishes, the arbiter only
 *  receives — and `addParticipant` only ever names one from env; it never
 *  sends media permissions itself. A preset does NOT make the camera
 *  mandatory (T17B, measured 2026-10-14: a player whose browser denied the
 *  camera joined on the player preset): the seat reads the peer's own
 *  report for that (`seatCameraEvidence`). Mic muted by default is the
 *  preset's job (spec §5.3: chess needs no audio).
 *
 *  `subject` becomes `custom_participant_id`; it must be an internal id (a
 *  person UUID), never an email or a name — Cloudflare's own guidance, and
 *  the same reason `name` is omitted below. The returned `participantId` is
 *  RealtimeKit's persistent participant id (the SDK's `self.userId`), which a
 *  session-participant row carries as `user_id` — see seatCameraEvidence. */
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

/** The meeting's LIVE session id, or null when there is none: RealtimeKit's
 *  own well-formed 404 on the active session is a normal "nobody has joined
 *  yet", as is an exact ENDED; any other failure, and any answer we cannot
 *  read, THROWS, because a silent null would refuse a seat during a vendor
 *  outage, and D11's organiser override exists precisely so an outage is
 *  handled by a person, not by a guess. */
async function liveSessionId(cfg: Config, meetingId: string, deps: RealtimeKitDeps): Promise<string | null> {
  let session: { id?: unknown; status?: unknown };
  try {
    session = (await cf(
      cfg,
      `/meetings/${encodeURIComponent(meetingId)}/active-session`,
      { method: "GET", notFound: isActiveSessionAbsent },
      deps,
    )) as { id?: unknown; status?: unknown };
  } catch (err) {
    if (err instanceof RealtimeKitError && err.code === "not_found") return null;
    throw err;
  }
  // OpenAPI closes the enum at LIVE | ENDED. Only an exact ENDED (or the
  // well-formed 404 above) means "not live"; any other value is an answer we
  // cannot read, and a null would refuse the seat as "camera off".
  if (session.status === "ENDED") return null;
  if (session.status !== "LIVE") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit active session has a status outside LIVE | ENDED");
  }
  if (typeof session.id !== "string" || session.id === "") {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit active session is LIVE but has no id");
  }
  return session.id;
}

/** The seat's camera evidence for one participant (T17B fix 2, D2):
 *  - `absent`: no live session, or this participant is not in it (never
 *    joined, or left) — or present with no peer still connected;
 *  - `on`: the CURRENT peer's report holds `media_permission` VIDEO ACCEPTED
 *    and its latest `video_on`/`video_off` event is `video_on`;
 *  - `off`: ACCEPTED, but the latest of those events is `video_off`;
 *  - `blocked`: the current peer's browser DENIED the camera (DENIED, or
 *    the SDK's SYSTEM_DENIED — an OS privacy setting) — `video_on` is logged
 *    even then, so it is intent, never proof;
 *  - `starting`: present, but the report holds neither yet (or RealtimeKit
 *    has no report for the peer yet);
 *  - `unreadable`: present, but the peer report could not be read — an
 *    outage on THAT read, which the seat waits out like `starting` and only
 *    then answers as one (the caller rethrows `error`).
 *  `since` is the current peer's PEER_JOINING time: the seat's wait for the
 *  evidence runs from it. `video_producer` samples are never read here —
 *  measured late and batched, they would refuse an honest camera.
 *
 *  `participantId` is what addParticipant returned — a session-participant
 *  row's `user_id`, never its `id` (measured 2026-10-09, 7dde4a246). A reload
 *  adds a new peer under the SAME row (measured 2026-10-14); a second row is
 *  still read, whichever way the vendor goes. The "current peer" is the
 *  latest PEER_JOINING with no PEER_LEAVING after it, across this
 *  participant's present rows — an old peer that left is never judged. */
export type SeatCamera =
  | { state: "absent" }
  | { state: "on" | "off" | "blocked"; since: Date }
  | { state: "starting"; since: Date }
  | { state: "unreadable"; since: Date; error: RealtimeKitError };

export async function seatCameraEvidence(
  a: { meetingId: string; participantId: string },
  deps: RealtimeKitDeps = {},
): Promise<SeatCamera> {
  const cfg = requireConfig();
  const sessionId = await liveSessionId(cfg, a.meetingId, deps);
  if (sessionId === null) return { state: "absent" };
  const data = (await cf(
    cfg,
    `/sessions/${encodeURIComponent(sessionId)}/participants?include_peer_events=true&per_page=${PARTICIPANTS_PER_PAGE}`,
    { method: "GET" },
    deps,
  )) as { participants?: unknown };
  if (!Array.isArray(data.participants)) {
    throw new RealtimeKitError(502, "unavailable", "RealtimeKit session participants returned no list");
  }
  const rows = data.participants as unknown[];
  const mine = rows.filter((r) => {
    const p = r as { user_id?: unknown; left_at?: unknown } | null;
    return p?.user_id === a.participantId && (p.left_at === null || p.left_at === undefined);
  });
  if (mine.length === 0) {
    // A full page that does not contain us cannot prove absence: the live row
    // may be on the next page. Say so rather than answer "camera off".
    if (rows.length >= PARTICIPANTS_PER_PAGE) {
      throw new RealtimeKitError(
        502,
        "unavailable",
        `RealtimeKit session has ${PARTICIPANTS_PER_PAGE}+ participant rows; presence not provable from one page`,
      );
    }
    return { state: "absent" };
  }
  const peer = currentPeer(mine);
  if (peer === null) return { state: "absent" };
  const since = new Date(peer.joinedAt);
  let report: unknown;
  try {
    report = await cf(cfg, `/sessions/peer-report/${encodeURIComponent(peer.peerId)}`, { method: "GET" }, deps);
  } catch (err) {
    if (!(err instanceof RealtimeKitError)) throw err;
    // D21: a read we did not make says nothing about the vendor or the camera — never `unreadable`, which the seat
    // waits out and then reports as an outage.
    if (err instanceof RealtimeKitDeferred) throw err;
    // RealtimeKit's own "no peer event exists for id" (measured body): no
    // report for this peer YET — not an outage, and not a camera.
    if (err.code === "not_found") return { state: "starting", since };
    return { state: "unreadable", since, error: err };
  }
  let camera: "on" | "off" | "blocked" | "starting";
  try {
    camera = cameraFromReport(report);
  } catch (err) {
    if (!(err instanceof RealtimeKitError)) throw err;
    return { state: "unreadable", since, error: err };
  }
  return { state: camera, since };
}

/** The SDK's VIDEO permission values that mean "the browser (or the OS)
 *  refused the camera" (web-core 2.0.2: DENIED, SYSTEM_DENIED). */
const CAMERA_REFUSED = new Set(["DENIED", "SYSTEM_DENIED"]);

function malformedPeers(what: string): RealtimeKitError {
  return new RealtimeKitError(502, "unavailable", `RealtimeKit session participants are malformed: ${what}`);
}

/** The latest PEER_JOINING with no PEER_LEAVING for the same peer, over the
 *  given (present) rows; null when every peer has left. A list we cannot read
 *  THROWS — an unreadable answer is an outage, never "camera off". */
function currentPeer(rows: unknown[]): { peerId: string; joinedAt: number } | null {
  const joined = new Map<string, number>();
  const left = new Set<string>();
  rows.forEach((r, i) => {
    const events = (r as { peer_events?: unknown }).peer_events;
    if (!Array.isArray(events)) throw malformedPeers(`participants[${i}].peer_events is not a list`);
    (events as unknown[]).forEach((e, j) => {
      const ev = e as { event_name?: unknown; peer_id?: unknown; created_at?: unknown } | null;
      if (typeof ev?.peer_id !== "string" || ev.peer_id === "") {
        throw malformedPeers(`participants[${i}].peer_events[${j}] has no peer_id`);
      }
      if (ev.event_name === "PEER_LEAVING") left.add(ev.peer_id);
      if (ev.event_name !== "PEER_JOINING") return;
      const at = typeof ev.created_at === "string" ? Date.parse(ev.created_at) : Number.NaN;
      if (!Number.isFinite(at)) throw malformedPeers(`participants[${i}].peer_events[${j}].created_at is not a date`);
      joined.set(ev.peer_id, Math.max(at, joined.get(ev.peer_id) ?? at));
    });
  });
  let best: { peerId: string; joinedAt: number } | null = null;
  for (const [peerId, joinedAt] of joined) {
    if (left.has(peerId)) continue;
    if (best === null || joinedAt >= best.joinedAt) best = { peerId, joinedAt };
  }
  return best;
}

/** One peer report's camera, from `metadata.events` alone. No events list
 *  yet (a peer whose SDK has not uploaded) is `starting`; a list we cannot
 *  read THROWS. Events are ordered by their timestamp, ties kept in the
 *  report's own order — the SDK logs the join's `video_on`, `media_permission`
 *  and (when denied) `video_off` at the same millisecond. */
function cameraFromReport(data: unknown): "on" | "off" | "blocked" | "starting" {
  const participant = (data as { participant?: unknown } | null)?.participant as
    | { peer_report?: { metadata?: { events?: unknown } | null } | null }
    | undefined;
  if (typeof participant !== "object" || participant === null) throw malformed("no participant");
  const raw = participant.peer_report?.metadata?.events;
  if (raw === undefined || raw === null) return "starting";
  if (!Array.isArray(raw)) throw malformed("metadata.events is not a list");
  const events = (raw as unknown[]).map((e, i) => {
    const ev = e as { name?: unknown; timestamp?: unknown; metadata?: { device_type?: unknown; permission?: unknown } | null } | null;
    if (typeof ev?.name !== "string") throw malformed(`events[${i}] has no name`);
    return { name: ev.name, at: parseTime(ev.timestamp, `events[${i}].timestamp`), metadata: ev.metadata ?? null, i };
  });
  const video = events.filter((e) => e.name === "media_permission" && e.metadata?.device_type === "VIDEO");
  if (video.some((e) => CAMERA_REFUSED.has(String(e.metadata?.permission)))) return "blocked";
  const accepted = video.some((e) => e.metadata?.permission === "ACCEPTED");
  const toggles = events
    .filter((e) => e.name === "video_on" || e.name === "video_off")
    .sort((x, y) => x.at - y.at || x.i - y.i);
  const latest = toggles.at(-1)?.name;
  if (accepted && latest === "video_on") return "on";
  if (accepted && latest === "video_off") return "off";
  return "starting";
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
// `metadata.events`. Measured 2026-10-09 (rtk-peer-report.log): final ~70 s
// after the participant leaves; a camera turned off is a GAP in the samples
// plus `video_off`/`video_on` events, and
// `video_producer_cumulative.issues.no_video_fraction` stayed 0 through three
// minutes off — so that field is never read here. (The spike's "frozen at the
// join snapshot" was wrong — measured live 2026-10-14, the report accumulates
// — but its samples arrive late and batched.) The off-coverage below is
// organiser evidence only, never an automatic outcome (spec §5.2); the seat
// reads only the events (`seatCameraEvidence`).

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
