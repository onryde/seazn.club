"use client";

// The stripped courtside pad behind /score/{token} (doc 13 §7, PROMPT-21).
// Reuses the sport pads; capabilities are the device-link subset — append +
// undo OWN events, nothing else. Every call presents the dl_ token as a
// Bearer header; the token stays in this tab (component prop), never storage.
// Offline-tolerant: sends retry with the SAME idempotency key (doc 08 §4).
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ScoringErrorBoundary } from "@/components/v2/scoring-error-boundary";
// `OPPORTUNISTIC_RESYNC_MS` — the bound on this pad's opportunistic refresh
// (`handlePadEvents`) is the console's, imported rather than copied: one
// authority for one number. Its doc there says why the bound exists, why 10s,
// and why it sits at the call site rather than inside `apiV1`; every word of
// it applies to this twin, whose `padSyncing` greys Start and "Void my last
// entry" the same way. `send()` passes no budget, as the console's does not.
import {
  OPPORTUNISTIC_RESYNC_MS,
  resolvePadSpecForMount,
  shouldMountPad,
  type LiveState,
  type SendEvent,
  type SideInfo,
  type SportInfo,
} from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";
import { scoringErrorText } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";
// S13/#422 W11 — the v2 scoring pad is now the only pad this dispatcher
// renders (S12/#421's flag has been removed entirely, along with the seven
// v1 pad components it used to choose between — this dispatcher never had a
// carrom branch at all, so carrom is scoreable over a device link for the
// first time as of this cutover). `scorePadV2` stays nullable: a server-side
// bootstrap-resolution failure (fidelity.ts's own doc) means "no pad
// renders", never a fallback to a v1 chain that no longer exists.
import { ScorePad, type ScorePadBootstrap } from "@/components/v2/scorepad/registry";
import { entrantDisplayName } from "@/lib/entrant-name";

export type PadSideInfo = SideInfo;

export interface PadEventIn {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  voids_event_id: string | null;
  device_link_id: string | null;
}

interface Props {
  token: string;
  deviceLinkId: string;
  /** Org logo URL (Pro branding), resolved server-side. */
  logo?: string | null;
  fixture: {
    id: string;
    round_no: number;
    /** P9 cutover: the caller (app/score/[token]/page.tsx) now derives these
     *  from `venues`/`courts` via `venue_id`/`court_id` — display strings
     *  only, despite the field names still matching the frozen
     *  `fixtures.venue`/`court_label` columns they used to read verbatim. */
    venue: string | null;
    court_label: string | null;
    competition_name: string;
    division_name: string;
  };
  sport: SportInfo;
  home: PadSideInfo | null;
  away: PadSideInfo | null;
  initialState: LiveState;
  initialEvents: PadEventIn[];
  /** Everything `<ScorePad/>` needs beyond what this component already has,
   *  resolved server-side (`resolveScorePadBootstrap`,
   *  server/usecases/fidelity.ts). Null only on a resolution failure — the
   *  pad section then renders nothing rather than a fallback, since
   *  S13/#422 removed the v1 pad it used to fall back to. */
  scorePadV2?: ScorePadBootstrap | null;
}

const DEAD_CODES = new Set(["LINK_EXPIRED", "LINK_REVOKED", "LINK_INVALID", "UNAUTHENTICATED"]);

