import * as Sentry from "@sentry/nextjs";
import { scrubScoreTokens, scrubSentryEvent } from "@/lib/scrub-score-url";
import { sentryBeforeSendTransaction } from "@/lib/sentry-transactions";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  enableLogs: true,
  // Device-link tokens (/score/<token>, Bearer dl_…) out of every event and log.
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: sentryBeforeSendTransaction,
  beforeSendLog: scrubScoreTokens,
  enabled: !!(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
});
