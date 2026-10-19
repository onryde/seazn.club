// Test-only: Sentry span data as the SDK itself writes it, so a scrub test is built from the SDK's output and not from a
// hand-made shape. Not a test file (no `.test.` in the name), so vitest never collects it.
//
// The SDK's helpers are loaded through `@sentry/nextjs`'s own resolution (`createRequire` from the package that depends on
// them), which also bypasses the `vi.mock("@sentry/nextjs")` the wiring suite installs: the mock replaces the package's
// exports, and these helpers live in `@sentry/core` and `@sentry/opentelemetry`.
//  - `getHttpSpanDetailsFromUrlObject` (@sentry/core) is what the http server and client integrations call: it writes the
//    bare query as `url.query` (WITH its `?`), beside `url.full`, `url.path`, `url.fragment` and `http.route`.
//  - `getRequestSpanData` (@sentry/opentelemetry) is what turns an OpenTelemetry http span into the transaction's trace
//    data: a SANITISED `url` (no query) and the bare query as `http.query` (WITH its `?`).
import { createRequire } from "node:module";

const fromNextjs = createRequire(createRequire(import.meta.url).resolve("@sentry/nextjs"));
const core = fromNextjs("@sentry/core") as {
  parseStringToURLObject(url: string): unknown;
  parseUrl(url: string): { search?: string; hash?: string };
  getSanitizedUrlString(parsed: unknown): string;
  getHttpSpanDetailsFromUrlObject(
    urlObject: unknown,
    kind: "server" | "client",
    origin: string,
    request?: { method?: string },
    routeName?: string,
  ): [string, Record<string, unknown>];
};
const otel = fromNextjs("@sentry/opentelemetry") as {
  getRequestSpanData(span: { attributes: Record<string, unknown> }): Record<string, unknown>;
};

export type SpanData = Record<string, unknown>;

/** What the http server integration records for a request: `url.query`, `url.full`, `url.path`, `http.route`, … */
export function serverSpanDetails(url: string, route?: string, method = "GET"): { name: string; data: SpanData } {
  const [name, data] = core.getHttpSpanDetailsFromUrlObject(core.parseStringToURLObject(url), "server", "auto.http.otel.http", { method }, route);
  return { name, data };
}
/** What the http client integration records for an outgoing request. */
export function clientSpanDetails(url: string, method = "GET"): { name: string; data: SpanData } {
  const [name, data] = core.getHttpSpanDetailsFromUrlObject(core.parseStringToURLObject(url), "client", "auto.http.fetch", { method });
  return { name, data };
}
/** What an OpenTelemetry http span becomes in a transaction's trace data: a sanitised `url` and the bare `http.query`. */
export function otelTraceData(url: string, method = "GET"): SpanData {
  return otel.getRequestSpanData({ attributes: { "url.full": url, "http.request.method": method } });
}

/**
 * The breadcrumb the http integration records for an outgoing request (`addOutgoingRequestBreadcrumb`): a sanitised `url`,
 * the bare query as `http.query` and the fragment as `http.fragment`. That function needs a live ClientRequest and the
 * current scope, so the data is built here from the same two URL helpers it calls.
 */
export function outgoingBreadcrumb(url: string): { category: string; type: string; level: string; data: SpanData } {
  const parsed = core.parseUrl(url);
  return {
    category: "http",
    type: "http",
    level: "info",
    data: {
      status_code: 200,
      url: core.getSanitizedUrlString(parsed),
      "http.method": "GET",
      ...(parsed.search ? { "http.query": parsed.search } : {}),
      ...(parsed.hash ? { "http.fragment": parsed.hash } : {}),
    },
  };
}

/** A transaction event the way the SDK assembles one: the root span's data in `contexts.trace.data`, children in `spans`. */
export function transaction(opts: {
  name: string;
  traceData: SpanData;
  spans?: { description: string; data: SpanData }[];
  request?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: "transaction",
    transaction: opts.name,
    transaction_info: { source: "route" },
    contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), op: "http.server", origin: "auto.http.otel.http", data: opts.traceData } },
    spans: (opts.spans ?? []).map((s, i) => ({
      trace_id: "a".repeat(32),
      span_id: String(i).padStart(16, "c"),
      parent_span_id: "b".repeat(16),
      description: s.description,
      op: "http.client",
      origin: "auto.http.fetch",
      start_timestamp: 1,
      timestamp: 2,
      data: s.data,
    })),
    ...(opts.request ? { request: opts.request } : {}),
  };
}
