import * as Sentry from "@sentry/nextjs";

// @sentry/nextjs v9+ stopped auto-loading sentry.server.config.ts /
// sentry.edge.config.ts — this hook is now the only thing that runs them.
// Without it Sentry.init() never executes server-side, so every
// Sentry.captureException in lib/http.ts silently no-ops (confirmed: zero
// issues in either Sentry project across 90 days before this file existed).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // R5 (Task 14b): resolve the relay's driver mode BEFORE the server takes a request. It throws for an explicit
    // RELAY_DRIVERS=fake on a named deployment (ENV_NAME stg/prod), on a production server with no ENV_NAME at all
    // (m2), and for a junk value, so a deployment that would hand
    // every club a fake "live" stream refuses to start instead of failing — or faking — at its first stream. Sentry is
    // initialised first, so the refusal is reported.
    const { relayDriverMode } = await import("@/server/relay/config");
    relayDriverMode();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
