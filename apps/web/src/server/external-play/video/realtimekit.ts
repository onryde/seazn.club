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
