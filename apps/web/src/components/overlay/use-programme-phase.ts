"use client";
// The compositor's programme phase, as the overlay page reads it (R2005 change 6; overlay templates spec 2026-10-15
// §4.3). LOOPBACK first: the compositor's own endpoint inside the Machine (C12), long-polled. FALLBACK B after
// `PHASE_LOOPBACK_FAILURES_TO_FALLBACK` consecutive failures: the phase the compositor last put on its heartbeat, which
// the overlay route serves to a verified relay page as `programmePhase` (the stage hands it in as `webPhase`).
//
// Every rule is the pure reducer's (`phaseChannelStep`, lib/overlay-compositor.ts); this file owns only the loop, the
// abort timer and the announcement. With `enabled` false it returns null and makes NO request — an OBS page, and every
// preview, never touch the network here.
import { useEffect, useReducer, useRef, useState } from "react";
import {
  changeOnly,
  PHASE_CHANNEL_INITIAL,
  PHASE_REPLY_GRACE_MS,
  PHASE_RETRY_AFTER_FAILURE_MS,
  phaseChannelSignal,
  phaseChannelStep,
  phaseReplyEvent,
  settledChannel,
  type PhaseChannelEvent,
} from "@/lib/overlay-compositor";
import {
  RELAY_PHASE_LONG_POLL_MAX_MS,
  RELAY_PHASE_PATH,
  RELAY_PHASE_PORT,
  type PhaseChannel,
  type ProgrammePhaseWire,
} from "@/lib/relay-phase";

/**
 * The loopback request (change 9, F-009 review M5): `fetch(url, { signal })` and NOTHING else. F-009 proved only that
 * shape reaches the endpoint from CEF 139: a non-safelisted header (a `Content-Type`, say) makes the browser send an
 * ENFORCED CORS preflight, which C12 answers with no `Access-Control-Allow-Headers` — so it fails, and so would every
 * poll. No `method` (GET is the default), no `body`, no `credentials`, no `mode`.
 */
export function phaseRequest(seq: number, signal: AbortSignal): [string, { signal: AbortSignal }] {
  return [`http://127.0.0.1:${RELAY_PHASE_PORT}${RELAY_PHASE_PATH}?after=${seq}`, { signal }];
}

/** One loopback round trip as the reducer's event. Any reply later than the long poll's hold plus the grace is aborted
 *  and counts as a failure (F-009: a refused or blocked request is safe through this timer, it never hangs the page). */
async function loopbackOnce(seq: number, signal: AbortSignal): Promise<PhaseChannelEvent> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, RELAY_PHASE_LONG_POLL_MAX_MS + PHASE_REPLY_GRACE_MS);
  try {
    // C12's `after` is a u64: before the first adopted reply (seq −1) the page asks `after=0`.
    const res = await fetch(...phaseRequest(Math.max(0, seq), ctrl.signal));
    if (!res.ok) return { type: "loopbackFailed" };
    return phaseReplyEvent(await res.json());
  } catch {
    return { type: "loopbackFailed" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function useProgrammePhase({
  enabled,
  webPhase,
}: {
  enabled: boolean;
  /** Fallback B's phase: the overlay route's `programmePhase` (null when the beat carried none — never defaulted). */
  webPhase: ProgrammePhaseWire | null;
}): { phase: ProgrammePhaseWire | null; channel: PhaseChannel | null } {
  const [state, dispatch] = useReducer(phaseChannelStep, PHASE_CHANNEL_INITIAL);
  // The loop reads the newest adopted seq without re-arming on every reply.
  const seqRef = useRef(state.seq);
  useEffect(() => {
    seqRef.current = state.seq;
  }, [state.seq]);

  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    if (!enabled || state.channel !== "loopback") return;
    const stop = new AbortController();
    // The loop's OWN copy of the channel state, stepped with the reducer itself: a dispatch only schedules a render,
    // so a loop that waited for React to tell it about the third failure would already have sent a fourth request.
    let local = { ...PHASE_CHANNEL_INITIAL, seq: seqRef.current };
    void (async () => {
      while (!stop.signal.aborted) {
        const event = await loopbackOnce(local.seq, stop.signal);
        if (stop.signal.aborted) return;
        local = phaseChannelStep(local, event);
        dispatch(event);
        if (event.type === "loopbackOk") setAnswered(true);
        if (local.channel !== "loopback") return;
        if (event.type === "loopbackFailed") {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, PHASE_RETRY_AFTER_FAILURE_MS);
            stop.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          });
        }
      }
    })();
    return () => stop.abort();
  }, [enabled, state.channel]);

  // Fallback B: only once the channel IS web (the reducer ignores it otherwise, so dispatching in loopback is harmless,
  // but a dispatch nobody acts on is a render nobody needs).
  useEffect(() => {
    if (!enabled || state.channel !== "web") return;
    dispatch({ type: "webPhase", phase: webPhase });
  }, [enabled, state.channel, webPhase]);

  // §4.3: the channel is announced on F-001's console channel once it settles, and again on each change.
  const announceRef = useRef<((channel: PhaseChannel) => void) | null>(null);
  const settled = enabled ? settledChannel(state, answered) : null;
  useEffect(() => {
    if (settled === null) return;
    announceRef.current ??= changeOnly<PhaseChannel>((channel) => console.info(phaseChannelSignal(channel)));
    announceRef.current(settled);
  }, [settled]);

  if (!enabled) return { phase: null, channel: null };
  return { phase: state.phase, channel: settled };
}
