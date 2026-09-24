"use client";

// The stripped courtside pad behind /score/{token} (doc 13 §7, PROMPT-21).
// Reuses the sport pads; capabilities are the device-link subset — append +
// undo OWN events, nothing else. Every call presents the dl_ token as a
// Bearer header; the token stays in this tab (component prop), never storage.
// Offline-tolerant: sends retry with the SAME idempotency key (doc 08 §4).
import { useCallback, useMemo, useState } from "react";
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
import { deadLinkKey, VIEW_ONLY_COPY, type ViewOnlyReason } from "@/lib/scan-screen";
import { officialLabelKey } from "@/lib/official-label";
import { useTabReturn } from "@/components/v2/use-tab-return";
import { eventOutToEnvelope } from "@/components/v2/scorepad/wire";
import type { EventEnvelope } from "@seazn/engine/core";

export type PadSideInfo = SideInfo;

export interface PadEventIn {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  voids_event_id: string | null;
  device_link_id: string | null;
  /** Who recorded it — the post-Start seed (`padSeed`) carries it into the
   *  inner pad's envelopes, whose timeline reads `recordedBy`. */
  recorded_by?: string | null;
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
    /** Scorer sheets §4.5.1 — the Confirm card's "R1·3" (`matchRef`) and its
     *  start time in the venue's zone, both resolved server-side. */
    match_ref?: string | null;
    scheduled_label?: string | null;
    /** The scorebug's round, as the schedule board names it ("Final",
     *  "Semi-finals"), or "Round n" where the board prints numbers (a league,
     *  Swiss) — resolved server-side by `scanMatchNames`. The page always sends
     *  it; "Round n" below is only for a caller that has no board to ask. */
    round_label?: string | null;
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
  /** Scorer sheets §4.5 — open on View-only (a final scoreboard, no controls)
   *  for a reason the scan page already knows at load. `null`/absent opens
   *  live; a refused write can still move a live screen here (`viewOnly`). */
  initialViewOnly?: ViewOnlyReason | null;
}

const DEAD_CODES = new Set(["LINK_EXPIRED", "LINK_REVOKED", "LINK_INVALID", "UNAUTHENTICATED"]);

/** How many times `resync` re-reads a ledger that is behind the `/state` it
 *  was read beside, before it gives up (see there). One sequential re-read is
 *  enough in principle — it is issued after `/state` answered, so every event
 *  up to that tip is committed — and events are append-only (no path deletes a
 *  `score_events` row; every `match_states.last_seq` writer takes it from the
 *  ledger), so a lag cannot be permanent. The second is slack, and the bound is
 *  what stops a server that ever broke that invariant from spinning a phone. */
const LEDGER_CATCHUP_READS = 2;

/** One scorebug-line separator. Below md, a fixed-width box (w-4) so the
 *  wrapping line can hang every item's separator in a clipped gutter of
 *  exactly that width (the row's `max-md:-ml-4`) — see the scorebug's comment;
 *  change both together. From md up, the natural " · " the line had before. */
const SCOREBUG_SEP = "whitespace-pre max-md:inline-block max-md:w-4 max-md:shrink-0 max-md:text-center";

/** The ledger's tip: the seq of its last row (`listEvents` orders by seq,
 *  voids included), 0 for an empty ledger — the same 0 `/state` reports for a
 *  match with no events. */
