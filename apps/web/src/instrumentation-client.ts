// Client-side instrumentation (Next 16 file convention): runs after the HTML
// loads and before React hydration — the right place to boot analytics so
// early pageviews are captured. Kept lightweight per the Next docs (<16ms).
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { analyticsConsented } from "@/lib/consent";
import { stopReplayBeforeNavigatingTo } from "@/lib/replay-guard";
import { posthogBeforeSend } from "@/lib/scrub-score-url";

// Sentry.init is NOT called on the client today. The client options live in ../sentry.client.config.ts, but @sentry/nextjs
// only picks that file up in its WEBPACK integration (config/webpack.js, getClientSentryConfigFile); this app builds with
// Turbopack, so the file is never bundled (a prod build holds none of its options). Wiring the client init is an owner
// decision still pending, and not part of this file. Until then the router hook below has no client to report to and the
// replay guard finds no Replay integration to stop, so both are no-ops, in place for the day the init is wired. The
// server/edge counterpart is NOT auto-loaded past @sentry/nextjs v9 either: ../instrumentation.ts is what runs
// sentry.server.config / sentry.edge.config. The hook is exported because without it Sentry logs an ACTION REQUIRED at
// build.
// The replay is stopped before the app navigates to a page whose URL holds a credential (lib/replay-guard). Sentry's own
// hook runs first, so the guard can never cost the navigation span.
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
