import * as Sentry from "@sentry/nextjs";
import { scrubScoreTokens, scrubSentryEvent } from "@/lib/scrub-score-url";
import { sentryBeforeSendTransaction } from "@/lib/sentry-transactions";
import { stripDbEcho } from "@/lib/strip-db-echo";

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
  //
  // A database error's `detail` (the unique key, or the whole failing row), `where`, `hint` and postgres.js's statement fields
  // are stripped from everything sent too (lib/strip-db-echo.ts). Next's own `console.error(err)` leaves the whole error on the
  // event as a console breadcrumb, and a log attribute can hold one; the pino route is already clean at the logger.
  beforeSend: (event) => stripDbEcho(scrubSentryEvent(event)),
  beforeSendTransaction: sentryBeforeSendTransaction,

  beforeSendLog(log) {
    if (
      process.env.NODE_ENV === "production" &&
      (log.level === "debug" || log.level === "trace")
    ) {
      return null;
    }
    return stripDbEcho(scrubScoreTokens(log));
  },

  enabled: !!(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
});
