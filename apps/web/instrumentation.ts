import * as Sentry from "@sentry/nextjs";

// @sentry/nextjs v9+ stopped auto-loading sentry.server.config.ts /
// sentry.edge.config.ts — this hook is now the only thing that runs them.
// Without it Sentry.init() never executes server-side, so every
// Sentry.captureException in lib/http.ts silently no-ops (confirmed: zero
// issues in either Sentry project across 90 days before this file existed).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Next logs an uncaught error with a bare `console.error(err)`, and the app prints `console.error("...", err)` in a dozen places;
    // util.inspect writes every enumerable field of a database error, Postgres' `detail` (the unique key, or the whole failing row)
    // among them. Installed after Sentry's init so this wraps Sentry's console breadcrumb hook, which then sees the scrubbed
    // arguments too. The same strip the logger and Sentry apply (lib/strip-db-echo.ts); see server/console-db-echo-scrub.ts.
    const { installConsoleDbEchoScrub } = await import("@/server/console-db-echo-scrub");
    installConsoleDbEchoScrub();
    // R5 (Task 14b): resolve the relay's driver mode BEFORE the server takes a request. It throws for an explicit
    // RELAY_DRIVERS=fake on a named deployment (ENV_NAME stg/prod), on a production server with no ENV_NAME at all
    // (m2), and for a junk value. What that does on Fly (lane-close re-review M-1): the process does NOT exit — Next
    // caches the failed prepare(), so it stays up and answers 500 to EVERY request, /api/health included, until the
    // misconfiguration is fixed and it restarts. A deployment that would hand every club a fake "live" stream therefore
    // serves nothing at all rather than faking at its first stream. Sentry is initialised first, so the refusal is reported.
    const { relayDriverMode } = await import("@/server/relay/config");
    relayDriverMode();
    // The per-sport engine-epoch floor override (engine-split spec §5.6): the emergency lever that lowers the scoring door's 426
    // floor. Parsed here ONCE before the server takes a request. A valid value logs one loud warning per sport (and a Sentry
    // alert for each ACTIVE one); an INERT one (at or above the sport's epoch) logs that it does nothing, so a stale entry left
    // behind by a later bump cannot take prod down. Unset logs nothing. A value that is NOT understood is the opposite of the relay
    // check above and deliberately does NOT throw: a rejected register() is cached by Next, which then answers 500 to every
    // request including /api/health (measured on a real standalone server), so a typo in an emergency lever would be a site
    // outage and a red Fly health check. It is logged as an error, sent to Sentry (flushed) and the lever stays OFF: the gate
    // reads the same value through `epochFloorOverrideOrOff`, which serves the declared floors.
    const { reportEpochFloorOverrides, reportInvalidEpochFloorOverride, epochFloorOverrideActiveMessage, epochFloorOverrideSentryLevel } = await import(
      "@/server/usecases/engine-epoch-override"
    );
    let overrides: ReturnType<typeof reportEpochFloorOverrides> = { active: [], inert: [] };
    try {
      overrides = reportEpochFloorOverrides();
    } catch (e) {
      await reportInvalidEpochFloorOverride(e);
    }
    // Each ACTIVE sport also goes to Sentry, as the outbox check below does for its problem: a pino line alone never becomes an
    // Issue. A warning for one major behind, an error for more than one. INERT and the per-request OVERRIDDEN lines never become an
    // Issue (pino lines still reach Sentry Logs through the pino integration).
    for (const active of overrides.active) Sentry.captureMessage(epochFloorOverrideActiveMessage(active), epochFloorOverrideSentryLevel(active));
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
