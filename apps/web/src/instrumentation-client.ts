// Client-side instrumentation (Next 16 file convention): runs after the HTML
// loads and before React hydration — the right place to boot analytics and
// error reporting so early pageviews and early errors are captured. Kept
// lightweight per the Next docs (<16ms).
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { analyticsConsented } from "@/lib/consent";
import { stopReplayBeforeNavigatingTo } from "@/lib/replay-guard";
import { sentryEnvironment } from "@/lib/sentry-environment";
import {
  posthogBeforeSend,
  scrubScoreTokens,
  scrubScoreTokensIntegration,
  scrubSentryEvent,
} from "@/lib/scrub-score-url";

// Browser Sentry is initialised HERE. @sentry/nextjs picks up a `sentry.client.config.ts` only in its WEBPACK integration
// (config/webpack.js, getClientSentryConfigFile); `next build` here is Turbopack, which never bundled that file, so until
// this init moved in no browser error or scrub hook ever ran. The server/edge counterparts are not auto-loaded either:
// ../instrumentation.ts is what runs sentry.server.config / sentry.edge.config.
//
// ERRORS ONLY (owner rulings 2026-10-19), on the client alone: no tracing (no tracesSampleRate, so no transaction or span is
// ever built), no log capture (no enableLogs, no console-to-logs forwarder, no beforeSendLog), and SESSION REPLAY IS OFF (no
// replayIntegration, neither replays*SampleRate). Importing `replayIntegration` (or `getReplay`) here would pull @sentry/replay
// and rrweb (~23 KB gzipped) into the first-load chunk of every page, so nothing in this file may; scripts/check-client-sentry.ts
// fails a build whose chunks hold rrweb or the console-to-logs forwarder. lib/replay-guard.ts is the guard that must go with a
// replay, and it stays in place, inert: with no Replay integration the router hook below finds nothing to stop. Turning a replay
// back on is a decision that needs that guard wired (replayMayRunAt, REPLAY_BLOCK_SELECTORS, recordingEventHook; see its header),
// not just an integration added.
//
// The SDK's own default integrations that serve something other than an error are taken out (by name, below). That is runtime
// only: @sentry/nextjs's client imports its BrowserTracing integration unconditionally, so the code stays in the bundle (the only
// switch that removes it, `__SENTRY_TRACING__=false` via compiler.define, is global in Next and would turn the server's tracing off
// too).
//
// A device link's URL (/score/<token>) is a live scoring credential, as are the other one-time links lib/scrub-score-url knows:
// every hook below scrubs them from errors and breadcrumbs before anything leaves. Sentry reports nothing without a DSN
// (`enabled`), so a build with no NEXT_PUBLIC_SENTRY_DSN (local, CI) sends nothing.
const NOT_FOR_ERRORS = new Set([
  "BrowserTracing", // page-load and navigation spans, web-vitals observers, fetch/XHR timing: tracing is off
  "BrowserSession", // a session envelope per page load (release health): not an error
  "ConversationId", // an AI-chat id for LLM monitoring: none here
]);

try {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // stg vs prod: NODE_ENV is "production" for both, so the baked origin tells them apart (lib/sentry-environment).
    environment: sentryEnvironment(process.env.NEXT_PUBLIC_BASE_URL, process.env.NODE_ENV),

    // The SDK's defaults minus what is not for errors, plus the processor an event that skips beforeSend still goes through.
    integrations: (defaults) => [...defaults.filter((integration) => !NOT_FOR_ERRORS.has(integration.name)), scrubScoreTokensIntegration()],

    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubScoreTokens,

    // Don't send events when DSN is absent (local dev without Sentry)
    enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
} catch {
  // Error reporting must never break the app — swallow init failures.
}

// The replay (if there is one) is stopped before the app navigates to a page whose URL holds a credential (lib/replay-guard).
// Sentry's own hook runs first, so the guard can never cost the navigation span. The hook is exported because without it
// Sentry logs an ACTION REQUIRED at build.
export const onRouterTransitionStart: typeof Sentry.captureRouterTransitionStart = (href, navigationType) => {
  Sentry.captureRouterTransitionStart(href, navigationType);
  stopReplayBeforeNavigatingTo(href);
};

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
    });
    if (analyticsConsented()) posthog.opt_in_capturing();
  } catch {
    // Analytics must never break the app — swallow init failures.
  }
}
