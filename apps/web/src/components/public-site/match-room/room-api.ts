// The match room's five calls to OUR server (design §3.4: the browser never
// talks to Lichess). Client-safe: no server module is imported — the wire
// types below mirror `RoomAct` / `RoomActOut` (api-v1/schemas.ts), the
// room usecase's `SeatWire` and T9's `CreateOutcome`, and room-api.test.ts
// pins each mirror against
// its source at the type level, so the two cannot drift silently.
import type { RoomSnapshot, SeatRefusal } from "./room-snapshot";

export type RoomActBody =
  | { kind: "move"; uci: string }
  | { kind: "resign" }
  | { kind: "draw"; accept: boolean }
  | { kind: "abort" };

export type GrantRefusalWire = "lichess_link_required" | "lichess_reconsent_required";

export type RoomActAnswer =
  | { ok: true; applied: boolean; ended?: true }
  | { ok: false; reconcile: true; reason: string }
  | { ok: false; reconcile: false; reason: GrantRefusalWire };

export type ParticipantWire = { participantId: string; authToken: string };

/** The room usecase's `CameraFaultReport` / the route's `RoomCameraFault`
 *  (I-1): our guard's gap on this player's OWN seat started or ended. */
export type CameraFaultBody = { state: "start" | "end"; participantId: string };
/** D16 (§5.6.3): the room/camera-report body. */
export type CameraReportBody = { state: "live" | "off"; heartbeat: boolean };

export type SeatAnswer =
  /** `cameraRetry` (D21-fix-3, owner decision): present, and true, ONLY when an optional camera was seated with no token
   *  because the platform's RealtimeKit call budget was spent - a token can still come (`requestCamera`). Absent on
   *  every other tokenless seat (camera Off, an organiser's video override): there the null is final, and no
   *  inference from a null token may say otherwise. */
  | { seated: true; participant: ParticipantWire | null; cameraRetry?: true }
  | { seated: false; reason: SeatRefusal; participant: ParticipantWire | null };

/** The camera route's answer (`RoomCameraAnswer`, api-v1/schemas.ts): the token, or null; `retry` says whether to ask
 *  again (the budget was spent again) or to stop (null and final: the policy, an override or a closed window). */
export type CameraAnswer = { participant: ParticipantWire | null; retry: boolean };

/** T9's `CreateOutcome` (create-game.ts), mirrored. */
export type CreateAnswer =
  | { created: true; gameId: string }
  | {
      created: false;
      reason: "not_ready" | "already" | "unplayable" | "provider_error" | "no_person" | "online_chess_disabled" | GrantRefusalWire;
    };

export type RoomClaimAnswer = {
  snapshot: RoomSnapshot;
  seat: SeatAnswer | null;
  /** T9's answer when this seat asked for the game; null when it asked
   *  nothing (review m3). Its refusal for the flag already shows as
   *  `snapshot.onlineChessOff`. */
  create: CreateAnswer | null;
};

/** A call's outcome: the envelope's data, or the HTTP status and error code
 *  (`status: 0` ⇒ the request never got an answer). */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null };

export type Fetcher = typeof fetch;

export function roomApiPath(fixtureId: string, tail: "" | "/act" | "/clock-zero" | "/camera-fault" | "/camera-report" | "/camera", token: string | null): string {
  const q = token ? `?t=${encodeURIComponent(token)}` : "";
  return `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/room${tail}${q}`;
}

async function call<T>(f: Fetcher, url: string, init: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await f(url, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return { ok: false, status: 0, code: null };
  }
  type Envelope = { ok?: boolean; data?: T; error?: { code?: string } };
  let body: Envelope | null = null;
  try {
    body = (await res.json()) as Envelope | null;
  } catch {
    body = null;
  }
  if (res.ok && body?.ok === true && body.data !== undefined) return { ok: true, data: body.data };
  return { ok: false, status: res.status, code: body?.error?.code ?? null };
}

export function fetchRoom(fixtureId: string, token: string | null, f: Fetcher = fetch) {
  return call<RoomSnapshot>(f, roomApiPath(fixtureId, "", token), { method: "GET" });
}

/** `heldParticipantId` (D21-fix-3, F1): the participant whose token this browser already holds. Sent so a claim the
 *  server answers `camera_starting` need not hand over another (a vendor request the call budget would rather spend on
 *  a read); a browser that holds none sends no body, which the server reads as "none held" and hands one. */
export function claimSeat(fixtureId: string, token: string | null, heldParticipantId: string | null = null, f: Fetcher = fetch) {
  return call<RoomClaimAnswer>(f, roomApiPath(fixtureId, "", token), {
    method: "POST",
    ...(heldParticipantId === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ heldParticipantId }) }),
  });
}

/** D21-fix-3: an optional camera seated with no tile because the call budget was spent asks again for its token - and
 *  only for that: no seat checks re-run, no check-in, no lobby ping, no game create. */
export function requestCamera(fixtureId: string, token: string | null, f: Fetcher = fetch) {
  return call<CameraAnswer>(f, roomApiPath(fixtureId, "/camera", token), { method: "POST" });
}

export function sendAct(fixtureId: string, token: string | null, action: RoomActBody, f: Fetcher = fetch) {
  return call<RoomActAnswer>(f, roomApiPath(fixtureId, "/act", token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
}

export function sendClockZero(fixtureId: string, token: string | null, f: Fetcher = fetch) {
  return call<{ reconciled: boolean }>(f, roomApiPath(fixtureId, "/clock-zero", token), { method: "POST" });
}

/** Our guard's gap on the caller's own seat (I-1). `keepalive`: a page
 *  closing mid-recovery still closes the stamp it opened. */
/** The stamp, for the camera session's queue (fix round 6, M-3): REJECTS when
 *  the server may not have taken it — the network down (status 0) or a 5xx —
 *  so the session sends it again; resolves on a 2xx or any 4xx (the cap's
 *  429, a 404), which another send would only repeat. */
export async function deliverCameraFault(fixtureId: string, token: string | null, body: CameraFaultBody, f: Fetcher = fetch): Promise<void> {
  const r = await sendCameraFault(fixtureId, token, body, f);
  if (!r.ok && (r.status === 0 || r.status >= 500)) throw new Error(`camera-fault not delivered (${r.status})`);
}

/** D16 (§5.6.3): the camera's report, for the camera session's queue. REJECTS when the server may not have taken it - the
 *  network down (status 0), a 5xx, or the 429 of its rate limit - so the session sends a CHANGE again after a wait (and drops
 *  a heartbeat); resolves on a 2xx or any other 4xx (a 404: no seat in a meeting, which another send would only repeat). */
export async function deliverCameraReport(
  fixtureId: string,
  token: string | null,
  body: CameraReportBody,
  f: Fetcher = fetch,
): Promise<void> {
  const r = await sendCameraReport(fixtureId, token, body, f);
  if (!r.ok && (r.status === 0 || r.status === 429 || r.status >= 500)) throw new Error(`camera-report not delivered (${r.status})`);
}

export function sendCameraReport(fixtureId: string, token: string | null, body: CameraReportBody, f: Fetcher = fetch) {
  return call<{ outcome: "written" | "refreshed" | "ignored" }>(f, roomApiPath(fixtureId, "/camera-report", token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  });
}

export function sendCameraFault(fixtureId: string, token: string | null, body: CameraFaultBody, f: Fetcher = fetch) {
  return call<{ open: boolean }>(f, roomApiPath(fixtureId, "/camera-fault", token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  });
}