const ledgerTip = (events: readonly PadEventIn[]) => events[events.length - 1]?.seq ?? 0;

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
  initialViewOnly = null,
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
  /** The resolver's CODE for a dead link (`LINK_REVOKED`, …), never its
   *  English message: the screen says it through `deadLinkKey` (P12). */
  const [dead, setDead] = useState<string | null>(null);
  /** Scorer sheets §4.5 — the link is alive but this fixture is over for it:
   *  a final scoreboard, no controls. NOT `dead` (the link still resolves, so
   *  `RESULT_CARRIED_FORWARD` is deliberately absent from `DEAD_CODES`). Two
   *  ways in once mounted: this chrome's own `send()` refused, or the inner
   *  pad's pipeline refused (`onTerminalRefusal`, via the registry). */
  const [viewOnly, setViewOnly] = useState<ViewOnlyReason | null>(initialViewOnly);
  // The server's verdict can change under a mounted screen (a re-render of the
  // scan page after an organiser void lifts a carry, #856, or after one lands):
  // a NEWER `initialViewOnly` replaces whatever this screen last knew, both
  // ways. Adjusted during render (React's "adjusting state when a prop
  // changes"), not in an effect, so no frame paints the stale screen. An
  // unchanged prop leaves a live refusal's View-only alone.
  const [seenInitialViewOnly, setSeenInitialViewOnly] = useState(initialViewOnly);
  if (initialViewOnly !== seenInitialViewOnly) {
    setSeenInitialViewOnly(initialViewOnly);
    setViewOnly(initialViewOnly);
  }
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
  /** What the inner pad mounts on. The page's bootstrap when the page itself
   *  rendered the match started; otherwise the ledger of whichever read first
   *  saw it started (`seededStarted`, below the dead-link return). */
  const [padSeed, setPadSeed] = useState<readonly EventEnvelope[]>(scorePadV2?.initialEvents ?? []);
  /** The `started` that `padSeed` was taken for. Starts as the page's own
   *  status, whose ledger IS the bootstrap. */
  const [seededStarted, setSeededStarted] = useState(initialState.status !== "scheduled");

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
        const readLedger = () =>
          authed<PadEventIn[]>(`/api/v1/fixtures/${fixture.id}/events?since_seq=0`, {
            signal: controller?.signal,
          });
        const [state, first] = await Promise.all([
          authed<LiveState>(`/api/v1/fixtures/${fixture.id}/state`, { signal: controller?.signal }),
          readLedger(),
        ]);
        let all = first;
        // The two reads are CONCURRENT (review round 2), so the ledger's can be
        // answered before an event `/state` then sees — a Start landing between
        // them reads as "started" over a ledger without core.start, and the
        // inner pad would mount on it (`seededStarted`). So the ledger must
        // reach `/state`'s tip before either lands; a later re-read is issued
        // after `/state` answered, so it sees what `/state` saw. Bounded by
        // `LEDGER_CATCHUP_READS`; past it this refresh fails like any other (no
        // message — see `ResyncShapeError` below) and lands nothing.
        for (let reread = 0; Array.isArray(all) && state !== null && typeof state === "object"
          && ledgerTip(all) < state.last_seq; reread++) {
          if (reread === LEDGER_CATCHUP_READS) throw Object.assign(new Error(), { name: "ResyncLagError" });
          controller?.signal.throwIfAborted();
          all = await readLedger();
        }
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
        // The ledger lands BEFORE the status: the render in which the match
        // first reads as started seeds the inner pad from `events` (see
        // `seededStarted`), so that render must already hold this read's
        // ledger. React batches the pair anyway; this order keeps it true
        // where nothing batches.
        setEvents(all);
        setLive(state);
        return all;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
    [authed, fixture.id],
  );

  /** Same seam and same reasoning as fixture-console.tsx's own
   *  `handlePadEvents` — see its comment. `<ScorePad/>`'s own pipeline
   *  stamps a client-fabricated id on every event it has not yet seen acked,
   *  and on every event acked WITHOUT an `event_id` (device-void-mine: an ack
   *  that names its row gets the server's id), so the raw event list this
   *  fires with is still deliberately unused; only a real `resync()` (the
   *  same one `send()` already trusts) is guaranteed to give this component
   *  the real id `lastOwnVoidable` needs. A failed opportunistic resync is swallowed — with ONE exception:
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
        if (err instanceof ApiV1Error && DEAD_CODES.has(err.code)) setDead(err.code);
      })
      .finally(() => setPadSyncing(false));
  }, [resync]);

  /** Scorer sheets §4.5 — entering View-only while this screen is live, from
   *  either way in: this chrome's own `send()` refused, or the inner pad's
   *  (`onTerminalRefusal`, via the registry, for `transport.ts`'s
   *  CHROME_TERMINAL_CODES — whose one member is the carried-forward refusal).
   *
   *  A write was just refused because the result moved the competition on,
   *  and nothing told this chrome the match had even ended — that is how a
   *  write got tapped at all — so its header can still read "Live" over a
   *  stale score. View-only keeps the header as the FINAL scoreboard (§4.5.3),
   *  so it re-reads the server's settled state once, through
   *  `handlePadEvents`: bounded, and a dead link still lands on the dead
   *  screen. Stable for the life of the link, and above the `if (dead)`
   *  return (Rules of Hooks). */
  const enterCarriedForward = useCallback(() => {
    setViewOnly("carried_forward");
    handlePadEvents();
  }, [handlePadEvents]);

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
        // A Start's re-read is what seeds the inner pad (`seededStarted`).
        await resync();
        return true;
      } catch (err) {
        if (err instanceof ApiV1Error && DEAD_CODES.has(err.code)) {
          setDead(err.code);
        } else if (err instanceof ApiV1Error && err.code === "RESULT_CARRIED_FORWARD") {
          // Scorer sheets §4.5 — the chrome's own write (Start, "Void my last
          // entry") refused because the result moved the competition on.
          enterCarriedForward();
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
            err instanceof ApiV1Error ? err.extra : null,
          ));
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [authed, fixture.id, live.last_seq, resync, enterCarriedForward],
  );

  // G1 — this pad's own freshness floor (`useTabReturn`, whose doc carries the
  // reasoning: why not an interval, why BOTH events, why the visibility guard,
  // why the DOM guard has two clauses). A return costs two refreshes (four
  // requests here: each is `/state` plus the ledger).
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
  // `!dead`: a dead link never answers again, so a dead pad stops listening —
  // the hook's cleanup removes both listeners the moment `dead` flips, and
  // nothing re-adds them. Without this, every later return would spend four
  // requests on a link that can only refuse them. Same truthiness as the
  // dead-screen `if (dead)` below, so "listening" and "live screen" agree.
  //
  // Identity: `resync` is keyed on `[authed, fixture.id]`, `authed` on
  // `[token]`, `handlePadEvents` on `[resync]` — all stable for the life of the
  // link, so this subscribes once.
  useTabReturn(handlePadEvents, !dead);

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
  // (`device-links.spec.ts`, then titled "reaches its own inner pad faster
  // than the poll" — now "a second writer's event reaches a device link's
  // inner pad, mounted after Start, faster than the poll" since the pad mounts
  // only after Start; E2E_REQUIRE_REALTIME=1). With the memo: the socket joins
  // and the event paints on the inner pad well inside POLL_MS. Revert this one
  // line to a fresh literal and the same test reds with "never moved off
  // \"0\" at all" — the teardown/re-handshake also restarts the polling
  // interval on every render, so while the component is re-rendering NEITHER
  // transport ever delivers. `use-fixture-stream.ts` already
  // reads `sinceSeq`/`onEvents`/`writeInFlight` through refs for exactly this
  // reason, and its comment says so; the identity hazard was re-introduced
  // from the CALLER, which is why nothing in that file could see it.
  //
  // `token` is the only field, so this is stable for the life of the link.
  const padAuth = useMemo(() => ({ kind: "device_link" as const, token }), [token]);

  // Doc 13 §7: the pad's dead-end when the link dies mid-day.
  if (dead) {
    return (
      <div data-testid="scan-dead-link" className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <p className="text-4xl">⏱️</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-100">{msg(deadLinkKey(dead))}</h1>
        <p className="mt-2 text-sm text-slate-400">{msg("device.askFreshLink")}</p>
      </div>
    );
  }

  const summary = live.summary as { headline?: string } | null;
  const decided = live.outcome !== null;
  const started = live.status !== "scheduled";
  // P8, for EVERY way into "started" (Task 6 review I1). The inner pad mounts
  // only once the match is started (Confirm, §4.5.1), and its stream does not
  // read on mount, so it must mount on the ledger of the read that FIRST saw
  // the match started — never the page's pre-start bootstrap, or its first tap
  // goes out at a stale seq for up to POLL_MS. That read may be this phone's
  // own Start, a Start refused SEQ_CONFLICT because another device got there
  // first, a tab return after another device started, or a second tap after a
  // Start whose re-read failed: all of them go through `resync`, which lands
  // `events` with `live`. Adjusted during render ("adjusting state when a prop
  // changes"), so no frame mounts the pad on the old seed.
  if (started !== seededStarted) {
    setSeededStarted(started);
    if (started) {
      setPadSeed(events.map((e) => eventOutToEnvelope(fixture.id, { ...e, recorded_by: e.recorded_by ?? null })));
    }
  }
  const scoring = live.status !== "finalized" && live.status !== "cancelled";
  const inPlay = live.status === "in_play";
  // Scorer sheets §4.5.3 — View-only is "final scoreboard, no controls": the
  // header stays, every control and the inner pad go. A match finalised or
  // cancelled while this screen is up (seen by any re-read) lands here too,
  // with its own words — not a screen that silently lost its controls. A
  // terminal status outranks a carried-forward refusal, the same order as the
  // scan page's `scanScreen`.
  const shownViewOnly: ViewOnlyReason | null =
    live.status === "finalized" ? "finalized" : live.status === "cancelled" ? "cancelled" : viewOnly;
  const canAct = shownViewOnly === null;
  const confirming = canAct && live.status === "scheduled" && !!home && !!away;

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
            {/* The round is the part a scorer checks against the sheet, so it
                never shrinks; the division (and court) give way to it. As one
                truncating span, the round was the first thing cut at 320
                ("SCAN CUP … · FI…"). Never shrinking alone then CLIPPED the
                longest board labels at 320 with no ellipsis (fr "Grande
                finale (revanche)" beside a logo, review round 2), so below
                md the line wraps: the round moves down as one unit when it
                does not fit beside the division, and a label longer than a
                whole line wraps inside itself (`max-w-full` caps it at the
                line).

                SEPARATORS never lead a line. CSS cannot tell which item a wrap
                put first, so below md EVERY item — the division included —
                carries its separator in front, `SCOREBUG_SEP`'s fixed w-4; the
                row hangs exactly that far left of the clipping box (`-ml-4`),
                so the first item on EVERY line has its separator in the
                clipped gutter while an item mid-line shows its own. The two
                widths must match (a unit test pins it). The whole trick is
                `max-md:` (review round 3): ≥md the row never wraps, the
                division shows no separator (`md:hidden`) and every other one
                is its natural " · " — a fixed box at every width made each
                one wider — so from 768 up the line is exactly the one before
                the wrap work (AGENTS.md: at 768 and above nothing changes).

                Below md the round is a FLEX item — its separator, then the
                label as its own box. As plain inline text, a label that wraps inside
                itself started its second line at the item's left edge, which
                is in the clipped gutter: fr "Grande finale (revanche)" lost
                the "(r" of its second line. In its own box the label's every
                line starts after the separator.

                Once the label wraps, its WIDEST WORD is its min-content
                width — and beside a wide status at 320 with a logo (es "POR
                INCOMPARECENCIA") that word can be wider than all the room
                the line has: "PERDEDORES" painted "PERDEDOR" (review round
                3). So below md the label may shrink below that word and
                break inside it (`min-w-0`, `wrap-anywhere`) rather than
                clip. */}
            <span data-testid="scan-scorebug-clip" className="min-w-0 max-md:overflow-hidden">
              <span data-testid="scan-scorebug-line" className="flex items-baseline max-md:-ml-4 max-md:flex-wrap">
                <span className="flex min-w-0">
                  <span aria-hidden data-scorebug-sep="" className={`md:hidden ${SCOREBUG_SEP}`}>
                    {" · "}
                  </span>
                  <span data-testid="scan-scorebug-division" className="min-w-0 truncate">
                    {fixture.division_name}
                  </span>
                </span>
                <span
                  data-testid="scan-scorebug-round"
                  className="shrink-0 max-md:flex max-md:max-w-full max-md:items-baseline"
                >
                  <span data-scorebug-sep="" className={SCOREBUG_SEP}>
                    {" · "}
                  </span>
                  <span
                    data-testid="scan-scorebug-round-label"
                    className="whitespace-pre max-md:min-w-0 max-md:whitespace-normal max-md:wrap-anywhere"
                  >
                    {fixture.round_label ?? msg("schedule.round", { n: fixture.round_no })}
                  </span>
                </span>
                {fixture.court_label ? (
                  <span className="min-w-0 truncate">
                    <span data-scorebug-sep="" className={SCOREBUG_SEP}>
                      {" · "}
                    </span>
                    {fixture.court_label}
                  </span>
                ) : null}
              </span>
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
          {/* The sport's official in the viewer's language (Task 3's
              `officialLabelKey`), never the engine's English `scorerLabel`. */}
          {msg("device.courtsideFooter", { scorer: msg(officialLabelKey(sport.key)).toLowerCase() })}
        </p>
      </header>

      {shownViewOnly !== null && (
        <p
          data-testid="scan-view-only"
          role="status"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-3 text-center text-sm text-slate-200"
        >
          {msg(VIEW_ONLY_COPY[shownViewOnly])}
        </p>
      )}

      {error && (
        <p className="rounded-md border border-red-900/50 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {/* Scorer sheets §4.5.1 — Confirm: a scan of a match not yet started
          shows WHICH match before anything can be scored, so an umpire at the
          wrong court finds out before the first tap. Start lives here, and
          the inner pad mounts only once the match is started. */}
      {confirming && (
        <section data-testid="scan-confirm" className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <h2 className="text-sm font-semibold text-slate-100">{msg("device.scan.confirmTitle")}</h2>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            {fixture.court_label && (
              <>
                <dt className="text-slate-400">{msg("device.scan.court")}</dt>
                <dd className="min-w-0 truncate text-slate-100">{fixture.court_label}</dd>
              </>
            )}
            {fixture.scheduled_label && (
              <>
                <dt className="text-slate-400">{msg("device.scan.time")}</dt>
                <dd className="min-w-0 truncate text-slate-100">{fixture.scheduled_label}</dd>
              </>
            )}
            <dt className="text-slate-400">{msg("device.scan.match")}</dt>
            <dd className="min-w-0 truncate text-slate-100">
              {fixture.division_name}
              {fixture.match_ref ? ` · ${fixture.match_ref}` : ""}
            </dd>
          </dl>
          <p className="mt-3 break-words text-base font-semibold text-slate-100">
            {entrantDisplayName(home!)}{" "}
            <span className="text-[10px] uppercase tracking-widest text-slate-400">{msg("schedule.vs")}</span>{" "}
            {entrantDisplayName(away!)}
          </p>
          <p className="mt-2 text-xs text-slate-400">{msg("device.scan.confirmHint")}</p>
          <button
            type="button"
            data-testid="score-start-match"
            disabled={busy || padSyncing}
            onClick={() => send("core.start", {})}
            className="btn btn-primary mt-4 h-12 w-full text-base"
          >
            {msg("score.startMatch")}
          </button>
        </section>
      )}

      {canAct && scoring && home && away && lastOwnVoidable && (
        <div className="flex flex-wrap gap-2">
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
      {canAct && started && scorePadV2 && scoring && shouldMountPad({ decided, padSpec: padSpecForMount }) && home && away && (
        <section className="card p-4">
          <ScoringErrorBoundary>
            <ScorePad
              fixtureId={fixture.id}
              sportKey={sport.key}
              moduleVersion={scorePadV2.moduleVersion}
              resolvedConfig={scorePadV2.resolvedConfig}
              home={home}
              away={away}
              initialEvents={padSeed}
              auth={padAuth}
              identity={scorePadV2.identity}
              entitlements={scorePadV2.entitlements}
              onEvents={handlePadEvents}
              onTerminalRefusal={enterCarriedForward}
            />
          </ScoringErrorBoundary>
        </section>
      )}

      {canAct && decided && scoring && (
        <p className="rounded-md border border-emerald-900/50 bg-emerald-950/60 px-3 py-2 text-sm text-emerald-300">
          {msg("device.resultRecorded")}
        </p>
      )}
    </div>
  );
}
