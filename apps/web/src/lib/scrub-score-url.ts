// Device-link tokens stay out of telemetry (scorer sheets final review, I2).
//
// A device link's secret IS its URL: `/score/<token>`. The pad also sends the
// same token as `Authorization: Bearer dl_…` on every scoring call. Since
// scorer sheets, a token lives until its match is over and is printed on
// paper. Any telemetry that records a URL (a pageview, an error's request, a
// breadcrumb, a replay's URL list) would send a working scoring credential to
// a third party. Every helper here swaps the token for a fixed placeholder and
// leaves the rest of the value as it was.
import type * as Sentry from "@sentry/nextjs";
import type { CaptureResult } from "posthog-js";

// @sentry/nextjs re-exports `Event` but not `Integration` (that lives in
// @sentry/core, which is not a dependency here), so take it from a signature.
type Event = Sentry.Event;
type Integration = Parameters<typeof Sentry.addIntegration>[0];

/** `/score/` plus the token: everything up to the next `/`, `?`, `#`, quote, angle bracket or space. */
const SCORE_PATH = /\/score\/[^/?#\s"'<>]+/g;
/** A bare secret, e.g. in an `Authorization` header. `mintDeviceLinkSecret` makes `dl_` + 43 base64url chars. */
const BARE_TOKEN = /\bdl_[A-Za-z0-9_-]{32,}/g;

/** One string: `/score/<token>` becomes `/score/[token]`, and a bare `dl_…` secret becomes `dl_[token]`. */
export function scrubScoreUrl(value: string): string {
  if (!value.includes("/score/") && !value.includes("dl_")) return value;
  return value.replace(SCORE_PATH, "/score/[token]").replace(BARE_TOKEN, "dl_[token]");
}

/**
 * Scrub every string inside a JSON-like value: plain objects and arrays, at any
 * depth. Anything else (a Date, a class instance) is returned as it was. The
 * input is never mutated. A branch with nothing to scrub keeps its original
 * reference, so a clean event costs a walk and no copies.
 */
export function scrubScoreTokens<T>(value: T): T {
  return deep(value, new WeakMap()) as T;
}

function deep(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return scrubScoreUrl(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    seen.set(value, value);
    let copy: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = deep(item, seen);
      if (!Object.is(next, item)) (copy ??= value.slice())[i] = next;
    });
    const out = copy ?? value;
    seen.set(value, out);
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  seen.set(value, value);
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = deep(item, seen);
    if (!Object.is(next, item)) (copy ??= { ...value })[key] = next;
  }
  const out = copy ?? value;
  seen.set(value, out);
  return out;
}

/**
 * PostHog `before_send`. It runs in `capture()` on every event: pageview,
 * pageleave, autocapture (`$elements` hrefs, `$external_click_url`) and
 * `$snapshot`. It scrubs the properties plus `$set` / `$set_once`, where the
 * `$initial_*` URLs live. A dropped event (null) stays dropped.
 */
export function posthogBeforeSend(event: CaptureResult | null): CaptureResult | null {
  return event === null ? null : scrubScoreTokens(event);
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction`: scrubs the request URL and
 * headers (the Bearer secret), the transaction name, breadcrumbs, tags, stack
 * frames and span data.
 */
export function scrubSentryEvent<E extends Event>(event: E): E {
  return scrubScoreTokens(event);
}

/**
 * The same scrub as an event processor. A Replay's `replay_event` carries the
 * page URLs it visited (`urls`). It goes through the client's event processors
 * (`prepareReplayEvent` calls core `prepareEvent`) but never through
 * `beforeSend`, so only a processor can reach it.
 */
export function scrubScoreTokensIntegration(): Integration {
  return { name: "ScrubScoreTokens", processEvent: (event) => scrubSentryEvent(event) };
}

/**
 * Sentry Replay `beforeAddRecordingEvent`. The SDK passes only CUSTOM frames to
 * it: breadcrumbs (navigation from/to, console) and performance spans (fetch
 * and navigation URLs). @sentry/replay 10.62 gates it with `isCustomEvent`.
 * rrweb's own meta frame (`href`) and DOM snapshots never reach this hook.
 */
export function scrubRecordingEvent<T>(event: T): T {
  return scrubScoreTokens(event);
}
