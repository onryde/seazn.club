"use client";
// Spectator surface W1, Task 10 — the live-fixture transport, lifted verbatim
// from `live-score.tsx` (poll every POLL_MS, Supabase Realtime subscribe when
// entitled, 250 ms debounce on a realtime broadcast) so `MatchCentre` and the
// legacy `LiveScore` scoreboard share ONE transport instead of two copies of
// the same wiring. `LiveScore` now delegates here (see `../live-score.tsx`).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveFixture, fetchPublicRealtimeToken, type LiveFixtureData, type RealtimePurpose } from "../live-score-data";
import { FIXTURE_STATUSES, LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";
import { publishBoardPush } from "./live-board-channel";

export const POLL_MS = 15_000;

/** The safety-net poll once a realtime channel is SUBSCRIBED (slideshow pattern). */
export const SUBSCRIBED_POLL_MS = 60_000;

/** How long a SETTLED fixture (decided, forfeited, abandoned — `SETTLED_FIXTURE_STATUSES`) keeps listening, counted
 *  from when this hook first sees it settled. A settled ledger still takes an undo, and an undo must reach an open page
 *  (owner bug 2026-10-15: the stream overlay's end card stayed on air after the deciding point was undone) — but
 *  `decided` is also where most matches STAY (finalizing is manual), so an unbounded listen would make every result
 *  page opened from a share a poll for as long as its tab is open. The window bounds that to one burst per page. */
export const SETTLED_LISTEN_MS = 15 * 60_000;

/** The SHIPPED poll interval inside the settled window — a quarter of the live rate, since nothing moves a settled
 *  fixture but an undo or a reset. A realtime channel stays on beside it, so a push still arrives at once. The premise
 *  test pins THIS symbol, never the live `SETTLED_POLL_MS`, so an e2e override cannot move what ships. */
export const DEFAULT_SETTLED_POLL_MS = 60_000;

/** The e2e override's name, exported so a test names the same string as the build-time substitution below. */
export const SETTLED_POLL_MS_ENV_VAR = "NEXT_PUBLIC_E2E_SETTLED_POLL_MS";
/** The shortest settled interval an override may ask for. */
export const MIN_SETTLED_POLL_MS = 5_000;

/** Parse an override. Only a plain integer in [MIN_SETTLED_POLL_MS, DEFAULT_SETTLED_POLL_MS] is taken; anything else
 *  — absent, blank, non-numeric, fractional, out of range — falls back to the shipped default. The clamp runs both
 *  ways on purpose: below the floor a settled page would poll FASTER than a live one (the load this window exists to
 *  bound), and above the default an undo would take longer than shipped to reach the page. A typo therefore only slows
 *  an e2e leg down, never changes what a spectator's tab costs. Pure and exported for its own tests: the resolved
 *  constant alone cannot tell a rejected override from an absent one (same shape as `resolveHoldMs`, queue.ts). */
export function resolveSettledPollMs(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return DEFAULT_SETTLED_POLL_MS;
  const ms = Number(raw);
  return ms >= MIN_SETTLED_POLL_MS && ms <= DEFAULT_SETTLED_POLL_MS ? ms : DEFAULT_SETTLED_POLL_MS;
}

/** The settled interval this build uses: `DEFAULT_SETTLED_POLL_MS` in every shipped build, overridable ONLY through
 *  `NEXT_PUBLIC_E2E_SETTLED_POLL_MS`, which e2e.yml sets at JOB level so the production bundle (Next substitutes the
 *  literal member expression at BUILD time — a dynamic `process.env[...]` read would compile to undefined) and the
 *  Playwright runner (which imports this module to derive its step budgets) read one value. CI's e2e runs on the poll
 *  path (stub Supabase), where every undo step otherwise waits out a full 60 s settled tick. No deploy config may set
 *  it (`settled-poll-override.test.ts`). */
export const SETTLED_POLL_MS = resolveSettledPollMs(process.env.NEXT_PUBLIC_E2E_SETTLED_POLL_MS);

/** What this transport does for a status: `open` listens without limit, `settled` listens for `SETTLED_LISTEN_MS`,
 *  `locked` never listens. */
export type ListenTier = "open" | "settled" | "locked";

const KNOWN_STATUSES: ReadonlySet<string> = new Set(FIXTURE_STATUSES);
const warnedUnknown = new Set<string>();

export function listenTierOf(status: string): ListenTier {
  if (LOCKED_FIXTURE_STATUSES.has(status)) return "locked";
  if (SETTLED_FIXTURE_STATUSES.has(status)) return "settled";
  // FAIL-OPEN on a status this build does not know (a newer server, a migration ahead of the client): treated as
  // open, so the page keeps listening rather than freezing on a fixture that may still move. Wrong in the cheap
  // direction — it costs polls, never a stale card. Logged once per status so the drift is visible.
  if (!KNOWN_STATUSES.has(status) && !warnedUnknown.has(status)) {
    warnedUnknown.add(status);
    console.warn(`useLiveFixture: unknown fixture status ${JSON.stringify(status)} — listening as if open`);
  }
  return "open";
}

/** How often the presentation buffer is drained (review MINOR 2). It is a
 *  FIXED tick, not a per-snapshot timer, so a snapshot received at `t` is
 *  presented at the first tick at or after `t + delayMs` — the cold start is
 *  bounded by `[delayMs, delayMs + DRAIN_MS)`, never "exactly delayMs". */
export const DRAIN_MS = 1000;

/** Stream overlay W1 (design §3.3): the ONE transport now serves two payloads
 *  — the public fixture JSON (`MatchCentre`, the default) and the overlay
 *  endpoint (`OverlayStage`, via `fetcher`). `delayMs` is R2's presentation
 *  buffer, built here so the seam is real from W1; with it absent the hook is
 *  byte-identical to the spectator-W1 version.
 *
 *  `fetcher` does NOT have to be referentially stable: it is held in a ref and
 *  re-pointed every render, so `refresh` keeps one identity for the life of the
 *  hook. It used to be a `useCallback` dependency of `refresh`, which is itself
 *  a dependency of the poll effect — a caller minting an inline arrow therefore
 *  cleared and re-armed the POLL_MS interval on EVERY render, and a component
 *  that re-renders faster than POLL_MS would never poll at all. Silent, and
 *  invisible to a props-stable test harness. */
export interface UseLiveFixtureOptions<T extends LiveFixtureData> {
  fetcher?: (fixtureId: string) => Promise<T>;
  /** Present snapshots no sooner than `delayMs` after they were received —
   *  `initial` included (I1, 2026-09-10), which is why a delayed hook presents
   *  nothing at all for its first `delayMs`. See `awaitingDelay`.
   *
   *  NO SOONER, not "exactly": the drain is a fixed `DRAIN_MS` tick, so the
   *  wait is in `[delayMs, delayMs + DRAIN_MS)` (review MINOR 2). */
  delayMs?: number;
  /** RT (lane-close fix, ruled 2026-09-29): the purpose this caller DECLARES on its realtime-token request — the OBS
   *  overlay's `overlay`, passed down from its page. Only WITH `overlayKey` does it make the hook ask when `realtime` is
   *  false: the route grants a community org's overlay on a key that verifies and refuses otherwise, so a purpose
   *  without a key would be a request certain to 403. A refusal leaves the hook on the poll exactly as before. A string,
   *  so a caller that re-mints its options object every render never re-subscribes. */
  realtimePurpose?: RealtimePurpose;
  /** RT: the signed overlay key from the OBS URL (server/overlay/overlay-key.ts), sent beside the purpose. A string for
   *  the same reason. The route verifies it; the client never can. */
  overlayKey?: string;
  /** R2005 (change 2): poll at exactly this interval in EVERY tier — open, settled past its listen window, locked, and
   *  with a realtime channel up — in place of the tier's own (15 s, 60 s, never). The compositor host passes
   *  `STREAM_POLL_MS` (5 s), because its score-stale rule (`SCORE_STALE_AFTER_MS`, 10 s) would read any of the tier
   *  intervals as a dead feed between two healthy polls. Absent: the tiers, unchanged. A number, so a caller that
   *  re-mints its options object every render never re-arms the interval. */
  steadyPollMs?: number;
}

export interface UseLiveFixtureResult<T extends LiveFixtureData = LiveFixtureData> {
  data: T;
  transport: "realtime" | "poll";
  /** How far behind wall time the PRESENTED snapshot is (= `delayMs`, 0 by
   *  default). The overlay clock subtracts it (design §3.6); nothing else
   *  reads it. A FIELD here, never a module export — one authority per hook
   *  instance (design FS17). */
  presentationNowOffsetMs: number;
  /**
   * True while a DELAYED hook has not yet presented anything — i.e. `initial`
   * was received less than `delayMs` ago and no buffered snapshot is due.
   * Always `false` when `delayMs` is 0 or absent, so a three-argument caller
   * never sees it turn true and needs no branch for it.
   *
   * **A delayed consumer MUST gate its render on this.** While it is true,
   * `data` is still the un-presented seed: non-null so the type stays
   * `T` for every existing caller, but not a snapshot this hook is willing to
   * vouch for as "how things were `delayMs` ago". Painting it anyway is
   * exactly the I1 defect (below).
   */
  awaitingDelay: boolean;
  /** R2005: the newest snapshot the TRANSPORT took and the wall time it took it — `initial` at mount, then every
   *  successful fetch (a failed one moves nothing). Not the presented `data`: a delayed hook presents late on purpose,
   *  and the compositor's score-stale signal measures the feed, not the picture. The programme phase rides it too
   *  (fallback B), because a phase describes the compositor NOW, not `delayMs` ago. */
  received: { at: number; snapshot: T };
}

export function useLiveFixture<T extends LiveFixtureData = LiveFixtureData>(
  fixtureId: string,
  initial: T,
  realtime: boolean,
  options: UseLiveFixtureOptions<T> = {},
): UseLiveFixtureResult<T> {
  const fetcher = options.fetcher ?? (fetchLiveFixture as (id: string) => Promise<T>);
  // Held in a ref so `refresh` — and therefore the poll effect that depends on
  // it — keeps ONE identity however often the caller re-mints its fetcher.
  //
  // Re-pointed in an effect, not in the render body: a render-phase ref write
  // is exactly what `react-hooks/refs` refuses (it is unsound under concurrent
  // rendering), and it buys nothing here. `useRef`'s initial value already
  // covers the first render, and an effect commits immediately after its
  // render — so the only window in which a poll would see the PREVIOUS
  // render's fetcher is between a re-render and its own commit, which a
  // POLL_MS tick would have to land inside.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const delayMs = options.delayMs ?? 0;
  const [data, setData] = useState<T>(initial);
  // The delay buffer: snapshots RECEIVED, waiting to be PRESENTED. Empty and
  // unused when delayMs is 0.
  const bufferRef = useRef<{ receivedAt: number; snapshot: T }[]>([]);
  // `initial` as of mount. A ref, so the seeding effect below reads the
  // mount-time document without listing a prop object in its dependencies —
  // this hook has always seeded ONCE and a changed `initial` has always needed
  // a `key` change (fixture-stream-panel.tsx does exactly that).
  const initialRef = useRef(initial);
  // I1 (review-unreviewed-range.md, 2026-09-10). `initial` used to be
  // presented at once even under a delay, because only POLLED snapshots went
  // through the buffer. `?delay=30000` therefore delayed the CLOCK and not the
  // SCORE for the first delayMs after every load, and OBS reloads a browser
  // source on every scene change — so a delayed overlay announced a goal up to
  // 30 s before the picture reached it, which is the one thing the parameter
  // exists to prevent.
  //
  // `initial` is now the buffer's FIRST entry, received at mount and matured
  // by the same drain as every polled one. One rule, no exceptions: with
  // `?delay=N`, nothing is presented that was not in hand N ms ago. The trade
  // is a cold start — a delayed overlay presents nothing for its first
  // delayMs, and its consumer must render nothing meanwhile (`awaitingDelay`).
  // That is deliberate and it is the smaller harm: a scorebug that is missing
  // reads as "graphics not up yet", a scorebug that is EARLY is a broadcast
  // failure. It is also paid only by an operator who explicitly typed
  // `?delay=`; without it this hook is byte-identical to the pre-fix version.
  //
  // Seeding through the buffer rather than a separate timer is what keeps that
  // cold start to one delay rather than two: starting it at the first poll
  // would have made it delayMs + POLL_MS (15 s more).
  //
  // IT IS NOT "EXACTLY delayMs" (review MINOR 2, 2026-09-10 — an earlier
  // revision of this comment and of `3e450e7d7`'s message both claimed it
  // was). The drain is a FIXED DRAIN_MS tick, so the seed is presented at the
  // first tick at or after delayMs: the bound is [delayMs, delayMs + DRAIN_MS)
  // and only a delayMs that is a whole multiple of DRAIN_MS hits its own
  // number. `resolveDelayMs` (`lib/overlay-delay.ts`) accepts any whole
  // millisecond value in 0..300 000, so `?delay=250` really does hold for a
  // full second — four times what the operator typed.
  //
  // Left as is rather than rounded or refused: an OBS operator plans scene
  // timing against the number, and quietly rewriting 250 to 1 000 would be a
  // second, invisible discrepancy on top of this one. A sub-second delay is
  // also not a use case anyone has — every real `?delay=` is seconds of
  // broadcast latency. If it ever becomes one, the fix is a shorter DRAIN_MS
  // (the buffer is a list scan, not a cost), not a rounded delayMs.
  const seededRef = useRef(false);
  const [awaitingDelay, setAwaitingDelay] = useState(delayMs > 0);
  const [received, setReceived] = useState<{ at: number; snapshot: T }>(() => ({ at: Date.now(), snapshot: initial }));
  // NO `updatedAt` state here. The freshness line ("Updated 5s ago") derives
  // from `header.updatedAt` — the DOCUMENT's own timestamp, ticked every
  // second by `useNow()` in `court-card.tsx` — never from when this hook last
  // succeeded. A hook-side clock would have said "Updated 0s ago" after a poll
  // that returned an unchanged document, i.e. reported the FETCH as freshness
  // rather than the DATA.

  // Review fix round 1 (MINOR 10) — a poll/debounced refresh in flight when
  // the component unmounts must not call `setState` on its way back; the
  // fetch itself is not cancelled (no AbortController plumbed through
  // `fetchLiveFixture`), only its EFFECT on state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetcherRef.current(fixtureId);
      if (!mountedRef.current) return;
      setReceived({ at: Date.now(), snapshot: next });
      if (delayMs <= 0) {
        setData(next);
        return;
      }
      bufferRef.current.push({ receivedAt: Date.now(), snapshot: next });
    } catch {
      // transient — keep the last known data (never throw to the UI)
    }
  }, [fixtureId, delayMs]);

  // `live` = this hook keeps its realtime channel and its poll. Three tiers
  // (`listenTierOf`), all read from `lib/fixture-status.ts` so they cannot
  // drift from the write path's own lock:
  //  - open (scheduled, in_play, the held needs_decision): listen, no limit.
  //  - settled (decided, forfeited, abandoned): the ledger still takes an undo
  //    that reopens it (owner bug 2026-10-15: this used to stop at `decided`,
  //    so the stream overlay's end card stayed on air after the scorer undid
  //    the deciding point) — listen for SETTLED_LISTEN_MS from the moment this
  //    hook first sees it settled, polling at SETTLED_POLL_MS, then stop.
  //  - locked (finalized, cancelled): the ledger refuses every write; never.
  // Back to open (an undo) clears the window; settling again starts a new one.
  const tier = listenTierOf(data.status);
  // Render-phase adjust, not an effect: a tier change resets the window's
  // expiry in the same render that observes it, so a stale `true` from the
  // previous settled spell can never tear down a fresh one.
  const [prevTier, setPrevTier] = useState(tier);
  const [settledExpired, setSettledExpired] = useState(false);
  if (tier !== prevTier) {
    setPrevTier(tier);
    setSettledExpired(false);
  }
  useEffect(() => {
    if (tier !== "settled") return;
    const id = setTimeout(() => {
      if (mountedRef.current) setSettledExpired(true);
    }, SETTLED_LISTEN_MS);
    return () => clearTimeout(id);
  }, [tier]);
  const live = tier === "open" || (tier === "settled" && !settledExpired);

  // Realtime push (entitled orgs; and the OBS stream overlay, which declares
  // its purpose with its signed key — RT). Any failure — no entitlement (403), env missing,
  // websocket refused — leaves `subscribed` false and polling takes over.
  //
  // Private channel + setAuth (scorepad shape). Mint is ES256 via
  // SUPABASE_JWT_PRIVATE_KEY; Realtime Authorization SELECT on
  // realtime.messages binds topic to JWT fixture_id claim (proved 2026-09-13).
  // Polling stays as safety net; publishFixtureUpdate still fans a public twin.
  const [subscribed, setSubscribed] = useState(false);
  const realtimePurpose = options.realtimePurpose;
  const overlayKey = options.overlayKey;
  // RT: a declared purpose asks only WITH its key — both, or it is a spectator's hook and `realtime` alone decides.
  const overlayAsk = Boolean(realtimePurpose && overlayKey);
  useEffect(() => {
    if ((!realtime && !overlayAsk) || !live) return;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    if (!supabaseUrl) return;
    // CI's stub host has no Realtime websocket. Still mint (the e2e asserts
    // ES256 on that response) but do not dial — setAuth/subscribe hangs on
    // stub.supabase.co and never flips transport (run 34834966169).
    const stubHost = /stub\.supabase\.co/i.test(supabaseUrl);
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      let token: { token: string; channel: string };
      try {
        token = await fetchPublicRealtimeToken(
          fixtureId,
          overlayAsk ? realtimePurpose : undefined,
          overlayAsk ? overlayKey : undefined,
        );
      } catch {
        return; // not entitled or server error → polling
      }
      if (cancelled || stubHost) return;
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        const sb = supabaseBrowser();
        await sb.realtime.setAuth(token.token);
        if (cancelled) return;
        channel = sb
          .channel(token.channel, { config: { private: true } })
          .on("broadcast", { event: "state_changed" }, () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(refresh, 250);
          })
          // T16 — an online chess board's move, pushed to spectators
          // (lib/realtime publishRoomBroadcast): relayed to the watch island,
          // which cannot open this channel a second time.
          .on("broadcast", { event: "board_state" }, (msg: { payload?: unknown }) => {
            publishBoardPush(fixtureId, msg.payload);
          })
          .subscribe((status: string) => {
            if (!cancelled) setSubscribed(status === "SUBSCRIBED");
          });
      } catch {
        // Missing anon key, websocket refused — stay on poll.
      }
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
      setSubscribed(false);
    };
  }, [fixtureId, realtime, overlayAsk, realtimePurpose, overlayKey, live, refresh]);

  // Drain the delay buffer every DRAIN_MS: present the newest snapshot whose
  // receivedAt ≤ now − delayMs, drop everything older. One interval, armed only
  // while delayMs > 0 — the no-option path never creates it.
  useEffect(() => {
    if (delayMs <= 0) {
      // Review MINOR 2026-09-10 (MINOR 1) — AN UNDELAYED PASS COUNTS AS
      // SEEDED. This early return used to sit above the once-guard, so a hook
      // that mounted with no delay and later received a non-zero `delayMs`
      // seeded the MOUNT-TIME document and presented it `delayMs` later,
      // winding the overlay back to the page-load score: exactly the defect
      // the guard below names, through the one transition it did not cover.
      // While `delayMs` was 0 every snapshot — `initial` first — was presented
      // the instant it arrived, so there is nothing left to mature.
      seededRef.current = true;
      return;
    }
    // I1: `initial` is the first thing in the buffer, received at mount. Once
    // only — a `delayMs` that changed mid-life would otherwise re-seed a
    // document that is by then long stale.
    if (!seededRef.current) {
      seededRef.current = true;
      bufferRef.current = [{ receivedAt: Date.now(), snapshot: initialRef.current }, ...bufferRef.current];
    }
    const id = setInterval(() => {
      const due = Date.now() - delayMs;
      const buf = bufferRef.current;
      let idx = -1;
      for (let i = 0; i < buf.length; i++) if (buf[i]!.receivedAt <= due) idx = i;
      if (idx >= 0 && mountedRef.current) {
        setData(buf[idx]!.snapshot);
        bufferRef.current = buf.slice(idx + 1);
        setAwaitingDelay(false);
      }
    }, DRAIN_MS);
    return () => clearInterval(id);
  }, [delayMs]);

  // 15 s polling — primary on Community / when push is not connected; slower
  // safety net once SUBSCRIBED (slideshow pattern), and SETTLED_POLL_MS inside
  // a settled window. NEVER stop polling entirely while live: a SUBSCRIBED
  // private channel that receives no broadcasts (e.g. public HTTP publish vs
  // private subscribe mismatch, fixed 2026-09-12) would otherwise freeze the
  // overlay on first paint.
  //
  // Immediate refresh only when undelayed: under `?delay=` a mount-time fetch
  // would land in the buffer next to the seed and the drain would present the
  // NEWER undelayed tip first (I1 regression). Interval still arms either way.
  // A NUMBER in the deps, so a settled transition on a subscribed channel
  // (60 s either way) does not re-arm the interval or re-fetch.
  const steadyPollMs = options.steadyPollMs;
  const pollMs = steadyPollMs ?? (tier === "settled" ? SETTLED_POLL_MS : subscribed ? SUBSCRIBED_POLL_MS : POLL_MS);
  // A steady interval polls whatever the tier says (R2005): the compositor host must hear from the feed every
  // `steadyPollMs`, a finished match included, or its score-stale signal would fire on a healthy page.
  const polling = steadyPollMs !== undefined || live;
  useEffect(() => {
    if (!polling) return;
    if (delayMs <= 0) void refresh();
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [polling, pollMs, refresh, delayMs]);

  return {
    data,
    transport: subscribed ? "realtime" : "poll",
    presentationNowOffsetMs: delayMs,
    awaitingDelay,
    received,
  };
}
