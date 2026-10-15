"use client";
// The room's transport: the reducer (room-state.ts) fed by
//   - a poll of GET room — every LIVE_POLL_MS while a game is live and no
//     realtime channel is up, else every IDLE_POLL_MS; every SETTLED_POLL_MS
//     once the result is written (D10b: a void reaches an open tab), and at
//     once when the tab comes back into view; never once polling stopped
//     (online chess off, the room gone);
//   - the private realtime channel `external-play:{fixtureId}` when the
//     snapshot carries a token: `room_state` is a move (applied at once),
//     `lobby_changed` is a check-in or a created game (a debounced re-read);
//   - the player's own seat, act and clock-zero calls.
// The token in `?t=` rides every call; with none, the session cookie does.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { claimSeat, fetchRoom, sendAct, sendClockZero, type RoomActBody, type RoomClaimAnswer } from "./room-api";
import { initialRoomState, parseRoomBroadcast, plyOf, roomReducer } from "./room-state";
import type { RoomSnapshot } from "./room-snapshot";

export const LIVE_POLL_MS = 3_000;
export const IDLE_POLL_MS = 15_000;
/** T17B fix 2, D10b (controller ruling): a room that shows a result still reads, this slowly — the organiser's void
 *  or re-arm reaches an open tab without a reload (and at once when the tab comes back into view). */
export const SETTLED_POLL_MS = 30_000;
const LOBBY_DEBOUNCE_MS = 250;
/** The two events the room's channel carries — lib/realtime.ts's
 *  publishRoomBroadcast and publishExternalPlayLobby send exactly these
 *  (pinned against the real publishers, external-play-room-game.test.ts). */
export const ROOM_STATE_EVENT = "room_state";
export const LOBBY_CHANGED_EVENT = "lobby_changed";
export const CLOCK_ZERO_SPACING_MS = 3_000;
/** T17B fix 2, D11 (controller ruling): the longest gap between two reports for one (game, ply). */
export const CLOCK_ZERO_MAX_SPACING_MS = 30_000;

export type ClockZeroReport = { key: string; attempts: number; at: number };

/** Whether a clock-zero report may go now, and the record if so: the first
 *  for a (game, ply) at once, the next CLOCK_ZERO_SPACING_MS later, each gap
 *  after that doubled, never more than CLOCK_ZERO_MAX_SPACING_MS — and no
 *  cap (D11: x0JKlePc sat at zero for 7 minutes past the old cap of 5, with
 *  nobody asking again). A new ply starts afresh. */
export function nextClockZeroReport(prev: ClockZeroReport | null, key: string, now: number): ClockZeroReport | null {
  if (prev === null || prev.key !== key) return { key, attempts: 1, at: now };
  const spacing = Math.min(CLOCK_ZERO_SPACING_MS * 2 ** Math.min(prev.attempts - 1, 16), CLOCK_ZERO_MAX_SPACING_MS);
  if (now - prev.at < spacing) return null;
  return { key, attempts: prev.attempts + 1, at: now };
}

/** How long to wait before re-reading after the `streak`-th act in a row
 *  that failed or was refused (review I2): the first at once, then doubling
 *  from 1s, never longer than the idle poll — which re-reads anyway. */
export function reReadDelayMs(streak: number): number {
  if (streak <= 1) return 0;
  return Math.min(IDLE_POLL_MS, 1_000 * 2 ** Math.min(streak - 2, 30));
}

export function pollIntervalMs(a: { gameLive: boolean; subscribed: boolean; settled?: boolean }): number {
  if (a.settled) return SETTLED_POLL_MS;
  return a.gameLive && !a.subscribed ? LIVE_POLL_MS : IDLE_POLL_MS;
}

