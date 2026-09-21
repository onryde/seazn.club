import * as Sentry from "@sentry/nextjs";

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
    }),
    // Forward console.warn/error as structured Sentry logs
    Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
  ],

  beforeSendLog(log) {
    // Debug/trace are dev-only noise; keep prod log volume down
    if (
      process.env.NODE_ENV === "production" &&
      (log.level === "debug" || log.level === "trace")
    ) {
      return null;
    }
    return log;
  },

  // Don't send events when DSN is absent (local dev without Sentry)
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});
