// Unit coverage for the typed request() helper's core contract: it FAILS
// the run (throws, body captured) on any unexpected 4xx/5xx. fetch is
// mocked — no live server involved.
import { afterEach, describe, expect, it } from "vitest";
import { BenchHttpError, newSession, request } from "../http.ts";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetchOnce(status: number, body: unknown): void {
  global.fetch = (async () =>
    ({
      status,
      headers: { getSetCookie: () => [] },
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("request()", () => {
  it("returns data on a 2xx ok:true response", async () => {
    mockFetchOnce(200, { ok: true, data: { id: "abc" } });
    const data = await request<{ id: string }>("http://x", newSession(), "/thing");
    expect(data).toEqual({ id: "abc" });
  });

  it("throws BenchHttpError with the response body captured on an unexpected 422", async () => {
    const body = { ok: false, error: "invalid", issues: [{ path: ["sport_key"] }] };
    mockFetchOnce(422, body);
    const err = await request("http://x", newSession(), "/thing", { method: "POST" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchHttpError);
    expect((err as BenchHttpError).status).toBe(422);
    expect((err as BenchHttpError).body).toEqual(body);
    expect((err as BenchHttpError).path).toBe("/thing");
  });

  it("throws on a 5xx even when the body happens to parse as ok:true-shaped JSON", async () => {
    mockFetchOnce(503, { ok: true, data: "should not matter" });
    await expect(request("http://x", newSession(), "/thing")).rejects.toBeInstanceOf(BenchHttpError);
  });

  it("allows an explicitly allowlisted status instead of throwing", async () => {
    mockFetchOnce(404, { ok: false, error: "not found" });
    const data = await request("http://x", newSession(), "/thing", { allowStatus: [404] });
    expect(data).toBeUndefined();
  });
});
