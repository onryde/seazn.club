// Competition Desk W4: the in-play band's polling schedule, lifted out of the
// component so it can actually be tested.
//
// `apps/web` vitest is `environment: "node"` — no DOM, so `useEffect` never
// runs in a unit test and every scheduling decision made inside one is
// invisible to the suite. The band shipped in W3 with its whole schedule
// inside the effect; the tests could see the markup and nothing else. So the
// decisions live here as a plain function over injected timers, and the
// effect is reduced to one call.
//
// What W3 got wrong, and this fixes: the interval was CLEARED once nothing
// was in play, on the reasoning that a quiet competition should not poll a
// permanently-empty band. That is true of the fast poll and false of the
// band. `inPlay.length === 0` renders `null`, so a desk left open before the
// first match of the day never noticed that match STARTING — the band only
// appeared on a manual reload. Quiet is exactly the state that needs a
// (slow) poll, because it is the state that cannot see its own change.

/** While something is live: the cadence a scoreline is worth. */
export const LIVE_POLL_MS = 20_000;
/** While the band is empty: slow enough to be free, fast enough that the
 *  first fixture of the day appears without a reload. Deliberately not a
 *  multiple of the live period — nothing depends on the two aligning, and a
 *  round 90s reads as "about a minute and a half" to whoever tunes it next. */
export const QUIET_POLL_MS = 90_000;

/** The only thing the schedule decides. Exported so a test can pin the
 *  RELATION (quiet is slower) as well as the two values — a change that made
 *  both periods equal would still satisfy a test that only checked one. */
export function bandPollMs(live: boolean): number {
  return live ? LIVE_POLL_MS : QUIET_POLL_MS;
}

/** Everything `startBandPolling` touches outside itself. Injected rather than
 *  reached for so the node-environment suite can drive it. */
export interface BandPollDeps {
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  addVisibilityListener: (fn: () => void) => void;
  removeVisibilityListener: (fn: () => void) => void;
  isVisible: () => boolean;
}

/** Starts polling `refresh` at the cadence `live` implies, pausing while the
 *  tab is hidden and catching up once when it comes back. Returns the
 *  teardown — the shape `useEffect` wants.
 *
 *  No fetch on start: the band is server-rendered, so the state it would
 *  fetch is the state it already has. The catch-up fetch fires only on a
 *  hidden → visible transition, where the page genuinely is stale. */
export function startBandPolling(
  live: boolean,
  refresh: () => void,
  deps: BandPollDeps,
): () => void {
  const period = bandPollMs(live);
  let timer: number | undefined;
  const stop = () => {
    if (timer !== undefined) {
      deps.clearInterval(timer);
      timer = undefined;
    }
  };
  const start = () => {
    stop();
    timer = deps.setInterval(refresh, period);
  };
  const onVisibility = () => {
    if (!deps.isVisible()) {
      stop();
      return;
    }
    // Back from a hidden tab: whatever the band shows is as old as the time
    // away, so refresh once immediately rather than waiting out a period.
    refresh();
    start();
  };
  if (deps.isVisible()) start();
  deps.addVisibilityListener(onVisibility);
  return () => {
    stop();
    deps.removeVisibilityListener(onVisibility);
  };
}

/** The browser wiring. Separated so `startBandPolling` never mentions a
 *  global, and so this — the only untestable part in a node suite — is three
 *  lines with no decisions in them. */
export function browserBandPollDeps(): BandPollDeps {
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    addVisibilityListener: (fn) => document.addEventListener("visibilitychange", fn),
    removeVisibilityListener: (fn) => document.removeEventListener("visibilitychange", fn),
    isVisible: () => document.visibilityState === "visible",
  };
}
