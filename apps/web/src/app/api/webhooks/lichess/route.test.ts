import { afterEach, describe, expect, it, vi } from "vitest";
import { signLichessWebhook } from "@/server/external-play/webhook-signature";

const applyMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/external-play", () => ({
  applyProviderGameUpdate: applyMock,
}));

import { POST } from "./route";

const secret = "whsec-sign-key";
const now = 1_700_000_000;

function signedRequest(body: string, header?: string): Request {
  return new Request("http://localhost/api/webhooks/lichess", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...(header ? { "x-lichess-signature": header } : {}),
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  applyMock.mockReset();
});

describe("POST /api/webhooks/lichess", () => {
  it("401s when the HMAC header is missing, stale, or signed with the wrong key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    vi.stubEnv("LICHESS_WEBHOOK_SECRET", secret);
    const body = JSON.stringify({ gameId: "g1" });
    expect((await POST(signedRequest(body))).status).toBe(401);
    const good = signLichessWebhook({ secret, timestamp: now - 400, rawBody: body });
    expect((await POST(signedRequest(body, good))).status).toBe(401);
    const wrongKey = signLichessWebhook({ secret: "nope", timestamp: now, rawBody: body });
    expect((await POST(signedRequest(body, wrongKey))).status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("fetches the game from Lichess and ignores a caller-supplied snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    vi.stubEnv("LICHESS_WEBHOOK_SECRET", secret);
    applyMock.mockResolvedValue("finished");
    const body = JSON.stringify({
      gameId: "g1",
      game: { id: "g1", status: "mate", winner: "white", players: {} },
    });
    const header = signLichessWebhook({ secret, timestamp: now, rawBody: body });
    const res = await POST(signedRequest(body, header));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { result: "finished" } });
    expect(applyMock).toHaveBeenCalledWith({
      provider: "lichess",
      gameId: "g1",
    });
  });
});
