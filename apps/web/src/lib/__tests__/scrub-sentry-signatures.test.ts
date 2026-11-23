// Task 27 review m1: a webhook's signature header (a vendor's MAC over the request body) never reaches Sentry in clear. The rule
// is "no key, signature or token in a log, error or record". @sentry/nextjs copies every request header onto the root span as
// `http.request.header.<name, - → _>`, and "signature" is not in the SDK's own deny list, so without the scrub each signed webhook
// delivery sent its signature to Sentry: Stripe's, Resend's (Svix), RealtimeKit's and Bunny Stream's.
//
// The four header names are typed here from the routes that read them (never read from the scrubber's own list). The SDK's own
// header-attribute helper builds the span data. Both config entry points are driven: `scrubSentryEvent` (beforeSend on the
// server, edge and client configs) and `sentryBeforeSendTransaction` (beforeSendTransaction on the server and edge configs).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Event } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADERS, scrubSentryEvent } from "../scrub-score-url";
import { sentryBeforeSendTransaction } from "../sentry-transactions";
import { requestHeaderSpanAttributes, transaction } from "./_sdk-span-data";

/** The headers the webhook routes verify, as each route reads it: Stripe's, Resend's (Svix), RealtimeKit's, Bunny Stream's, and
 *  Cloudflare Notifications' (Task 27b: the destination's secret, verbatim, in `cf-webhook-auth`). */
const ROUTE_SIGNATURE_HEADERS = ["stripe-signature", "svix-signature", "rtk-signature", "x-bunnystream-signature", "cf-webhook-auth"];
/** The one header above whose span attribute the SDK itself filters: "auth" is on its sensitive-key list, "signature" is not. */
const SDK_FILTERED = ["cf-webhook-auth"];
/** A signature's shape (hex HMAC-SHA256): no URL or token rule matches it, so only the header rule can hide it. */
const SIG = "9f4ae2968561d162ef7f70284efa6108d29130513d59e423f6b4ffadfa895d39";

type Hook = [string, (e: Event) => Event | null];
const HOOKS: Hook[] = [
  ["beforeSend (scrubSentryEvent)", (e) => scrubSentryEvent(e)],
  ["beforeSendTransaction (sentryBeforeSendTransaction)", (e) => sentryBeforeSendTransaction(e)],
];

function signedDelivery(headerName: string): Event {
  const headers = { [headerName]: SIG, "content-type": "application/json", "x-bunnystream-signature-version": "v1" };
  const attrs = requestHeaderSpanAttributes(headers, false);
  const event = transaction({
    name: "POST /api/webhooks/bunny-stream",
    traceData: { ...attrs, "http.route": "/api/webhooks/bunny-stream" },
    spans: [{ description: "POST /api/webhooks/bunny-stream", data: { ...attrs } }],
    request: { method: "POST", url: "https://seazn.club/api/webhooks/bunny-stream", headers },
  }) as Event;
  return { ...event, breadcrumbs: [{ category: "http", type: "http", level: "info", data: { ...attrs } }] };
}

describe("Sentry scrub: webhook signature headers (Task 27 review m1)", () => {
  it("EMPTY CASE FIRST: a delivery with no signature header is sent as it came — the non-secret signature version and algorithm headers kept", () => {
    const headers = { "content-type": "application/json", "x-bunnystream-signature-version": "v1", "x-bunnystream-signature-algorithm": "hmac-sha256" };
    const attrs = requestHeaderSpanAttributes(headers, false);
    const event = transaction({ name: "POST /api/webhooks/bunny-stream", traceData: { ...attrs }, spans: [{ description: "x", data: { ...attrs } }], request: { headers } }) as Event;
    let checked = 0;
    for (const [label, hook] of HOOKS) {
      const out = hook(event)!;
      expect(out.request?.headers, label).toEqual(headers);
      expect(out.contexts?.trace?.data, label).toEqual(attrs);
      expect(out.spans?.[0]?.data, label).toEqual(attrs);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("each route's signature header, either case, through both config hooks: redacted in the request headers, the root span's attribute, every span and every breadcrumb, which the SDK itself passes in clear (counts reported)", () => {
    let checked = 0;
    let sdkInClear = 0;
    for (const name of ROUTE_SIGNATURE_HEADERS) {
      for (const headerName of [name, name.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase())]) {
        const event = signedDelivery(headerName);
        const attrKey = Object.keys(event.contexts!.trace!.data!).find((k) => k.endsWith(name.replace(/-/g, "_")))!;
        expect(attrKey, `PREMISE: the SDK names ${headerName} among the span attributes`).toBeDefined();
        if (event.contexts!.trace!.data![attrKey] === SIG) sdkInClear++;
        for (const [label, hook] of HOOKS) {
          const out = hook(event)!;
          const where = `${headerName} via ${label}`;
          expect(JSON.stringify(out), where).not.toContain(SIG);
          expect(out.request?.headers?.[headerName], `${where}: the header stays, its value redacted`).toBe("[redacted]");
          expect(out.contexts?.trace?.data?.[attrKey], where).toBe("[redacted]");
          expect(out.spans?.[0]?.data?.[attrKey], where).toBe("[redacted]");
          expect(out.breadcrumbs?.[0]?.data?.[attrKey], where).toBe("[redacted]");
          expect(out.request?.headers?.["x-bunnystream-signature-version"], `${where}: not a secret, kept`).toBe("v1");
          checked++;
        }
      }
    }
    expect(checked, "5 headers x 2 cases x 2 hooks").toBe(20);
    expect(sdkInClear, "the SDK's deny list passes every signature header but cf-webhook-auth in clear: this test witnesses the scrub")
      .toBe((ROUTE_SIGNATURE_HEADERS.length - SDK_FILTERED.length) * 2);
  });

  it("the list is the routes' own: every `*-signature` or `*-auth` header a route reads is on it, and every name on it is read by a route (counts reported)", () => {
    const root = path.resolve(__dirname, "../../app/api");
    const reads = new Set<string>();
    let files = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
        } else if (e.name === "route.ts") {
          files++;
          for (const m of readFileSync(p, "utf8").matchAll(/headers\.get\(\s*["']([A-Za-z0-9-]*(?:signature|-auth))["']\s*\)/gi)) reads.add(m[1]!.toLowerCase());
        }
      }
    };
    walk(root);
    expect(files, "route files read").toBeGreaterThan(250);
    expect([...reads].sort(), "the signature headers the routes read").toEqual([...ROUTE_SIGNATURE_HEADERS].sort());
    expect([...SIGNATURE_HEADERS].sort(), "the scrubber's list").toEqual([...ROUTE_SIGNATURE_HEADERS].sort());
  });
});
