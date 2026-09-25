import * as Sentry from "@sentry/nextjs";
import {
  scrubRecordingEvent,
  scrubScoreTokens,
  scrubScoreTokensIntegration,
  scrubSentryEvent,
} from "@/lib/scrub-score-url";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // Capture 10% of traces in production; 100% in dev
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Replay: 1% of sessions, 10% of sessions with errors
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 0.1,

  enableLogs: true,

  integrations: [
    Sentry.replayIntegration({
      // Mask all inputs/text for privacy; block all media
      maskAllText: true,
      blockAllMedia: true,
      // Custom frames only (breadcrumbs, performance spans): the SDK passes
      // nothing else to this hook. See lib/scrub-score-url.
      beforeAddRecordingEvent: scrubRecordingEvent,
    }),
    // Forward console.warn/error as structured Sentry logs
    Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
    // A replay_event's URL list skips beforeSend; only a processor reaches it.
    scrubScoreTokensIntegration(),
  ],

  // A device link's URL (/score/<token>) is a live scoring credential: scrub it
  // from errors, transactions, breadcrumbs and logs before anything is sent.
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubScoreTokens,

  beforeSendLog(log) {
    // Debug/trace are dev-only noise; keep prod log volume down
    if (
      process.env.NODE_ENV === "production" &&
      (log.level === "debug" || log.level === "trace")
    ) {
      return null;
    }
    return scrubScoreTokens(log);
  },

  // Don't send events when DSN is absent (local dev without Sentry)
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});
