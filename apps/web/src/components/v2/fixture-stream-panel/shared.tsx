"use client";

import { CirclePause } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { STATE_PILL_KEYS, type PhoneTabState } from "@/lib/stream-session-view";

const PILL: Record<PhoneTabState, string> = {
  idle: "bg-slate-100 text-slate-600",
  provisioning: "bg-amber-100 text-amber-800",
  warming: "bg-amber-100 text-amber-800",
  live: "bg-red-100 text-red-700",
  ending: "bg-slate-100 text-slate-600",
  ended: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-50 text-red-700",
};

export type Msg = ReturnType<typeof useMsg>;

// Render HELPERS, not components: the tab and the stop probe share this markup, and a plain call keeps it inline in
// the caller's tree (the node harness expands one level, and so do the tests that pin these testids).

/** The §8a state pill. `aria-live` (m9): a state change — warming → live, live → ending — is announced. */
/** I4 (Task 14b review, controller ruling 2026-09-29): since V426 every plan grants `streaming.relay`, so an org without
 *  it was switched off by staff (an override set to false), and an override outranks every plan. A priced upgrade here
 *  sold a plan that could not lift it. One state for every place the relay is refused: the entitled check, a create's
 *  plan_lacks_relay and the checkout's 402. The address is the house support inbox (help-menu.tsx). */
const SUPPORT_EMAIL = "support@seazn.club";
export function switchedOff(msg: Msg) {
  return (
    <p data-testid="stream-switched-off" className="text-xs text-slate-600">
      {msg("stream.phone.switchedOff")}{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-purple-700 underline">
        {SUPPORT_EMAIL}
      </a>
    </p>
  );
}

/**
 * Task 33e: a paused seat (402 members.max, an admin past the plan's member limit) stopped the panel's polls, so what is on screen
 * is the last answer. The same slate line and pause mark as the replays card's (`stream.replay.seazn.seatPaused`), in a quiet box
 * at the top of the body — the first thing read, before the chain it explains. `role="status"`: announced once, never an alert (no
 * action fixes it here; the owner does). `min-w-0` so a long translation wraps inside a 320 px panel.
 */
export function seatPausedNote(msg: (key: MessageKey) => string) {
  return (
    <p data-testid="stream-seat-paused" role="status" className="mb-3 flex min-w-0 items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <CirclePause aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <span className="min-w-0">{msg("stream.phone.seatPaused")}</span>
    </p>
  );
}

export function statePill(msg: Msg, state: PhoneTabState, srOnly = false) {
  return (
    <span
      data-testid="stream-state-pill"
      aria-live="polite"
      // T9b: in the Phone tab the Signal path shows the state, so there the pill is for assistive tech only.
      className={
        srOnly ? "sr-only" : `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL[state]}`
      }
    >
      {state === "live" && !srOnly && (
        <span data-testid="stream-live-dot" aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
      )}
      {msg(STATE_PILL_KEYS[state])}
    </span>
  );
}

/**
 * m1: a stop nobody could confirm — worded by the STATE the card is in, because the copy tells the organiser which
 * button to tap again. Before live the only control on screen is Cancel (N1: "tap Stop stream again" named a button
 * that is not there); once live it is Stop. While ending, or once a read finds it over, "did not stop" is false, so
 * nothing (N3: the tab and the stop probe share this one guard, so neither can show it beside "ending").
 */
export function stopError(msg: Msg, state: PhoneTabState) {
  const key: MessageKey | null =
    state === "live"
      ? "stream.error.stop"
      : state === "provisioning" || state === "warming"
        ? "stream.error.cancel"
        : null;
  if (key === null) return null;
  return (
    <p data-testid="stream-stop-error" role="alert" className="text-xs text-red-700">
      {msg(key)}
    </p>
  );
}
