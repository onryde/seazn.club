// The browser's one door to Sentry (owner 2026-11-23: errors and warnings only, no session replay). Every client file reports
// through THIS module, never through @sentry/nextjs: the SDK is not in the first-load JS. Nothing here imports it at runtime
// (`import type` only). ./sentry-browser-sdk.ts, the one module that does, is fetched with a dynamic `import()` once the
// visitor has accepted analytics, when the browser is idle: at boot by instrumentation-client.ts, or on the banner's Accept
// (components/cookie-consent.tsx). The options, the privacy hooks and the send-time consent gate are there.
//
// Until the SDK has loaded, a call is
//  - QUEUED while a load is pending (consent given, a DSN set), up to SENTRY_QUEUE_CAP, then flushed in order on load;
//  - DROPPED otherwise: no consent, no DSN, the queue full, or a load that failed (a failed load is not retried).
// Under Turbopack, instrumentation-client.ts is the client init path Next 16 and @sentry/nextjs support (@sentry/nextjs 10.62
// config/webpack.js: "When using Turbopack `sentry.client.config.ts` will no longer work"); that file is deleted.
import type * as LazySdk from "@/lib/sentry-browser-sdk";
import { analyticsConsented } from "@/lib/consent";

type Sdk = typeof LazySdk;
type State = "off" | "pending" | "ready" | "failed";

/** Calls held while the SDK loads; past this many they are dropped (a page that errors in a loop must not grow it). */
export const SENTRY_QUEUE_CAP = 20;

let state: State = "off";
let sdk: Sdk | undefined;
let loading: Promise<boolean> | undefined;
const queue: ((s: Sdk) => void)[] = [];

function forward(call: (s: Sdk) => void): void {
  if (sdk) {
    try {
      call(sdk);
    } catch {
      // Reporting never breaks the caller.
    }
    return;
  }
  // Queued only under consent: a report made after a Reject, before the SDK loads, must not be flushed by a later Accept.
  if (state === "pending" && queue.length < SENTRY_QUEUE_CAP && analyticsConsented()) queue.push(call);
}

export function captureException(...args: Parameters<Sdk["captureException"]>): void {
  forward((s) => void s.captureException(...args));
}

export function captureMessage(...args: Parameters<Sdk["captureMessage"]>): void {
  forward((s) => void s.captureMessage(...args));
}

export function addBreadcrumb(...args: Parameters<Sdk["addBreadcrumb"]>): void {
  forward((s) => s.addBreadcrumb(...args));
}

/** The router hook's half (instrumentation-client.ts `onRouterTransitionStart`). Never queued: a navigation span means
 *  something only when the navigation starts. The client installs no tracing integration, so the SDK does nothing with it. */
export function captureRouterTransitionStart(...args: Parameters<Sdk["captureRouterTransitionStart"]>): void {
  if (sdk) forward((s) => s.captureRouterTransitionStart(...args));
}

/** The banner's Reject (components/cookie-consent.tsx): forget what was collected under the consent just withdrawn. Once the
 *  SDK has loaded, that is the breadcrumbs the client holds; before, it is the queue, whose reports and breadcrumbs a later
 *  Accept would otherwise flush (review m8). */
export function clearBreadcrumbs(): void {
  if (!sdk) queue.length = 0;
  if (sdk) forward((s) => s.clearBreadcrumbs());
}

/** The initialised client once the SDK has loaded, else undefined (lib/replay-guard looks a Replay integration up on it). */
export function sentryClient(): ReturnType<Sdk["getClient"]> {
  return sdk?.getClient();
}

/**
 * Fetch the SDK and init it now, if NEXT_PUBLIC_SENTRY_DSN is set and the visitor has consented. Idempotent: a second call
 * returns the first one's promise. Resolves true once the client is up, false when it may not load or the load failed.
 */
export function loadBrowserSentry(): Promise<boolean> {
  if (loading) return loading;
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn || !analyticsConsented()) {
    // Consent withdrawn (or never there) between the schedule and the idle callback: nothing waits for a load.
    if (state === "pending") state = "off";
    queue.length = 0;
    return Promise.resolve(false);
  }
  state = "pending";
  loading = import("@/lib/sentry-browser-sdk")
    .then((mod) => {
      mod.startBrowserSentry(dsn);
      sdk = mod;
      state = "ready";
      for (const call of queue.splice(0)) forward(call);
      return true;
    })
    .catch(() => {
      state = "failed";
      queue.length = 0;
      return false;
    });
  return loading;
}

/** Load when the browser is idle (requestIdleCallback, else a timeout), if it may load at all; calls from now on queue. */
export function scheduleBrowserSentry(): void {
  if (state !== "off" || !process.env.NEXT_PUBLIC_SENTRY_DSN || !analyticsConsented()) return;
  state = "pending";
  const run = () => void loadBrowserSentry();
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5_000 });
  else setTimeout(run, 1);
}
