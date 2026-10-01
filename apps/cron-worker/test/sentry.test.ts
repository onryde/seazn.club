import { describe, expect, it, vi } from "vitest";
import { captureJobFailure, parseDsn, type JobFailure } from "../src/sentry";

const DSN = "https://abc123@o42.ingest.de.sentry.io/4507";
const dsn = parseDsn(DSN)!;
const DEGRADED: JobFailure = {
  job: "billing-events",
  status: "degraded",
  httpStatus: 200,
  attempts: 1,
  ms: 40,
  reason: "counts",
  degraded: { "data.failed": 3 },
  body: '{"ok":true,"data":{"note":"org-secret-name"}}',
};
const send = (fetchFn: unknown, failure: JobFailure = DEGRADED, run: "scheduled" | "manual" = "scheduled") =>
  captureJobFailure(fetchFn as typeof fetch, dsn, {
    environment: "prod",
    run,
    failure,
    eventId: "0123456789abcdef0123456789abcdef",
    nowMs: Date.parse("2026-09-29T14:17:05Z"),
  });
const sentBody = (fetchFn: ReturnType<typeof vi.fn>) => String((fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].body);

describe("parseDsn", () => {
  it("splits a DSN into ingest origin, project and public key", () => {
    expect(parseDsn(DSN)).toEqual({ origin: "https://o42.ingest.de.sentry.io", projectId: "4507", publicKey: "abc123" });
  });
  it.each([undefined, "", "not a url", "https://o42.ingest.sentry.io/4507"])("returns null for %j", (v) => {
    expect(parseDsn(v)).toBeNull();
  });
});

describe("captureJobFailure", () => {
  it("posts ONE envelope holding an error-level event tagged with the job", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await send(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://o42.ingest.de.sentry.io/api/4507/envelope/?sentry_key=abc123&sentry_version=7");
    expect(init.method).toBe("POST");
    const [header, item, event] = sentBody(fetchFn).split("\n").map((l) => JSON.parse(l));
    expect(header).toEqual({ event_id: "0123456789abcdef0123456789abcdef", sent_at: "2026-09-29T14:17:05.000Z" });
    expect(item).toEqual({ type: "event" });
    expect(event).toMatchObject({
      level: "error",
      environment: "prod",
      tags: { job: "billing-events", reason: "counts", run: "scheduled", http_status: "200" },
      fingerprint: ["cron-worker", "billing-events", "counts"],
      extra: { attempts: 1, degraded: { "data.failed": 3 } },
    });
    expect(event.exception.values[0]).toEqual({ type: "CronJobFailed", value: "billing-events reported data.failed=3" });
  });

  it("names a transport failure and a manual run", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await send(fetchFn, { job: "registrations", status: "error", httpStatus: null, attempts: 1, ms: 60_000, reason: "timeout" }, "manual");
    const event = JSON.parse(sentBody(fetchFn).split("\n")[2]!);
    expect(event.tags).toEqual({ job: "registrations", reason: "timeout", run: "manual", http_status: "none" });
    expect(event.exception.values[0].value).toBe("registrations failed: timeout");
  });

  it("bounds the send at 5 s and never follows a redirect (the request carries the DSN key)", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchFn = vi.fn(async () => new Response("{}"));
      await send(fetchFn);
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect((fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].redirect).toBe("manual");
    } finally {
      timeout.mockRestore();
    }
  });

  it("never sends the route's response body (lib/sentry.ts PII rule: ids and counts only)", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await send(fetchFn);
    expect(sentBody(fetchFn)).not.toContain("org-secret-name");
  });

  it("resolves true only when Sentry ACCEPTS the event (I-3)", async () => {
    expect(await send(vi.fn(async () => new Response('{"id":"x"}', { status: 200 })))).toBe(true);
  });

  it.each([400, 401, 403, 404, 429, 500])("resolves false, never throws, when Sentry answers %i (a rotated DSN key must not look delivered)", async (status) => {
    const fetchFn = vi.fn(async () => new Response("no", { status }));
    await expect(send(fetchFn)).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1); // best-effort: no retry
  });

  it("never rejects when Sentry is down, and reports not delivered", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("sentry unreachable");
    });
    await expect(send(fetchFn)).resolves.toBe(false);
  });
});