export function useRoom(initial: RoomSnapshot, token: string | null, grantRefused = false) {
  const fixtureId = initial.fixtureId;
  // P10: the page load's answer from Lichess, kept for the page (room-state `grantRefused`).
  const [state, dispatch] = useReducer(roomReducer, initial, (s) => initialRoomState(s, Date.now(), grantRefused));
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await fetchRoom(fixtureId, token);
      if (r.ok) dispatch({ type: "snapshot", snap: r.data, receivedAt: Date.now() });
      else dispatch({ type: "fetch_failed", status: r.status, code: r.code });
    } finally {
      inFlight.current = false;
    }
  }, [fixtureId, token]);

  // ── poll ───────────────────────────────────────────────────────────────
  const [subscribed, setSubscribed] = useState(false);
  const game = state.snap.game;
  const gameLive = game !== null && !game.over;
  const settled = state.snap.result !== null;
  const every = pollIntervalMs({ gameLive, subscribed, settled });
  useEffect(() => {
    if (!state.polling) return;
    const id = setInterval(() => void refresh(), every);
    return () => clearInterval(id);
  }, [state.polling, every, refresh]);
  // D10b: a tab coming back into view reads at once (a phone woken after the organiser's void or re-arm).
  useEffect(() => {
    if (!state.polling || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [state.polling, refresh]);

  // ── realtime ───────────────────────────────────────────────────────────
  const topic = state.snap.realtime?.topic ?? null;
  const rtToken = state.snap.realtime?.token ?? null;
  const rtTokenRef = useRef(rtToken);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientRef = useRef<any>(null);
  useEffect(() => {
    rtTokenRef.current = rtToken;
    // A fresh read mints a fresh token: hand it to the live socket rather
    // than tearing the channel down (an inline token dependency would
    // resubscribe on every poll).
    if (rtToken && clientRef.current) void clientRef.current.realtime.setAuth(rtToken).catch(() => undefined);
  }, [rtToken]);
  const canSubscribe = topic !== null && state.polling && !settled;
  useEffect(() => {
    if (!canSubscribe || topic === null) return;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    // CI's stub host has no Realtime websocket (use-live-fixture.ts, run 34834966169).
    if (!supabaseUrl || /stub\.supabase\.co/i.test(supabaseUrl)) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;
    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        const sb = supabaseBrowser();
        const tok = rtTokenRef.current;
        if (!tok) return;
        await sb.realtime.setAuth(tok);
        if (cancelled) return;
        clientRef.current = sb;
        channel = sb
          .channel(topic, { config: { private: true } })
          .on("broadcast", { event: ROOM_STATE_EVENT }, (msg: { payload?: unknown }) => {
            const b = parseRoomBroadcast(msg.payload);
            if (b !== null) dispatch({ type: "broadcast", b, receivedAt: Date.now() });
          })
          .on("broadcast", { event: LOBBY_CHANGED_EVENT }, () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => void refresh(), LOBBY_DEBOUNCE_MS);
          })
          .subscribe((status: string) => {
            if (!cancelled) setSubscribed(status === "SUBSCRIBED");
          });
      } catch {
        // No anon key, websocket refused — the poll carries the room.
      }
    })();
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
      clientRef.current = null;
      setSubscribed(false);
    };
  }, [canSubscribe, topic, refresh]);

  // ── seat ───────────────────────────────────────────────────────────────
  const claim = useCallback(async (): Promise<RoomClaimAnswer | null> => {
    if (stateRef.current.pending !== null) return null;
    dispatch({ type: "seat_sent" });
    const r = await claimSeat(fixtureId, token);
    if (!r.ok) {
      dispatch({ type: "seat_failed", status: r.status, code: r.code });
      return null;
    }
    dispatch({ type: "seat_answered", answer: r.data, receivedAt: Date.now() });
    return r.data;
  }, [fixtureId, token]);

  // ── act ────────────────────────────────────────────────────────────────
  // Every answer re-reads: the read says what the board now is. A failed or
  // refused act never stops the room (review I2); repeats back off.
  const failStreak = useRef(0);
  const act = useCallback(
    async (action: RoomActBody) => {
      if (stateRef.current.pending !== null) return;
      // D24: the instant rides with the event (the reducer is pure): a move's own increment shows from this moment.
      dispatch({ type: "act_sent", action, at: Date.now() });
      const r = await sendAct(fixtureId, token, action);
      if (r.ok) dispatch({ type: "act_answered", answer: r.data });
      else dispatch({ type: "act_failed", status: r.status });
      failStreak.current = r.ok && r.data.ok ? 0 : failStreak.current + 1;
      const wait = reReadDelayMs(failStreak.current);
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      await refresh();
    },
    [fixtureId, token, refresh],
  );

  // ── clock zero ───────────────────────────────────────────────────────────
  // The clocks call this on every tick at zero; it reports on the backoff of
  // nextClockZeroReport, for as long as the (game, ply) sits at zero. A report
  // can rightly find nothing yet: the server allows itself a margin, and
  // Lichess flags only on an open stream's check (reconcile.ts, D11) — so a
  // later report for the same ply is how a late flag is finally read; past a
  // minute the server holds the board for the organiser instead.
  const zero = useRef<ClockZeroReport | null>(null);
  const clockZero = useCallback(async () => {
    const g = stateRef.current.snap.game;
    if (g === null || g.over || !g.clockRunning) return;
    const next = nextClockZeroReport(zero.current, `${g.gameId}:${plyOf(g)}`, Date.now());
    if (next === null) return;
    zero.current = next;
    const r = await sendClockZero(fixtureId, token);
    if (r.ok && r.data.reconciled) await refresh();
  }, [fixtureId, token, refresh]);

  return { state, refresh, claim, act, clockZero, subscribed };
}
