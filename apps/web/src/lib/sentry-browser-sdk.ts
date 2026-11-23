// The browser Sentry SDK, LAZY: the one client module that imports @sentry/nextjs at runtime. Nothing imports it statically;
// ./sentry-browser.ts (the facade every client file reports through) fetches it with a dynamic import() once the visitor has
// accepted analytics, when the browser is idle. So it and the SDK are in no first-load chunk.
//
// The imports are NAMED on purpose: a dynamic import() of "@sentry/nextjs" itself hands the page the whole namespace, which
// the bundler cannot tree-shake, so that chunk carried Replay and rrweb (measured 2026-11-23: 186 KB gz, `checkoutEveryNms`
// and `rr-block` in it). Through this module only what is named here, and what `init` pulls, ships.
//
// - Errors and warnings only: no Replay integration and both replay rates 0; `tracesSampleRate: 0`. The nextjs client adds
//   its browserTracingIntegration by default and the router hook drives it, so a 0 rate keeps that hook working while every
//   span stays unsampled and no transaction is sent. console.warn / console.error go as structured logs.
// - Consent: the privacy policy (/legal/privacy) and the sub-processors list name no lawful basis for Sentry, and the policy
//   lists product analytics as the consent-based processing. So, like PostHog, Sentry runs only with the visitor's analytics
//   consent: this module is not even fetched without it (./sentry-browser.ts), and once it is, `consentGatedTransport`
//   re-checks at every send, so a withdrawal mid-session stops sending at once and a policy bump revokes. The transport is the
//   one door every envelope goes through (errors, logs, sessions, client reports), which no `beforeSend` is.
//   Lifting the gate is a policy decision first: name Sentry (error monitoring, legitimate interests) in the policy and the
//   sub-processors list.
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  captureRouterTransitionStart,
  consoleLoggingIntegration,
  getClient,
  init,
  makeFetchTransport,
  type BrowserOptions,
} from "@sentry/nextjs";
import { analyticsConsented } from "@/lib/consent";
import { scrubScoreTokens, scrubScoreTokensIntegration, scrubSentryEvent } from "@/lib/scrub-score-url";

/** What the facade forwards to once this module has loaded. */
export { addBreadcrumb, captureException, captureMessage, captureRouterTransitionStart, getClient };

type TransportOptions = Parameters<typeof makeFetchTransport>[0];
type Transport = ReturnType<typeof makeFetchTransport>;

/** The SDK's own fetch transport, sending only while `analyticsConsented()` holds at the moment of the send. A held-back
 *  envelope resolves as sent: no retry, no offline queue, nothing kept. */
export function consentGatedTransport(options: TransportOptions): Transport {
  const transport = makeFetchTransport(options);
  return {
    ...transport,
    send: (envelope) => (analyticsConsented() ? transport.send(envelope) : Promise.resolve({})),
  };
}

/** The browser client's options. */
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
      consoleLoggingIntegration({ levels: ["warn", "error"] }),
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

/** The browser's one Sentry init, called by ./sentry-browser.ts `loadBrowserSentry` once this module has loaded. */
export function startBrowserSentry(dsn: string): void {
  init(browserSentryOptions(dsn));
}
