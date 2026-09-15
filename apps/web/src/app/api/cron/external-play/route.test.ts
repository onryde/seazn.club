// Cron route auth for external-play T−15 prepare — same x-cron-secret /
// CRON_SECRET contract as /api/cron/billing-events. Sweep is mocked so this
// stays DB-free (prepare logic covered in external-play-prepare.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const prepareMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-play", () => ({
  prepareExternalPlayWindow: prepareMock,
}));

vi.mock("@/lib/oauth", () => ({
  baseUrl: () => "https://example.test",
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  prepareMock.mockReset();
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
  });

  it("503s when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(new Request("http://localhost/api/cron/external-play", { method: "POST" }))).status).toBe(
      503,
    );
  });

  it("runs prepare and returns its counts with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    hdrs.store = new Headers({ "x-cron-secret": "s3cret" });
    prepareMock.mockResolvedValue({ prepared: 1, emailed: 2, deferred: 0, failed: 0 });
    const res = await POST(new Request("http://localhost/api/cron/external-play", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { prepared: 1, emailed: 2, deferred: 0, failed: 0 },
    });
    expect(prepareMock).toHaveBeenCalledWith({ origin: "https://example.test" });
  });
});
