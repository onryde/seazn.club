"use client";
// One relay session per fixture page (spec 2026-09-30 §2, T9b): the Stream button's dot, the Phone tab and the stop probe
// read the SAME session, so they can never disagree and the page never runs two `current` polls. FixtureConsole mounts
// the provider whenever it mounts Stream; everything below it reads `useSharedPhoneSession`.
//
// `usePhoneSession` moved here from fixture-stream-panel.tsx unchanged but for its options (`enabled`, `initialView`):
// the panel imports it from here, so the provider importing the panel would have been a cycle.
//
// Known limit, recorded not fixed (T9b brief): the poll runs only while a session is NOT terminal, so a session started
// from ANOTHER device stays invisible to an idle page (no dot) until a read happens — the page's load, or the Phone tab
// opening (PhoneTab re-reads on mount).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { STREAM_POLL_MS, phoneTabState, type StreamSessionView } from "@/lib/stream-session-view";

export interface PhoneSessionOptions {
  /** false: no read, no poll, no clock — a reader under a provider for the same fixture. Default true. */
  enabled?: boolean;
  /** Seeds the view (and counts as loaded). A unit-test seam ONLY: the server never passes it. */
  initialView?: StreamSessionView | null;
}

/**
 * One fixture's relay session as the organiser sees it — shared by the Phone tab and the unentitled stop probe (G2), so
 * the two cannot disagree about what "stop" means. Reads `current` on mount and polls it at STREAM_POLL_MS while the
 * session is not terminal, or no read has landed yet (m3) (the SERVER flips warming → live on that read; the client
 * never decides), ticks a 1-s clock
 * while live, and owns the two ways out: Stop (confirmed — it is on air) and Cancel (re-read first — m3).
 */
