"use client";

// Realtime push nudges, Task 13 (spec §4.1-4.2): the browser side of the
// competition's division door, `GET /api/v1/public/competitions/{id}/realtime-token`.
//
// The door answers `{token, divisionIds, expiresAt, url, apikey}` (60-minute
// TTL, `private, no-store`). This module fetches it, hands the token to the
// DIVISION family's client (`realtimeClient("division")`) with `setAuth`, and
// keeps it fresh: a re-fetch at 50 minutes, and on a channel's CHANNEL_ERROR or
// CLOSED with backoff. Every refusal (403 no_divisions / too_many_divisions /
// not entitled, 404, 429, 503, a network failure, a body that is not the door's)
// answers null, and the page polls with no error UI.
//
// THE TOKEN IS A CREDENTIAL. It never leaves this module except into the
// client's `setAuth`: it is not stored here, not returned to a caller, never
// logged, thrown, put in a URL, React state, a cache or browser storage. A
// session hands its caller the client (to open channels on) and `covers(id)`.
//
// One division client means one socket-wide token, so ONE competition is held
// at a time. A page asking for a second competition while the first is held is
// refused (null, it polls) rather than overwriting the first one's token.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Re-fetch the door this long after a token was set (spec §4.1: "at about 50 min"; the TTL is 60). */
export const DIVISION_TOKEN_REFRESH_MS = 50 * 60_000;

/** The wait before re-fetching after a channel reported CHANNEL_ERROR or CLOSED, by failures in a row.
 *  The last rung repeats. A channel that reaches SUBSCRIBED puts the ladder back on its first rung. */
export const DIVISION_AUTH_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const;

/** The door's path for a competition. */
export function divisionRealtimeTokenPath(competitionId: string): string {
  return `/api/v1/public/competitions/${encodeURIComponent(competitionId)}/realtime-token`;
}

export interface DivisionRealtimeSession {
  /** The division family's client, already carrying the token. Open `division:{id}` channels on it, private. */
  readonly client: SupabaseClient;
  /** Whether the token admits `division:{divisionId}`. A division it does not cover is left to the poll. */
  covers(divisionId: string): boolean;
  /** Report every status a channel opened on `client` passes through. CHANNEL_ERROR and CLOSED re-fetch the
   *  door with backoff; SUBSCRIBED resets the backoff. */
  channelStatus(status: string): void;
  /** Called after a fresh token has been SET (the 50-minute refresh, or a re-fetch after a failure). A caller
   *  re-joins the channels it holds that are not up. Returns the unsubscribe. */
  onRenewed(listener: () => void): () => void;
  /** This caller is done. The last release stops the refresh; nothing is asked for a page that has gone. */
  release(): void;
}

interface Holder {
  competitionId: string;
  refs: number;
  alive: boolean;
  /** The first fetch and `setAuth`: true once the client carries a token. */
  ready: Promise<boolean>;
  client: SupabaseClient | null;
  divisionIds: ReadonlySet<string>;
  /** Failures in a row since the last SUBSCRIBED: the backoff rung. */
  attempt: number;
  /** A failure re-fetch is scheduled or in flight (one covers every channel that fails beside it). */
  retrying: boolean;
  /** A re-fetch is running now. */
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the scheduled 50-minute refresh is due (epoch ms), so a holder re-acquired in the same commit resumes
   *  it rather than starting the 50 minutes again. */
  refreshAt: number;
  listeners: Set<() => void>;
}

let held: Holder | null = null;

/** The door's answer, or null for every refusal. The token goes nowhere but the return value. */
async function askDoor(competitionId: string): Promise<{ token: string; divisionIds: string[] } | null> {
  try {
    const res = await fetch(divisionRealtimeTokenPath(competitionId), {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { token?: unknown; divisionIds?: unknown } } | null;
    const token = body?.data?.token;
    const ids = body?.data?.divisionIds;
    if (typeof token !== "string" || token === "") return null;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id !== "")) return null;
    return { token, divisionIds: ids as string[] };
  } catch {
    return null;
  }
}

/** CI's e2e runs against a stub project with no Realtime socket: joining one hangs and never flips anything
 *  (`use-live-fixture.ts`, run 34834966169). The door is still asked; nothing dials. */
