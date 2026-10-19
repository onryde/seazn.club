// A sampled Sentry TRANSACTION carries the request's bare query string in its span data, beside a URL that has no query.
//
// scrubSentryEvent cleaned `request.query_string` and every string that names a route, but the SDK also writes the query on
// its own, WITH its `?`, where no route name sits in the same string:
//  - `http.query` in the transaction's `contexts.trace.data` (@sentry/opentelemetry `getRequestSpanData`, which sets a
//    SANITISED `url` with no query beside it);
//  - `url.query` in a span's data (@sentry/core `getHttpSpanDetailsFromUrlObject`, which also sets `url.full`, `url.path`,
//    `http.route`);
//  - `http.query` in an outgoing request's breadcrumb data.
// So `?token=<one-time sign-in token>&next=…` left the app in the clear on a route whose URL, transaction and query_string
// were all clean. This file builds every event from the SDK's own helpers (_sdk-span-data.ts), not from a hand-made shape,
// with real tokens from the real minters over the fake sql tag, and asserts:
//  - for each one-time-token route (the links the app emails: `linkBuilders()`, minus the reusable cart token), whether the
//    ROUTE is named by the transaction, by the trace data's own url, or only by a child span's sibling url, the token is
//    nowhere in the event and the other parameters of the query survive;
//  - the positive pair: a reusable cart token, an ordinary route and a one-time route with no token keep their query;
//  - the body: a serialised request body in a span's data (`http.request.body.data`) goes with the route's body;
//  - each key that NAMES a span's request (`SPAN_URL_KEYS`) pins the span to its route on its own: the sibling query and body
//    of a span that only that one key identifies are scrubbed, so dropping any single key from the list goes red.
//
// Sport: not applicable — account credentials are sport-agnostic.
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Event } from "@sentry/nextjs";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));

import { USER_ID } from "./_fake-sql";
import { NOT_ONE_TIME, linkBuilders } from "./_route-scan";
import { clientSpanDetails, otelTraceData, outgoingBreadcrumb, outgoingRequestSpanData, serverSpanDetails, transaction, type SpanData } from "./_sdk-span-data";
import { createInvite } from "@/server/usecases/invites";
import { createLoginLink } from "@/lib/login-link";
import { createVerificationToken } from "@/lib/verification";
import { SPAN_URL_KEYS, scrubSentryEvent } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const oneTimeRoutes = [...linkBuilders().keys()].filter((r) => !(r in NOT_ONE_TIME)).sort();
const tokens = [await createLoginLink(USER_ID), await createVerificationToken(USER_ID)];
const NEXT = "next=%2Fdashboard%3Ffrom%3Dmail";

const json = (v: unknown) => JSON.stringify(v);
const asEvent = (e: Record<string, unknown>) => e as unknown as Event;
type Trace = { contexts: { trace: { data: SpanData } }; spans: { data: SpanData; description: string }[]; breadcrumbs?: { data: SpanData }[]; transaction: string };
const out = (e: Record<string, unknown>) => scrubSentryEvent(asEvent(structuredClone(e))) as unknown as Trace;

describe("the premise: the SDK's own helpers write the bare query, with its ?, where no route name sits beside it", () => {
  const url = `${ORIGIN}/magic-link?token=${tokens[0]!}&${NEXT}#top`;
  it("getRequestSpanData: a sanitised url and http.query", () => {
    const data = otelTraceData(url);
    expect(data.url).toBe(`${ORIGIN}/magic-link`);
    expect(data["http.query"]).toBe(`?token=${tokens[0]!}&${NEXT}`);
  });
  it("getHttpSpanDetailsFromUrlObject: url.query beside url.full, url.path and (server) http.route", () => {
    const { data } = serverSpanDetails(url, "/magic-link");
    expect(data["url.query"]).toBe(`?token=${tokens[0]!}&${NEXT}`);
    expect(data["url.path"]).toBe("/magic-link");
    expect(data["http.route"]).toBe("/magic-link");
    expect(clientSpanDetails(url).data["url.query"]).toBe(`?token=${tokens[0]!}&${NEXT}`);
  });
  it("the outgoing-request breadcrumb: a sanitised url and http.query", () => {
    const { data } = outgoingBreadcrumb(url);
    expect(data.url).toBe(`${ORIGIN}/magic-link`);
    expect(data["http.query"]).toBe(`?token=${tokens[0]!}&${NEXT}`);
  });
  it("the one-time routes come from the app's link builders", () => {
    expect(oneTimeRoutes).toEqual(expect.arrayContaining(["/magic-link", "/verify-email", "/start/claim", "/admin/impersonate", "/api/auth/change-email/confirm"]));
  });
});

