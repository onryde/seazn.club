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
    // (m2), and for a junk value. What that does on Fly (lane-close re-review M-1): the process does NOT exit — Next
    // caches the failed prepare(), so it stays up and answers 500 to EVERY request, /api/health included, until the
    // misconfiguration is fixed and it restarts. A deployment that would hand every club a fake "live" stream therefore
    // serves nothing at all rather than faking at its first stream. Sentry is initialised first, so the refusal is reported.
    const { relayDriverMode } = await import("@/server/relay/config");
    relayDriverMode();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
