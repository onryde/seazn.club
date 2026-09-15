import { afterEach, describe, expect, it, vi } from "vitest";

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

const applyMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-play", () => ({
  applyProviderGameUpdate: applyMock,
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  applyMock.mockReset();
});

describe("POST /api/webhooks/lichess", () => {
  it("401s on a missing or wrong secret", async () => {
    vi.stubEnv("LICHESS_WEBHOOK_SECRET", "whsec");
    const req = new Request("http://localhost/api/webhooks/lichess", {
      method: "POST",
      body: JSON.stringify({ gameId: "g1" }),
      headers: { "content-type": "application/json" },
    });
    expect((await POST(req)).status).toBe(401);
    hdrs.store = new Headers({ "x-lichess-webhook-secret": "wrong" });
    expect(
      (
        await POST(
          new Request("http://localhost/api/webhooks/lichess", {
            method: "POST",
            body: JSON.stringify({ gameId: "g1" }),
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("applies the game update when the secret matches", async () => {
    vi.stubEnv("LICHESS_WEBHOOK_SECRET", "whsec");
    hdrs.store = new Headers({ "x-lichess-webhook-secret": "whsec" });
    applyMock.mockResolvedValue("finished");
    const res = await POST(
      new Request("http://localhost/api/webhooks/lichess", {
        method: "POST",
        body: JSON.stringify({ gameId: "g1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { result: "finished" } });
    expect(applyMock).toHaveBeenCalledWith({
      provider: "lichess",
      gameId: "g1",
      snapshot: undefined,
    });
  });
});
