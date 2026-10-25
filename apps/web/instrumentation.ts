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
    // The per-sport engine-epoch floor override (engine-split spec §5.6): the emergency lever that lowers the scoring door's 426
    // floor. Parsed here ONCE before the server takes a request, and a value that is not understood THROWS exactly as above (the
    // process stays up and answers 500 until it is fixed), so a typo never silently becomes "no override" or a wrong floor. A valid
    // one logs one loud warning per sport; an INERT one (at or above the sport's epoch) logs that it does nothing and does not stop
    // the boot, so a stale entry left behind by a later bump cannot take prod down. Unset logs nothing.
    const { reportEpochFloorOverrides, epochFloorOverrideActiveMessage } = await import("@/server/usecases/engine-epoch-override");
    let overrides: ReturnType<typeof reportEpochFloorOverrides>;
    try {
      overrides = reportEpochFloorOverrides();
    } catch (e) {
      // The throw below ends the boot, and a process that is about to answer 500 to everything may never flush: report it first.
      Sentry.captureException(e);
      await Sentry.flush(2000);
      throw e;
    }
    // Each ACTIVE sport also goes to Sentry as a warning, as the outbox check below does for its problem: a pino line alone never
    // becomes an Issue. INERT and the per-write OVERRIDDEN lines stay log-only (the quota).
    for (const active of overrides.active) Sentry.captureMessage(epochFloorOverrideActiveMessage(active), "warning");
    // The email outbox seals every queued body under EMAIL_OUTBOX_KEK, and a sign-in request that cannot be queued answers
    // 500. A deployment with a Resend key and no (or the published sample) key would find out from the first person who tried
    // to sign in, so say it now: one error line, and an alert. Unlike the relay check this does not stop the boot.
    const { reportOutboxReadiness, outboxReadinessMessage } = await import("@/server/email-outbox/readiness");
    const outboxProblem = reportOutboxReadiness();
    if (outboxProblem) Sentry.captureMessage(outboxReadinessMessage(outboxProblem), "error");
    // A public page's 404 or 5xx must never be stored by a CDN or a browser (owner ruling 2026-10-14). Next sends an
    // ISR route's 404 with the found page's `s-maxage`, and nothing short of the response itself can see the status;
    // see the module for why, and what it leaves to Next's own cache.
    const http = await import("node:http");
    const { installPublicErrorNoStore } = await import("@/server/public-site/error-no-store");
    installPublicErrorNoStore(http.ServerResponse.prototype);
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
