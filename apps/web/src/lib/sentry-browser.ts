// The browser Sentry client's options (owner 2026-11-23: errors and warnings only, no session replay). src/instrumentation-client.ts
// is the ONE place that calls `Sentry.init` with them. Under Turbopack that file is the only client init path Next 16 and
// @sentry/nextjs support (@sentry/nextjs 10.62 config/webpack.js: "When using Turbopack `sentry.client.config.ts` will no
// longer work"); the old apps/web/sentry.client.config.ts was webpack-only, never bundled, and is deleted. Its privacy hooks
// live on here unchanged.
//
// - Errors and warnings only: no Replay integration and both replay rates 0; `tracesSampleRate: 0`. The nextjs client adds
//   its browserTracingIntegration by default, and `captureRouterTransitionStart` (the router hook) drives it, so a 0 rate
//   keeps that hook working while every span stays unsampled and no transaction is sent. console.warn / console.error go as
//   structured logs.
// - Consent: the privacy policy (/legal/privacy) and the sub-processors list name no lawful basis for Sentry, and the policy
//   lists product analytics as the consent-based processing. So, like PostHog (instrumentation-client.ts), Sentry is booted
//   but sends NOTHING until the visitor has accepted analytics against the current policy version. The check is made at
//   every send (`consentGatedTransport`), so the banner's Accept and a withdrawal act at once and a policy bump revokes,
//   with no re-init. The transport is the one door every envelope goes through (errors, logs, sessions, client reports),
//   which no `beforeSend` is. Lifting the gate is a policy decision first: name Sentry (error monitoring, legitimate
//   interests) in the policy and the sub-processors list, then send `transport` back to the SDK default.
import * as Sentry from "@sentry/nextjs";
import { analyticsConsented } from "@/lib/consent";
import { scrubScoreTokens, scrubScoreTokensIntegration, scrubSentryEvent } from "@/lib/scrub-score-url";

type BrowserOptions = Sentry.BrowserOptions;
type TransportOptions = Parameters<typeof Sentry.makeFetchTransport>[0];
type Transport = ReturnType<typeof Sentry.makeFetchTransport>;

/** The SDK's own fetch transport, sending only while `analyticsConsented()` holds at the moment of the send. A held-back
 *  envelope resolves as sent: no retry, no offline queue, nothing kept. */
export function consentGatedTransport(options: TransportOptions): Transport {
  const transport = Sentry.makeFetchTransport(options);
  return {
    ...transport,
    send: (envelope) => (analyticsConsented() ? transport.send(envelope) : Promise.resolve({})),
  };
}

/** The options instrumentation-client.ts hands `Sentry.init` when NEXT_PUBLIC_SENTRY_DSN is set. */
export function browserSentryOptions(dsn: string): BrowserOptions {
  return {
    dsn,
    environment: process.env.NODE_ENV,

    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    enableLogs: true,

    integrations: [
      // Forward console.warn/error as structured Sentry logs
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
      // A replay_event's URL list (and any event a processor sees) skips beforeSend; only a processor reaches it.
      scrubScoreTokensIntegration(),
    ],

    transport: consentGatedTransport,

    // A device link's URL (/score/<token>) is a live scoring credential, and lib/scrub-score-url knows every other one: scrub
    // them from errors, transactions, breadcrumbs and logs before anything is sent.
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubScoreTokens,

    beforeSendLog(log) {
      // Debug/trace are dev-only noise; keep prod log volume down
      if (process.env.NODE_ENV === "production" && (log.level === "debug" || log.level === "trace")) return null;
      return scrubScoreTokens(log);
    },
  };
}