describe("a one-time route's span data loses the token in its bare query", () => {
  /** The three ways a transaction names the route, each built from the SDK's helpers. */
  function placements(route: string, token: string): { name: string; event: Record<string, unknown>; queries: (e: Trace) => unknown[] }[] {
    const url = `${ORIGIN}${route}?token=${token}&${NEXT}`;
    const other = `${ORIGIN}/dashboard`;
    return [
      {
        name: "the transaction and the trace data's sanitised url name it (getRequestSpanData)",
        event: transaction({ name: `GET ${route}`, traceData: otelTraceData(url) }),
        queries: (e) => [e.contexts.trace.data["http.query"]],
      },
      {
        name: "the trace data is the server integration's (url.query, url.path, http.route)",
        event: transaction({ name: `GET ${route}`, traceData: serverSpanDetails(url, route).data }),
        queries: (e) => [e.contexts.trace.data["url.query"]],
      },
      {
        name: "only a CHILD span's url names it (a fetch from another page); the transaction is /dashboard",
        event: transaction({
          name: "GET /dashboard",
          traceData: otelTraceData(other),
          spans: [{ description: `GET ${url}`, data: clientSpanDetails(url).data }],
        }),
        queries: (e) => [e.spans[0]!.data["url.query"]],
      },
      {
        name: "a child span of the server integration, the transaction is /dashboard",
        event: transaction({
          name: "GET /dashboard",
          traceData: otelTraceData(other),
          spans: [{ description: `GET ${route}`, data: serverSpanDetails(url, route).data }],
        }),
        queries: (e) => [e.spans[0]!.data["url.query"]],
      },
      {
        name: "the root and two children, one of them another route's",
        event: transaction({
          name: `GET ${route}`,
          traceData: otelTraceData(url),
          spans: [
            { description: "GET /api/v1/x", data: clientSpanDetails(`${ORIGIN}/api/v1/x?page=2`).data },
            { description: `GET ${url}`, data: clientSpanDetails(url).data },
          ],
        }),
        queries: (e) => [e.contexts.trace.data["http.query"], e.spans[1]!.data["url.query"]],
      },
      {
        name: "a child span carrying getRequestSpanData's output (a sanitised url and http.query), the transaction is /dashboard",
        event: transaction({ name: "GET /dashboard", traceData: otelTraceData(other), spans: [{ description: `GET ${route}`, data: otelTraceData(url) }] }),
        queries: (e) => [e.spans[0]!.data["http.query"]],
      },
      {
        name: "a child span with only http.query (no url of its own); the transaction names the route",
        event: transaction({ name: `GET ${route}`, traceData: otelTraceData(url), spans: [{ description: "fetch", data: { "http.query": otelTraceData(url)["http.query"] } }] }),
        queries: (e) => [e.spans[0]!.data["http.query"], e.contexts.trace.data["http.query"]],
      },
      {
        name: "an outgoing request's breadcrumb (http.query beside a sanitised url)",
        event: { ...transaction({ name: `GET ${route}`, traceData: otelTraceData(url) }), breadcrumbs: [outgoingBreadcrumb(url)] },
        queries: (e) => [e.breadcrumbs![0]!.data["http.query"], e.contexts.trace.data["http.query"]],
      },
    ];
  }

  it("every one-time route x every real token x every placement: the token is gone, the other parameters stay, the route stays named", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const route of oneTimeRoutes) {
      for (const token of tokens) {
        for (const p of placements(route, token)) {
          const input = p.event;
          const snapshot = structuredClone(input);
          const result = out(input);
          const label = `${route} / ${p.name}`;
          if (json(result).includes(token)) failures.push(`${label}: the token survived`);
          for (const q of p.queries(result)) {
            if (typeof q === "string" && q !== `?token=[token]&${NEXT}`) failures.push(`${label}: the query is ${String(q)}`);
            if (typeof q !== "string") failures.push(`${label}: no query string where the SDK writes one`);
          }
          if (json(input) !== json(snapshot)) failures.push(`${label}: the input was mutated`);
          if (json(scrubSentryEvent(asEvent(structuredClone(result) as unknown as Record<string, unknown>))) !== json(result)) failures.push(`${label}: not idempotent`);
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(oneTimeRoutes.length * tokens.length * 8);
    expect(checked).toBeGreaterThanOrEqual(80);
  });

  it("the query without its ? (a Sentry query_string style value) loses the token too", () => {
    const route = "/magic-link";
    const e = out(transaction({ name: `GET ${route}`, traceData: { url: `${ORIGIN}${route}`, "url.query": `token=${tokens[0]!}&${NEXT}` } }));
    expect(e.contexts.trace.data["url.query"]).toBe(`token=[token]&${NEXT}`);
  });
});

describe("the positive pair: queries that are not a one-time token are left alone", () => {
  const cart = "rg_" + randomBytes(24).toString("base64url");
  it("the reusable cart token's status page (NOT_ONE_TIME) keeps its query", () => {
    expect(Object.keys(NOT_ONE_TIME)).toEqual(["/register/status"]);
    const url = `${ORIGIN}/shared/o/c/register/status?rid=abc&token=${cart}`;
    const event = transaction({ name: "GET /shared/[orgSlug]/[competitionSlug]/register/status", traceData: otelTraceData(url), spans: [{ description: `GET ${url}`, data: clientSpanDetails(url).data }] });
    const result = out(event);
    expect(result.contexts.trace.data["http.query"]).toBe(`?rid=abc&token=${cart}`);
    expect(result.spans[0]!.data["url.query"]).toBe(`?rid=abc&token=${cart}`);
  });
  it("an ordinary route with a token-named parameter keeps it", () => {
    const url = `${ORIGIN}/dashboard?token=abc123&tab=2`;
    const result = out(transaction({ name: "GET /dashboard", traceData: otelTraceData(url) }));
    expect(result.contexts.trace.data["http.query"]).toBe("?token=abc123&tab=2");
  });
  it("a one-time route with no token in its query keeps the whole query", () => {
    const url = `${ORIGIN}/magic-link?${NEXT}`;
    const result = out(transaction({ name: "GET /magic-link", traceData: otelTraceData(url) }));
    expect(result.contexts.trace.data["http.query"]).toBe(`?${NEXT}`);
  });
  it("a route that merely STARTS with a one-time name keeps its query (/magic-linkage)", () => {
    const url = `${ORIGIN}/magic-linkage?token=abc123`;
    const result = out(transaction({ name: "GET /magic-linkage", traceData: otelTraceData(url) }));
    expect(result.contexts.trace.data["http.query"]).toBe("?token=abc123");
  });
});

describe("a serialised request body in a span's data goes with the route's body", () => {
  const signInToken = tokens[0]!;
  const body = JSON.stringify({ token: signInToken, next: "/dashboard" });
  it("the sign-in consume: the trace data's http.request.body.data is dropped; an ordinary POST keeps it", () => {
    const consume = out(
      transaction({ name: "POST /api/auth/magic-link/consume", traceData: { ...serverSpanDetails(`${ORIGIN}/api/auth/magic-link/consume`, "/api/auth/magic-link/consume", "POST").data, "http.request.body.data": body } }),
    );
    expect(Object.hasOwn(consume.contexts.trace.data, "http.request.body.data")).toBe(false);
    expect(json(consume)).not.toContain(signInToken);
    const ordinary = out(
      transaction({ name: "POST /api/v1/x", traceData: { ...serverSpanDetails(`${ORIGIN}/api/v1/x`, "/api/v1/x", "POST").data, "http.request.body.data": body } }),
    );
    expect(ordinary.contexts.trace.data["http.request.body.data"]).toBe(body);
  });
  it("a child span of a route with a secret in its PATH (named by its own url, or its route template) loses it", async () => {
    const invite = (await createInvite("00000000-0000-4000-8000-000000000002", USER_ID, { role: "admin", max_uses: 1 })).token;
    const inviteBody = JSON.stringify({ token: invite });
    const named = [
      { description: "POST claim", data: { ...clientSpanDetails(`${ORIGIN}/api/invites/${invite}/claim`, "POST").data, "http.request.body.data": inviteBody } },
      { description: "POST claim", data: { "http.route": "/api/invites/[token]/claim", "http.request.body.data": inviteBody } },
    ];
    for (const span of named) {
      const result = out(transaction({ name: "GET /dashboard", traceData: otelTraceData(`${ORIGIN}/dashboard`), spans: [span] }));
      expect(Object.hasOwn(result.spans[0]!.data, "http.request.body.data"), span.description).toBe(false);
      expect(json(result)).not.toContain(invite);
    }
    const ordinary = out(
      transaction({ name: "GET /dashboard", traceData: otelTraceData(`${ORIGIN}/dashboard`), spans: [{ description: "x", data: { "http.route": "/api/v1/x", "http.request.body.data": inviteBody } }] }),
    );
    expect(ordinary.spans[0]!.data["http.request.body.data"], "an ordinary route keeps its span body (the positive pair)").toBe(inviteBody);
  });
  it("a child span of the sign-in consume (named by its own url) loses it, in a transaction for another route", () => {
    const result = out(
      transaction({
        name: "GET /dashboard",
        traceData: otelTraceData(`${ORIGIN}/dashboard`),
        spans: [{ description: "POST /api/auth/magic-link/consume", data: { ...clientSpanDetails(`${ORIGIN}/api/auth/magic-link/consume`, "POST").data, "http.request.body.data": body } }],
      }),
    );
    expect(Object.hasOwn(result.spans[0]!.data, "http.request.body.data")).toBe(false);
    expect(json(result)).not.toContain(signInToken);
  });
});

describe("every key that names a span's request pins the span to its route, each on its own", () => {
  // Typed on purpose: this is the test's own statement of which keys name a request. It is compared with the scrubber's list
  // in both directions (a dropped key and an added one both fail), and with what the SDK's helpers really write, below.
  const KEYS = ["url", "url.full", "url.path", "url.template", "http.url", "http.target", "http.route"] as const;

  /** Every string the SDK's helpers write for a request to `url` (route template `route`) that names the request, by key. */
  function written(url: string, route: string): Record<string, string> {
    const path = new URL(url).pathname;
    const out: Record<string, string> = {};
    for (const data of [
      serverSpanDetails(url, route).data,
      clientSpanDetails(url, "GET", route).data,
      otelTraceData(url),
      outgoingRequestSpanData(url),
      outgoingBreadcrumb(url).data,
    ]) {
      for (const [key, value] of Object.entries(data)) if (typeof value === "string" && (value.includes(path) || value === route)) out[key] ??= value;
    }
    return out;
  }

  it("the scrubber's list is exactly this one, and it is what the SDK's helpers write (anti-vacuity: seven keys, none empty)", () => {
    expect([...SPAN_URL_KEYS].sort()).toEqual([...KEYS].sort());
    const sdk = written(`${ORIGIN}/api/orgs/o1/things?x=1`, "/api/orgs/[id]/things");
    // The helpers write the request under these keys; any other key they add for a request has no entry in the list and fails here.
    expect(Object.keys(sdk).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(sdk[key], key).toBeTruthy();
  });

  /** A child span of an unrelated page whose ONLY request-naming key is `key`, with the sibling data a scrub must reach. */
  const spanNamedBy = (key: string, url: string, route: string, extra: SpanData) => {
    const value = written(url, route)[key];
    expect(value, `${key}: the SDK wrote a value for ${url}`).toBeTruthy();
    return out(
      transaction({
        name: "GET /dashboard",
        traceData: otelTraceData(`${ORIGIN}/dashboard`),
        spans: [{ description: "request", data: { [key]: value, ...extra } }],
      }),
    ).spans[0]!.data;
  };

  it.each(KEYS)("%s alone names a one-time-token route: the sibling bare query loses the token", (key) => {
    const query = `?token=${tokens[0]!}&${NEXT}`;
    const data = spanNamedBy(key, `${ORIGIN}/magic-link${query}`, "/magic-link", { "http.query": query, "url.query": query });
    expect(data["http.query"], key).toBe(`?token=[token]&${NEXT}`);
    expect(data["url.query"], key).toBe(`?token=[token]&${NEXT}`);
  });

  it.each(KEYS)("%s alone names a route that takes a credential in its body: the serialised body goes", (key) => {
    const body = JSON.stringify({ token: tokens[0]!, next: "/dashboard" });
    const data = spanNamedBy(key, `${ORIGIN}/api/auth/magic-link/consume`, "/api/auth/magic-link/consume", { "http.request.body.data": body });
    expect(Object.hasOwn(data, "http.request.body.data"), key).toBe(false);
  });

  it.each(KEYS)("%s alone names a route with a secret in its path: the serialised body goes", async (key) => {
    const invite = (await createInvite("00000000-0000-4000-8000-000000000002", USER_ID, { role: "admin", max_uses: 1 })).token;
    const body = JSON.stringify({ token: invite });
    const data = spanNamedBy(key, `${ORIGIN}/api/invites/${invite}/claim`, "/api/invites/[token]/claim", { "http.request.body.data": body });
    expect(Object.hasOwn(data, "http.request.body.data"), key).toBe(false);
  });

  it.each(KEYS)("%s alone names an ordinary route: the query and the body stay (the positive pair)", (key) => {
    const query = `?token=${tokens[0]!}&page=2`;
    const body = JSON.stringify({ note: "hello" });
    const data = spanNamedBy(key, `${ORIGIN}/api/v1/things${query}`, "/api/v1/things", { "http.query": query, "http.request.body.data": body });
    expect(data["http.query"], key).toBe(query);
    expect(data["http.request.body.data"], key).toBe(body);
  });
});
