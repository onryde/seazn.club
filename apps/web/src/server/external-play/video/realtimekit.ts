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
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const appId = process.env.REALTIMEKIT_APP_ID ?? "";
  const player = process.env.REALTIMEKIT_PLAYER_PRESET ?? "";
  const arbiter = process.env.REALTIMEKIT_ARBITER_PRESET ?? "";
  if (!accountId || !apiToken || !appId || !player || !arbiter) return null;
  return { accountId, apiToken, appId, presets: { player, arbiter } };
}

export function realtimeKitConfigured(): boolean {
  return readConfig() !== null;
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

type CfBody = {
  success?: boolean;
  data?: unknown;
  result?: unknown;
  errors?: { message?: string }[];
  error?: { message?: string };
};

/** One request. Maps transport and HTTP failure onto RealtimeKitError, and
 *  NEVER puts the API token or a response body into the message — a
 *  RealtimeKit error body can echo the request, and these messages reach
 *  logs and Sentry. */
async function cf(
  cfg: Config,
  path: string,
  init: { method: string; body?: unknown },
  deps: RealtimeKitDeps,
): Promise<unknown> {
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
  if (res.status === 404) {
    throw new RealtimeKitError(404, "not_found", `RealtimeKit ${init.method} ${path} returned 404`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RealtimeKitError(
      res.status,
      "unauthorized",
      `RealtimeKit ${init.method} ${path} rejected our credentials`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as CfBody;
  if (!res.ok || body.success === false) {
    throw new RealtimeKitError(
      res.status,
      "unavailable",
      `RealtimeKit ${init.method} ${path} failed with ${res.status}`,
    );
  }
  return body.data ?? body.result ?? body;
}

/** `fixture_id` is the table's primary key, so a fixture has exactly one
 *  meeting row for life — an ENDED one included. Once torn down (at the
 *  result, or at T+20 when nobody came — spec §5.2) there is nothing left to
 *  join, and creating another would only make a billable meeting the row can
 *  never point at. */
function meetingEnded(fixtureId: string): HttpError {
  return new HttpError(409, `video meeting for fixture ${fixtureId} has ended`, "VIDEO_MEETING_ENDED");
}

/** Created when the FIRST player arrives in the window, not after both check
 *  in — preflight needs something to join (spec §5.2). Idempotent per
 *  fixture; the loser of a creation race deactivates its own meeting rather
 *  than leaving a billable room nobody joins. */
export async function ensureMeeting(fixtureId: string, deps: RealtimeKitDeps = {}): Promise<MeetingRef> {
  const cfg = requireConfig();
  const [existing] = await sql<{ meeting_id: string; ended_at: Date | null }[]>`
    select meeting_id, ended_at from fixture_video_meetings
     where fixture_id = ${fixtureId}`;
  if (existing) {
    if (existing.ended_at !== null) throw meetingEnded(fixtureId);
    return { meetingId: existing.meeting_id };
  }

  const [fixture] = await sql<{ org_id: string }[]>`
    select org_id from fixtures where id = ${fixtureId}`;
  if (!fixture) throw new HttpError(404, "fixture not found", "NOT_FOUND");

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
  const inserted = await sql<{ meeting_id: string }[]>`
    insert into fixture_video_meetings (fixture_id, org_id, meeting_id)
    values (${fixtureId}, ${fixture.org_id}, ${data.id})
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
  const [winner] = await sql<{ meeting_id: string; ended_at: Date | null }[]>`
    select meeting_id, ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`;
  if (!winner) throw new RealtimeKitError(503, "unavailable", "meeting row vanished mid-race");
  if (winner.ended_at !== null) throw meetingEnded(fixtureId);
  return { meetingId: winner.meeting_id };
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
 *  row that value is `user_id`; the row's own `id` is a per-connection id
 *  that changes on every reload (OpenAPI; Cloudflare's "Understanding IDs";
 *  and the recorded peer report, where the two differ). A participant who
 *  reloaded has one row per connection, so the question is whether ANY of
 *  their rows has not left.
 *
 *  A 404 on the active session is a normal "nobody has joined yet" and
 *  answers false; any other failure, and any answer we cannot read, THROWS,
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
      { method: "GET" },
      deps,
    )) as { id?: unknown; status?: unknown };
  } catch (err) {
    if (err instanceof RealtimeKitError && err.code === "not_found") return false;
    throw err;
  }
  if (session.status !== "LIVE") return false;
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
 *  not skip the deactivate. The row is stamped only AFTER the deactivate
 *  succeeds — a failed PATCH leaves a joinable meeting upstream, so the row
 *  must stay unended for the next sweep to retry — and only once: a repeat
 *  call keeps the first teardown time. */
export async function endMeeting(meetingId: string, deps: RealtimeKitDeps = {}): Promise<void> {
  const cfg = requireConfig();
  const id = encodeURIComponent(meetingId);
  try {
    await cf(cfg, `/meetings/${id}/active-session/kick-all`, { method: "POST" }, deps);
  } catch (err) {
    if (!(err instanceof RealtimeKitError) || err.code !== "not_found") throw err;
  }
  await cf(cfg, `/meetings/${id}`, { method: "PATCH", body: { status: "INACTIVE" } }, deps);
  await sql`
    update fixture_video_meetings set ended_at = now()
     where meeting_id = ${meetingId} and ended_at is null`;
}