export function usePhoneSession(fixtureId: string, opts: PhoneSessionOptions = {}) {
  // T9b: a hook under a provider for the same fixture is DISABLED — no read, no poll, no clock — so the page runs one
  // poller. `initialView` seeds the view: a unit-test seam only (the server never passes it; see StreamSessionProvider).
  const enabled = opts.enabled ?? true;
  const msg = useMsg();
  // B5 review m-1: the console mounts the provider on EVERY fixture page, disabled when there is no stream. A disabled
  // session never asks, so it needs no dialog (the console's node harnesses render none); an enabled one fails fast
  // without it, as `useConfirm()` would. Asked anyway, a disabled one DECLINES — never a stop without a confirmation.
  const dialog = useConfirm({ optional: true });
  if (enabled && !dialog) throw new Error("useConfirm needs <ConfirmProvider> in the tree");
  const confirm = dialog ?? (async () => false);
  const [view, setView] = useState<StreamSessionView | null>(opts.initialView ?? null);
  // "Start another" / "Try again" put the tab back to idle WITHOUT forgetting the server's answer. `current` returns
  // the LATEST session in any state, terminal ones included, so every later read (the refresh after a refused create,
  // in particular) would otherwise resurrect the finished card over the refusal it was meant to explain.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(opts.initialView !== undefined);
  const [busy, setBusy] = useState(false);
  // m1: a stop that neither landed nor could be confirmed by a re-read. Its own state and its own sentence — the create
  // copy ("That did not start") says the opposite of what happened.
  const [stopFailed, setStopFailed] = useState(false);
  // m3 (lane-close fix): the mount's read FAILED, so "no view" is not known to mean "nothing is up". Until a read lands,
  // the idle it shows is a guess and is polled like any other unsettled state — a stream on air behind one dropped
  // request would otherwise leave the stop probe drawing nothing, and the tab offering Go live, until a reload.
  const [readFailed, setReadFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // `reveal` marks a read as the organiser DISCLOSING the credentials rather than the 5-second poll (De). Only two
  // things set it: the first showing of a session's QR, and a tap on Copy. Mount, poll and post-action reads are polls.
  const read = useCallback(
    async (reveal = false) => {
      const cur = await apiV1<StreamSessionView | null>(
        `/api/v1/fixtures/${fixtureId}/stream-sessions/current${reveal ? "?reveal=1" : ""}`,
      );
      setView(cur);
      setLoaded(true);
      setReadFailed(false);
      setNow(new Date());
      return cur;
    },
    [fixtureId],
  );

  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      try {
        await read();
      } catch {
        setLoaded(true); // an unreadable first read still leaves the tab usable: idle, from the page's balance
        setReadFailed(true);
      }
    })();
  }, [read, enabled]);

  const shown = view && view.id !== dismissedId ? view : null;
  const state = phoneTabState(shown);
  const terminal = state === "idle" || state === "ended" || state === "failed";
  useEffect(() => {
    if (!enabled || (terminal && !readFailed)) return;
    const id = setInterval(() => {
      void read().catch(() => {});
    }, STREAM_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, terminal, readFailed, read]);

  // The elapsed clock ticks every second while live, rather than jumping by the poll interval.
  useEffect(() => {
    if (!enabled || state !== "live") return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [enabled, state]);

  const stopNow = async (target: StreamSessionView) => {
    setBusy(true);
    setStopFailed(false);
    try {
      setView(
        await apiV1<StreamSessionView>(`/api/v1/fixtures/${fixtureId}/stream-sessions/${target.id}/stop`, {
          method: "POST",
        }),
      );
    } catch {
      // D14: a refused stop is most often a session that has already ended (409 not_active) — read the server again
      // and show what is there. Only when that read fails too is there nothing true to show but "tap Stop again".
      try {
        await read();
      } catch {
        setStopFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmThenStop = async (target: StreamSessionView) => {
    const ok = await confirm({
      title: msg("stream.phone.stop.title"),
      body: msg("stream.phone.stop.body"),
      confirmLabel: msg("stream.phone.stop"),
      tone: "danger",
      // P3: the cancel says what it does, in the PAGE's locale — the provider's default reads the `seazn_locale` cookie.
      cancelLabel: msg("stream.phone.stop.keep"),
      // P4: the most consequential button in the flow gets the 44-px phone floor.
      size: "touch",
    });
    if (ok) await stopNow(target);
  };

  const stop = async () => {
    if (shown) await confirmThenStop(shown);
  };

  // m3: Cancel is offered on the QR, where nothing is on air — so it asks nothing. But the phone can connect while the
  // QR is on screen, and a Cancel tapped then is a LIVE stop that must be confirmed like any other. So it reads first:
  // still provisioning / warming → stop now; live → the confirming stop; anything else (it ended or failed on its own)
  // → the read already shows it. A read that FAILS leaves nobody knowing whether it is on air, so it asks.
  const cancel = async () => {
    if (!shown) return;
    const target = shown;
    setBusy(true);
    let fresh: StreamSessionView | null;
    try {
      fresh = await read();
    } catch {
      setBusy(false);
      await confirmThenStop(target);
      return;
    }
    setBusy(false);
    if (!fresh || fresh.id !== target.id) return;
    const at = phoneTabState(fresh);
    if (at === "live") await confirmThenStop(fresh);
    else if (at === "provisioning" || at === "warming") await stopNow(fresh);
  };

  const dismiss = () => {
    setDismissedId(view?.id ?? null);
    setStopFailed(false);
  };

  return { view, shown, state, loaded, busy, setBusy, now, read, stop, cancel, stopFailed, dismiss };
}

export type PhoneSession = ReturnType<typeof usePhoneSession>;

const SessionCtx = createContext<(PhoneSession & { fixtureId: string }) | null>(null);

/**
 * The page's ONE poller for `fixtureId`. Under an outer provider for the SAME fixture it adds nothing (its own hook is
 * disabled and the outer session passes through), so nesting can never start a second poll. `enabled` false (no stream
 * on the page) adds nothing either: no read, no poll, and whatever is outside passes through. The element it renders is
 * the same in every case (B5 review m-1): the console mounts it unconditionally, so a stream mount appearing or going
 * away on a refresh flips `enabled`, never the tree — the subtree below is not remounted. `initialView` is a unit-test
 * seam only — the console mounts the provider without it, and so does every server-rendered page.
 */
export function StreamSessionProvider({
  fixtureId,
  enabled = true,
  initialView,
  children,
}: {
  fixtureId: string;
  enabled?: boolean;
  initialView?: StreamSessionView | null;
  children: ReactNode;
}) {
  const outer = useContext(SessionCtx);
  const reuse = outer !== null && outer.fixtureId === fixtureId;
  const owns = enabled && !reuse;
  const own = usePhoneSession(fixtureId, { enabled: owns, initialView });
  return <SessionCtx.Provider value={owns ? { ...own, fixtureId } : outer}>{children}</SessionCtx.Provider>;
}

/**
 * The provider's session when one for THIS fixture is mounted above; otherwise this caller's own poll (the panel's unit
 * harness renders it bare). Hooks run unconditionally; the own poll is disabled under a matching provider. A provider for
 * ANOTHER fixture is not this fixture's session — that caller polls its own rather than reading the wrong one.
 */
export function useSharedPhoneSession(fixtureId: string): PhoneSession {
  const shared = useContext(SessionCtx);
  const match = shared !== null && shared.fixtureId === fixtureId ? shared : null;
  const own = usePhoneSession(fixtureId, { enabled: match === null });
  return match ?? own;
}