export function DeviceScorePad({
  token,
  deviceLinkId,
  logo = null,
  fixture,
  sport,
  home,
  away,
  initialState,
  initialEvents,
  scorePadV2 = null,
}: Props) {
  const msg = useMsg();
  const statusLabel = (s: string) => {
    const key = `score.status.${s}` as MessageKey;
    const label = msg(key);
    return label === key ? s.replace("_", " ") : label;
  };
  const [live, setLive] = useState<LiveState>(initialState);
  const [events, setEvents] = useState<PadEventIn[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** True while an opportunistic post-pad-event `resync()` is in flight.
   *  Separate from `busy` on purpose: `busy` means "a send of MINE is
   *  running" and its own `finally` clears it, so reusing it here would let a
   *  resync that finishes mid-send clear the send's guard. Both gate the same
   *  controls, because acting on a half-refreshed ledger is what this fix
   *  exists to prevent: without it, Undo stayed clickable during the window
   *  with a stale `expected_seq` and the server answered 409 SEQ_CONFLICT —
   *  bounded (it never voids the wrong event) but an unearned error where a
   *  clean undo was expected. Found in review (S13 follow-ups). */
  const [padSyncing, setPadSyncing] = useState(false);

  const authed = useCallback(
    <T,>(url: string, options?: Parameters<typeof apiV1>[1]) =>
      apiV1<T>(url, {
        ...options,
        headers: { ...(options?.headers ?? {}), Authorization: `Bearer ${token}` },
      }),
    [token],
  );

  /** Re-read `/state` and the full ledger. `timeoutMs` bounds the pair — see
   *  `OPPORTUNISTIC_RESYNC_MS` for who passes one; `send()` deliberately does
   *  not.
   *
   *  An explicit `AbortController` on the global `setTimeout`, NOT
   *  `AbortSignal.timeout`: that helper runs on a timer node's fake timers do
   *  not drive, so the bound would have no unit coverage at all (`apps/web`
   *  vitest is `environment: "node"`) — the reasoning `fixture-console.tsx`'s
   *  `resync` records. Clearing the timer on settle also leaves none armed. */
  const resync = useCallback(
    async (opts?: { timeoutMs?: number }) => {
      const budget = opts?.timeoutMs;
      const controller = budget === undefined ? null : new AbortController();
      const timer =
        controller === null
          ? null
          : setTimeout(() => controller.abort(new Error(`resync exceeded its ${budget}ms budget`)), budget);
      try {
        const [state, all] = await Promise.all([
          authed<LiveState>(`/api/v1/fixtures/${fixture.id}/state`, { signal: controller?.signal }),
          authed<PadEventIn[]>(`/api/v1/fixtures/${fixture.id}/events?since_seq=0`, {
            signal: controller?.signal,
          }),
        ]);
        // Never write an aborted refresh into state. `apiV1` now rejects on an
        // abort mid-body (review round 1), but before that it RESOLVED with
        // `undefined` there, and `setLive(undefined)` crashed the next render
        // on `live.summary`. Checked here as well so no transport that answers
        // an abort by resolving can reach the setters.
        controller?.signal.throwIfAborted();
        // Nor a 200 whose body never arrived (review round 2). A connection
        // dropped mid-body WITHOUT an abort (undici `TypeError: terminated`)
        // fails `apiV1`'s body parse, which defaults to `{}` — deliberately,
        // the v1 export routes answer non-JSON 200s — so the call RESOLVES
        // `undefined`. `setLive(undefined)` crashed the next render on
        // `live.summary`; a non-array ledger crashes `[...events]`. So the
        // shapes are checked here, before either setter. The error carries no
        // message on purpose: `send()` renders `err.message` verbatim when it
        // has one, and without one it shows the scorer the localized
        // `device.failed` copy instead of a developer string.
        if (state === null || typeof state !== "object" || !Array.isArray(all)) {
          throw Object.assign(new Error(), { name: "ResyncShapeError" });
        }
        setLive(state);
        setEvents(all);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
    [authed, fixture.id],
  );

  /** Same seam and same reasoning as fixture-console.tsx's own
   *  `handlePadEvents` — see its comment. `<ScorePad/>`'s own pipeline
   *  stamps a client-fabricated id on every event it knows about and never
   *  learns the server's real row id, so the raw event list this fires with
   *  is deliberately unused; only a real `resync()` (the same one `send()`
   *  already trusts) can tell this component the real id `lastOwnVoidable`
   *  needs. A failed opportunistic resync is swallowed — with ONE exception:
   *  a dead link (G1 review round 1, owner-approved). The tab-return listener
   *  below is often the first request after the organiser revoked the link or
   *  it expired, and swallowing that left the scorer on live controls that
   *  could only fail, re-asking a dead link on every return. It lands on the
   *  same dead-link screen `send()` shows, and the listener stops (see there).
   *
   *  BOUNDED (G1): the only clear of `padSyncing` is this `finally`, and the
   *  tab-return listener below now fires this too. See
   *  `OPPORTUNISTIC_RESYNC_MS`. */
  const handlePadEvents = useCallback(() => {
    setPadSyncing(true);
    void resync({ timeoutMs: OPPORTUNISTIC_RESYNC_MS })
      .catch((err: unknown) => {
        if (err instanceof ApiV1Error && DEAD_CODES.has(err.code)) setDead(err.message);
      })
      .finally(() => setPadSyncing(false));
  }, [resync]);

  const send: SendEvent = useCallback(
    async (type, payload) => {
      setError(null);
      setBusy(true);
      // One idempotency key per action: flaky venue Wi-Fi retries are safe —
      // the server replays the cached answer instead of double-writing.
      const idempotencyKey = crypto.randomUUID();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await authed(`/api/v1/fixtures/${fixture.id}/events`, {
              method: "POST",
              json: {
                expected_seq: live.last_seq,
                type,
                payload,
                idempotency_key: idempotencyKey,
              },
            });
            break;
          } catch (err) {
            // Network failure (offline) → retry same key with backoff.
            if (!(err instanceof ApiV1Error) && attempt < 3) {
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
        await resync();
        return true;
      } catch (err) {
        if (err instanceof ApiV1Error && DEAD_CODES.has(err.code)) {
          setDead(err.message);
        } else if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
          await resync().catch(() => undefined);
          setError(msg("device.seqConflict"));
        } else {
          // #427: an EngineError's message is the engine's own English and the
          // envelope carries it through ApiV1Error — localize by code first.
          setError(scoringErrorText(
            err instanceof ApiV1Error ? err.code : null,
            err instanceof Error ? err.message : null,
            msg,
            "device.failed",
          ));
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [authed, fixture.id, live.last_seq, resync],
  );

  // G1 — this pad's own freshness floor: the one W3 gave the console
  // (`fixture-console.tsx`, its `visibilitychange`/`focus` effect), which this
  // twin never got. Every other refresh here is this pad's own `send()` or its
  // inner pad's ledger change (`handlePadEvents`), and the second is downstream
  // of the very pipeline that stalls — a 403 at the realtime token door on a
  // Community plan, a websocket that joined and died, a wedged drain. So a
  // stalled pipeline left the SCORER's screen stale with no upper bound, while
  // the watcher's screen had one.
  //
  // Deliberately not an interval: a second timer on the same fixture doubles
  // the request rate of every courtside pad in the product. A human returning
  // to the tab is the moment staleness is visible, and a tab nobody returns
  // to costs nothing.
  //
  // BOTH events, because they do not always co-occur: a window-manager focus
  // with no visibility transition fires only `focus`; a tab switch inside an
  // already-focused window fires only `visibilitychange`. A real return fires
  // both, so it costs two refreshes (four requests) — bounded per return, and
  // the first to settle already applies fresh state.
  //
  // The `visibilityState` guard is load-bearing: `visibilitychange` fires on
  // the HIDE as well as the show, and refreshing a tab the scorer just left is
  // the request this exists not to make.
  //
  // `handlePadEvents`, NEVER `resync` directly: it is the only path that raises
  // `padSyncing`, which greys Start and "Void my last entry" while the ledger
  // is half-refreshed. Bypassing it leaves Void live with a stale
  // `expected_seq` — a 409 SEQ_CONFLICT on what should be a clean undo — at the
  // moment the scorer is back at the pad, the most reachable moment there is.
  // It also clears the flag in a `finally` and is bounded
  // (`OPPORTUNISTIC_RESYNC_MS`), so a refresh that fails or never answers
  // cannot strand the scorer on dead controls.
  //
  // Identity: `resync` is keyed on `[authed, fixture.id]`, `authed` on
  // `[token]`, `handlePadEvents` on `[resync]` — all stable for the life of the
  // link, so this subscribes once.
  useEffect(() => {
    // No DOM underneath ⇒ no listener. React never runs an effect during SSR,
    // so this is the effect's real server behaviour; it is also reachable in
    // `apps/web` vitest (`environment: "node"`), where `_hook-harness.tsx`
    // commits effects with no browser. W3 shipped the console's copy of this
    // effect unguarded and crashed three existing suites at mount.
    // BOTH clauses, and they are not redundant: a suite may stub `document`
    // without `window`, or neither, and a one-clause guard crashes in whichever
    // shape it forgot. `device-score-pad-freshness-floor.test.tsx` mounts each
    // partial DOM, so each clause has its own witness.
    if (typeof document === "undefined" || typeof window === "undefined") return;
    // A dead link never answers again, so a dead pad stops listening: the
    // cleanup below removes both listeners the moment `dead` flips, and
    // nothing re-adds them. Without this, every later return would spend four
    // requests on a link that can only refuse them. Same truthiness as the
    // dead-screen `if (dead)` below, so "listening" and "live screen" agree.
    if (dead) return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      handlePadEvents();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [handlePadEvents, dead]);

  // Owner ruling 17 (2026-09-06) — the SAME predicate fixture-console.tsx
  // shares (this file already imports plain types from there — `SportInfo`,
  // `LiveState` — so this follows suit rather than a second copy). Computed
  // above the `if (dead)` early return below: a hook cannot follow a
  // conditional return without breaking React's Rules of Hooks.
  const padSpecForMount = useMemo(
    () =>
      resolvePadSpecForMount(sport.key, scorePadV2?.moduleVersion ?? "", scorePadV2?.resolvedConfig ?? sport.config),
    [scorePadV2, sport.key, sport.config],
  );

  // STABLE IDENTITY, and the whole point of the memo (2026-09-22). This object
  // is forwarded to `usePadPipeline` -> `useFixtureStream`, where `auth` is a
  // DEPENDENCY of the subscribe effect (`use-fixture-stream.ts`). A fresh
  // literal here therefore tore the realtime channel down and re-handshook it
  // on EVERY render of this component — and this component re-renders on every
  // `setBusy`, every resync, every local state change, which is to say
  // constantly while someone is scoring.
  //
  // Measured both ways against a real prod build and a real Supabase project
  // (`device-links.spec.ts`, "reaches its own inner pad faster than the poll",
  // E2E_REQUIRE_REALTIME=1). With the memo: the socket joins and the chrome's
  // `core.start` paints on the inner pad well inside POLL_MS. Revert this one
  // line to a fresh literal and the same test reds with "never moved off
  // \"0\" at all" — the teardown/re-handshake also restarts the polling
  // interval on every render, so while the component is re-rendering NEITHER
  // transport ever delivers. `use-fixture-stream.ts` already
  // reads `sinceSeq`/`onEvents`/`skipPollWhile` through refs for exactly this
  // reason, and its comment says so; the identity hazard was re-introduced
  // from the CALLER, which is why nothing in that file could see it.
  //
  // `token` is the only field, so this is stable for the life of the link.
  const padAuth = useMemo(() => ({ kind: "device_link" as const, token }), [token]);

  // Doc 13 §7: the pad's dead-end when the link dies mid-day.
  if (dead) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <p className="text-4xl">⏱️</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-100">{dead}</h1>
        <p className="mt-2 text-sm text-slate-400">{msg("device.askFreshLink")}</p>
      </div>
    );
  }

  const summary = live.summary as { headline?: string } | null;
  const decided = live.outcome !== null;
  const started = live.status !== "scheduled";
  const scoring = live.status !== "finalized" && live.status !== "cancelled";
  const inPlay = live.status === "in_play";

  // Undo-own (doc 13 §7): only un-voided events THIS link recorded.
  const lastOwnVoidable = [...events]
    .reverse()
    .find(
      (e) =>
        e.device_link_id === deviceLinkId &&
        e.type !== "core.void" &&
        !events.some((v) => v.voids_event_id === e.id),
    );

  return (
    <div className="space-y-4">
      {/* LED-scoreboard header: the one glowing thing on the dark court.
          Accent keel + org logo carry the club branding (--ps-* chain). */}
      <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
        <div aria-hidden className="h-0.5 bg-accent" />
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-2">
          <p className="flex min-w-0 items-center gap-2 truncate text-[11px] uppercase tracking-widest text-slate-400">
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="h-5 w-5 shrink-0 rounded bg-white/10 object-cover" />
            )}
            <span className="truncate">
              {fixture.division_name} · {msg("schedule.round", { n: fixture.round_no })}
              {fixture.court_label ? ` · ${fixture.court_label}` : ""}
            </span>
          </p>
          {inPlay ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-emerald-400">
              <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {msg("device.live")}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] uppercase tracking-widest text-slate-400">
              {statusLabel(live.status)}
            </span>
          )}
        </div>
        <div className="px-3 py-4 text-center sm:px-4 sm:py-5">
          <p className="flex items-baseline justify-center gap-3 text-sm font-medium text-slate-200">
            {/* R7/C5 (D-6) — people for an individual or pair entrant; a
                team keeps its snapshotted name. Same resolution the console
                uses, never a second one (lib/entrant-name.ts). */}
            <span className="max-w-[40%] truncate">
              {home ? entrantDisplayName(home) : msg("schedule.tbd")}
            </span>
            <span className="text-[10px] uppercase tracking-widest text-slate-400">{msg("schedule.vs")}</span>
            <span className="max-w-[40%] truncate">
              {away ? entrantDisplayName(away) : msg("schedule.tbd")}
            </span>
          </p>
          {/* Fluid LED numerals: clamp to the phone's width so set-score
              headlines like "1 — 0 · 21-18 (16-12)" never wrap mid-number —
              each " · " group is atomic, wraps only between groups. */}
          <p className="mt-2 font-mono text-[clamp(1.5rem,8.5vw,3rem)] font-bold leading-tight tabular-nums tracking-tight text-emerald-300 [text-shadow:0_0_24px_rgba(52,211,153,0.35)]">
            {(summary?.headline ?? "0 — 0").split(" · ").map((group, i, all) => (
              <span key={i} className="inline-block whitespace-nowrap">
                {group}
                {i < all.length - 1 && <span className="mx-2 text-slate-400">·</span>}
              </span>
            ))}
          </p>
        </div>
        <p className="border-t border-slate-800 px-4 py-2 text-center text-[10px] uppercase tracking-widest text-slate-400">
          {msg("device.courtsideFooter", { scorer: sport.scorerLabel.toLowerCase() })}
        </p>
      </header>

      {error && (
        <p className="rounded-md border border-red-900/50 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {scoring && home && away && (!started || lastOwnVoidable) && (
        <div className="flex flex-wrap gap-2">
          {!started && (
            <button
              type="button"
              data-testid="score-start-match"
              disabled={busy || padSyncing}
              onClick={() => send("core.start", {})}
              className="btn btn-primary h-12 flex-1 text-base"
            >
              {msg("score.startMatch")}
            </button>
          )}
          {lastOwnVoidable && (
            <button
              type="button"
              data-testid="device-void-mine"
              disabled={busy || padSyncing}
              onClick={() => send("core.void", { event_id: lastOwnVoidable.id })}
              className="flex h-12 items-center justify-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-6 text-sm font-semibold text-amber-300 transition hover:border-amber-400/60 hover:bg-amber-500/20 active:scale-[0.98] disabled:opacity-50"
              title={msg("score.voidLastTitle", { type: lastOwnVoidable.type, seq: lastOwnVoidable.seq })}
            >
              <span aria-hidden className="text-base leading-none">⟲</span>
              {msg("device.undoMine")}
            </button>
          )}
        </div>
      )}

      {/* Sport pad — S13/#422: the v2 registry, unconditionally (the flag and
          the seven v1 pads it used to choose between are gone). `scorePadV2`
          stays a null-guard, not a flag check: it is null only when
          server-side bootstrap resolution failed, in which case there is no
          v1 chain left to fall back to and the section renders nothing.
          Owner ruling 17 (2026-09-06) — `shouldMountPad(...)` (was the
          narrower `!decided`): a decided fixture keeps the pad mounted iff
          its own `padSpec(cfg)` declares a post-phase panel, the same
          predicate `fixture-console.tsx` shares. */}
      {scorePadV2 && scoring && shouldMountPad({ decided, padSpec: padSpecForMount }) && home && away && (
        <section className="card p-4">
          <ScoringErrorBoundary>
            <ScorePad
              fixtureId={fixture.id}
              sportKey={sport.key}
              moduleVersion={scorePadV2.moduleVersion}
              resolvedConfig={scorePadV2.resolvedConfig}
              home={home}
              away={away}
              initialEvents={scorePadV2.initialEvents}
              auth={padAuth}
              identity={scorePadV2.identity}
              entitlements={scorePadV2.entitlements}
              onEvents={handlePadEvents}
            />
          </ScoringErrorBoundary>
        </section>
      )}

      {decided && scoring && (
        <p className="rounded-md border border-emerald-900/50 bg-emerald-950/60 px-3 py-2 text-sm text-emerald-300">
          {msg("device.resultRecorded")}
        </p>
      )}
    </div>
  );
}
