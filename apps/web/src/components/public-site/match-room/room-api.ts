// The match room's four calls to OUR server (design §3.4: the browser never
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

export type SeatAnswer =
  | { seated: true; participant: ParticipantWire | null }
  | { seated: false; reason: SeatRefusal; participant: ParticipantWire | null };

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

export function roomApiPath(fixtureId: string, tail: "" | "/act" | "/clock-zero", token: string | null): string {
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

export function claimSeat(fixtureId: string, token: string | null, f: Fetcher = fetch) {
  return call<RoomClaimAnswer>(f, roomApiPath(fixtureId, "", token), { method: "POST" });
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