function stubProject(): boolean {
  return /stub\.supabase\.co/i.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

function clearTimer(h: Holder) {
  if (h.timer !== null) clearTimeout(h.timer);
  h.timer = null;
}

function drop(h: Holder) {
  h.alive = false;
  clearTimer(h);
  h.listeners.clear();
  if (held === h) held = null;
}

async function start(h: Holder): Promise<boolean> {
  const got = await askDoor(h.competitionId);
  if (got === null || !h.alive || stubProject()) return false;
  try {
    const { realtimeClient } = await import("@/lib/supabase-browser");
    const client = realtimeClient("division");
    await client.realtime.setAuth(got.token);
    if (!h.alive) return false;
    h.client = client;
    h.divisionIds = new Set(got.divisionIds);
    scheduleRefresh(h);
    return true;
  } catch {
    // Missing anon key, a client that would not build: poll.
    return false;
  }
}

function scheduleRefresh(h: Holder, wait = DIVISION_TOKEN_REFRESH_MS) {
  clearTimer(h);
  h.refreshAt = Date.now() + wait;
  h.timer = setTimeout(() => void renew(h), wait);
}

function scheduleRetry(h: Holder) {
  clearTimer(h);
  h.retrying = true;
  const wait = DIVISION_AUTH_BACKOFF_MS[Math.min(h.attempt, DIVISION_AUTH_BACKOFF_MS.length - 1)]!;
  h.attempt += 1;
  h.timer = setTimeout(() => void renew(h), wait);
}

async function renew(h: Holder) {
  h.timer = null;
  const client = h.client;
  if (!h.alive || client === null) return;
  h.inFlight = true;
  let divisionIds: string[];
  try {
    const got = await askDoor(h.competitionId);
    if (!h.alive) return;
    if (got === null) {
      // Refused or unreachable: the token already set stays until it expires; try again on the next rung.
      scheduleRetry(h);
      return;
    }
    try {
      await client.realtime.setAuth(got.token);
    } catch {
      scheduleRetry(h);
      return;
    }
    divisionIds = got.divisionIds;
  } finally {
    h.inFlight = false;
  }
  if (!h.alive) return;
  h.retrying = false;
  h.divisionIds = new Set(divisionIds);
  scheduleRefresh(h);
  for (const listener of [...h.listeners]) {
    try {
      listener();
    } catch {
      // A caller's re-join failing is that caller's poll to cover.
    }
  }
}

/**
 * A session on the division client for `competitionId`, or null: poll. The first call for a competition asks the
 * door; every later call while it is held shares that token (a second division going live needs no re-fetch).
 */
export async function acquireDivisionRealtime(competitionId: string): Promise<DivisionRealtimeSession | null> {
  if (held !== null && held.competitionId !== competitionId) {
    // Another competition holds the client's token. Released but not yet torn down: it goes now.
    if (held.refs > 0) return null;
    drop(held);
  }
  if (held === null) {
    const h: Holder = {
      competitionId,
      refs: 0,
      alive: true,
      ready: Promise.resolve(false),
      client: null,
      divisionIds: new Set(),
      attempt: 0,
      retrying: false,
      inFlight: false,
      timer: null,
      refreshAt: 0,
      listeners: new Set(),
    };
    held = h;
    h.ready = start(h);
  }
  const h = held;
  // Re-acquired after the last release, in the same commit (an effect that re-ran): the token is still set, so
  // the refresh the release stopped resumes on its own deadline and nothing is fetched.
  if (h.refs === 0 && h.client !== null && h.timer === null && !h.inFlight) {
    scheduleRefresh(h, Math.max(0, h.refreshAt - Date.now()));
  }
  h.refs += 1;

  let released = false;
  const mine = new Set<() => void>();
  const release = () => {
    if (released) return;
    released = true;
    for (const listener of mine) h.listeners.delete(listener);
    mine.clear();
    h.refs -= 1;
    if (h.refs > 0 || !h.alive) return;
    // Nobody holds it: no timer runs for a page that has gone. The holder itself is dropped a microtask later, so
    // an effect that re-runs (releases and re-acquires in the same commit) pays no second door call.
    clearTimer(h);
    h.retrying = false;
    queueMicrotask(() => {
      if (h.refs === 0) drop(h);
    });
  };

  const ok = await h.ready;
  if (!ok || !h.alive || h.client === null) {
    release();
    if (h.refs === 0) drop(h);
    return null;
  }
  const client = h.client;
  return {
    client,
    covers: (divisionId) => h.divisionIds.has(divisionId),
    channelStatus: (status) => {
      if (released || !h.alive) return;
      if (status === "SUBSCRIBED") {
        h.attempt = 0;
        return;
      }
      if (status !== "CHANNEL_ERROR" && status !== "CLOSED") return;
      // One re-fetch, scheduled or running, covers every channel that fails beside it. Otherwise the failure
      // brings the next re-fetch forward from the 50-minute refresh to the backoff rung.
      if (h.retrying || h.inFlight) return;
      scheduleRetry(h);
    },
    onRenewed: (listener) => {
      if (released) return () => {};
      h.listeners.add(listener);
      mine.add(listener);
      return () => {
        h.listeners.delete(listener);
        mine.delete(listener);
      };
    },
    release,
  };
}

/** Test seam: forget the held competition and its timers (vitest runs many pages in one module instance). */
export function _resetDivisionRealtimeAuth(): void {
  if (held !== null) drop(held);
  held = null;
}
