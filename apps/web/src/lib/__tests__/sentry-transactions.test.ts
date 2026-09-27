import { describe, expect, it } from "vitest";
import { isHealthCheckTransaction, sentryBeforeSendTransaction } from "../sentry-transactions";

const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";

// The shape Fly's check produces in prod: the proxy's transaction, named after
// the middleware, with the machine's private address in request.url.
const flyHealthCheck = () => ({
  type: "transaction" as const,
  transaction: "GET middleware GET",
  request: { method: "GET", url: "http://172.19.29.122:3000/api/health" },
});

describe("isHealthCheckTransaction", () => {
  it.each([
    ["Fly's proxy transaction", flyHealthCheck()],
    ["a query string", { request: { url: "http://172.19.29.122:3000/api/health?x=1" } }],
    ["a trailing slash", { request: { url: "https://seazn.club/api/health/" } }],
    ["a relative URL", { request: { url: "/api/health" } }],
    ["the route transaction's name, no request", { transaction: "GET /api/health" }],
  ])("is true for %s", (_name, event) => {
    expect(isHealthCheckTransaction(event)).toBe(true);
  });

  it.each([
    ["another API route", { transaction: "GET middleware GET", request: { url: "https://seazn.club/api/healthz" } }],
    ["a page under /api/health", { request: { url: "https://seazn.club/api/health/deep" } }],
    ["a public page", { transaction: "GET /[locale]", request: { url: "https://seazn.club/en" } }],
    ["no request and another name", { transaction: "GET middleware GET" }],
    ["an unparseable URL", { request: { url: "http://[::1" } }],
  ])("is false for %s", (_name, event) => {
    expect(isHealthCheckTransaction(event)).toBe(false);
  });
});

describe("sentryBeforeSendTransaction", () => {
  it("drops a health-check transaction", () => {
    expect(sentryBeforeSendTransaction(flyHealthCheck())).toBeNull();
  });

  it("keeps every other transaction, with device-link tokens still scrubbed", () => {
    const kept = sentryBeforeSendTransaction({
      type: "transaction" as const,
      transaction: `GET /score/${TOKEN}`,
      request: { url: `https://seazn.club/score/${TOKEN}` },
    });
    expect(kept).not.toBeNull();
    expect(JSON.stringify(kept)).not.toContain(TOKEN);
    expect(kept?.request?.url).toBe("https://seazn.club/score/[token]");
  });
});
