// Cron route auth for external-play T−15 prepare — same x-cron-secret /
// CRON_SECRET contract as /api/cron/billing-events. Sweep is mocked so this
// stays DB-free (prepare logic covered in external-play-prepare.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const prepareMock = vi.hoisted(() => vi.fn());
const pollMock = vi.hoisted(() => vi.fn());
const escalateMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-play", () => ({
  prepareExternalPlayWindow: prepareMock,
  pollLiveExternalPlay: pollMock,
  escalateStaleExternalPlay: escalateMock,
}));

vi.mock("@/lib/oauth", () => ({
  baseUrl: () => "https://example.test",
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  prepareMock.mockReset();
  pollMock.mockReset();
  escalateMock.mockReset();
});

describe("POST /api/cron/external-play", () => {
  it("401s with a missing or wrong x-cron-secret, never running prepare", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(new Request("http://localhost/api/cron/external-play", { method: "POST" }))).status).toBe(
      401,
    );
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await POST(new Request("http://localhost/api/cron/external-play", { method: "POST" }))).status).toBe(
      401,
    );
    expect(prepareMock).not.toHaveBeenCalled();
    expect(pollMock).not.toHaveBeenCalled();
    expect(escalateMock).not.toHaveBeenCalled();
  });

  it("503s when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(new Request("http://localhost/api/cron/external-play", { method: "POST" }))).status).toBe(
      503,
    );
  });

  it("runs prepare + poll + escalate and returns all counts with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    prepareMock.mockResolvedValue({ prepared: 1, emailed: 2, deferred: 0, failed: 0 });
    pollMock.mockResolvedValue({
      polled: 1,
      live: 0,
      finished: 1,
      needs_organiser: 0,
      ignored: 0,
    });
    escalateMock.mockResolvedValue({ escalated: 1 });
    const res = await POST(new Request("http://localhost/api/cron/external-play", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: {
        prepare: { prepared: 1, emailed: 2, deferred: 0, failed: 0 },
        poll: { polled: 1, live: 0, finished: 1, needs_organiser: 0, ignored: 0 },
        escalate: { escalated: 1 },
      },
    });
    expect(prepareMock).toHaveBeenCalledWith({ origin: "https://example.test" });
    expect(pollMock).toHaveBeenCalledTimes(1);
    expect(escalateMock).toHaveBeenCalledTimes(1);
  });
});
