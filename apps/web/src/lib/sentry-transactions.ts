// Fly's health check (fly.toml [[http_service.checks]]) GETs /api/health every
// 30s on every machine. Sampled, each one becomes a Sentry transaction — the
// proxy's "GET middleware GET" with `request.url` …/api/health — that says
// nothing and spends trace quota. Those are dropped here. Only transactions:
// an error on the route still goes out through `beforeSend`.
import type * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/scrub-score-url";

const HEALTH_PATH = "/api/health";

function pathOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** True for a transaction recording a request to /api/health (by request URL, or a route transaction's name). */
export function isHealthCheckTransaction(event: Sentry.Event): boolean {
  const path = pathOf(event.request?.url);
  return path === HEALTH_PATH || path === `${HEALTH_PATH}/` || event.transaction === `GET ${HEALTH_PATH}`;
}

/** `beforeSendTransaction` for the server and edge SDKs: drop health checks, scrub the rest. */
export function sentryBeforeSendTransaction<E extends Sentry.Event>(event: E): E | null {
  return isHealthCheckTransaction(event) ? null : scrubSentryEvent(event);
}
