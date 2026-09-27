import * as Sentry from "@sentry/nextjs";
import { scrubScoreTokens, scrubSentryEvent } from "@/lib/scrub-score-url";
import { sentryBeforeSendTransaction } from "@/lib/sentry-transactions";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  enableLogs: true,

  // Repo already uses pino server-side — forward its logs to Sentry
  // instead of duplicating call sites with Sentry.logger.*
  integrations: [Sentry.pinoIntegration()],

  // A device link's token is a live scoring credential. It arrives in the
  // request path (/score/<token>) and as `Authorization: Bearer dl_…` on every
  // pad call, and both end up in a server event's request data and span
  // attributes. Scrub it from everything sent.
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: sentryBeforeSendTransaction,

  beforeSendLog(log) {
    if (
      process.env.NODE_ENV === "production" &&
      (log.level === "debug" || log.level === "trace")
    ) {
      return null;
    }
    return scrubScoreTokens(log);
  },

  enabled: !!(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
});
