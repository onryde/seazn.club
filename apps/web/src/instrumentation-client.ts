// Client-side instrumentation (Next 16 file convention): runs after the HTML
// loads and before React hydration — the right place to boot analytics so
// early pageviews are captured. Kept lightweight per the Next docs (<16ms).
import posthog from "posthog-js";
import { analyticsConsented } from "@/lib/consent";
import { stopReplayBeforeNavigatingTo } from "@/lib/replay-guard";
import { maskCapturedNetworkRequest, posthogBeforeSend } from "@/lib/scrub-score-url";
import { captureRouterTransitionStart, scheduleBrowserSentry } from "@/lib/sentry-browser";

// The browser Sentry client (owner 2026-11-23): errors and warnings only, no session replay, no tracing, and only with the
// visitor's analytics consent. The SDK is NOT in the first-load JS: lib/sentry-browser.ts fetches it with a dynamic import()
// when the browser is idle, and only if NEXT_PUBLIC_SENTRY_DSN is set and the visitor has accepted (a later Accept in the
// banner loads it then: components/cookie-consent.tsx). Every client file reports through that facade, which queues calls
// until the SDK is up and drops them if it never comes. Under Turbopack this file is the client init path Next 16 and
// @sentry/nextjs support (the old webpack-only sentry.client.config.ts is deleted). The server/edge counterpart is
// ../instrumentation.ts, which runs sentry.server.config / sentry.edge.config.
scheduleBrowserSentry();

// Exported because without it @sentry/nextjs logs an ACTION REQUIRED at build (withSentryConfig reads this file for the name).
// It is a no-op until the SDK has loaded; with tracing at 0 its navigation span is unsampled. The client has no Replay
// integration, so the replay guard (lib/replay-guard) finds none to stop; it stays for the day a replay is turned on: it stops
// the replay before the app navigates to a page whose URL holds a credential. Sentry's own hook runs first, so the guard can
// never cost the navigation span.
export function onRouterTransitionStart(href: string, navigationType: "push" | "replace" | "traverse"): void {
  captureRouterTransitionStart(href, navigationType);
  stopReplayBeforeNavigatingTo(href);
}

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Staff impersonation swaps the session cookie wholesale (admin/impersonate),
// so the impersonator is indistinguishable from the target user. The
// impersonate route drops a readable `seazn_no_analytics` cookie; honor it by
// not booting PostHog at all, so impersonated sessions never pollute real data.
function analyticsSuppressed(): boolean {
  return document.cookie.split("; ").some((c) => c.startsWith("seazn_no_analytics="));
}

// GDPR: analytics is a non-essential third-party cookie, so it may only capture
// after explicit opt-in against the CURRENT policy version. analyticsConsented
// (lib/consent) reads the banner's localStorage keys; PostHog stays opted-out
// until it returns true (accepted AND version current — a policy bump revokes).

if (key && !analyticsSuppressed()) {
  try {
    posthog.init(key, {
      // First-party reverse proxy so ad-blockers don't drop events. Prod sets
      // NEXT_PUBLIC_POSTHOG_API_HOST to PostHog's managed proxy on our own
      // domain (Cloudflare), keeping event traffic off this Node process:
      // Next 16.3's rewrite proxy stacks 10 `close` listeners on every proxied
      // response. Unset (local, stg) falls back to the /ingest rewrite in
      // next.config. ui_host keeps in-app links on the real PostHog dashboard.
      api_host: process.env.NEXT_PUBLIC_POSTHOG_API_HOST || "/ingest",
      ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.posthog.com",
      // Only create person profiles for identified (logged-in) users; anonymous
      // marketing traffic still counts toward web analytics (feature 7) without
      // spending an event allowance on a profile. GDPR-friendlier too.
      person_profiles: "identified_only",
      // Feature 7 — web analytics: capture SPA route changes, not just first load.
      capture_pageview: "history_change",
      capture_pageleave: true,
      // No cookies set and nothing captured until the visitor opts in via the
      // banner. opt_in_capturing() (in cookie-consent) flips this on.
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      // Drops every event from a staff page (/admin, /admin/*), then scrubs
      // device-link tokens (/score/<token> is a live scoring credential) out
      // of every URL-valued property before anything leaves.
      before_send: posthogBeforeSend,
      // before_send never sees a replay's network entries (they ride the recorder's own frames): when the project records network
      // requests, each one's URL and headers go through the same scrubber first. A signed Cloudflare playback URL carries
      // its token as a path segment, and the match player's hls.js requests it from this page.
      // `recordBody: false`: supplying a custom mask makes posthog-js skip its own payload redaction (external/config.js: the
      // default `scrubPayloads` runs only when NO mask is given), and our scrubber knows token shapes, not `secret`/`password`
      // bodies (an API key's create response carries `{"secret":"sc_…"}`). Seazn has no use for recorded bodies, and the client
      // setting beats the project's remote one (`canRecordBody`), so no body is ever recorded.
      session_recording: { maskCapturedNetworkRequestFn: maskCapturedNetworkRequest, recordBody: false },
    });
    if (analyticsConsented()) posthog.opt_in_capturing();
  } catch {
    // Analytics must never break the app — swallow init failures.
  }
}
