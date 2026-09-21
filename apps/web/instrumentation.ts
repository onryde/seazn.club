import * as Sentry from "@sentry/nextjs";

// @sentry/nextjs v9+ stopped auto-loading sentry.server.config.ts /
// sentry.edge.config.ts — this hook is now the only thing that runs them.
// Without it Sentry.init() never executes server-side, so every
// Sentry.captureException in lib/http.ts silently no-ops (confirmed: zero
// issues in either Sentry project across 90 days before this file existed).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
