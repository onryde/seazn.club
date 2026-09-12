// publishFixtureUpdate fans out private + public — scorepad is private;
// spectator overlay falls back to public when the minted JWT fails auth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("publishFixtureUpdate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("posts private and public twins on the fixture topic", async () => {
    const { publishFixtureUpdate } = await import("../realtime");
    await publishFixtureUpdate("fx-1", "event");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.supabase.co/realtime/v1/api/broadcast");
    const body = JSON.parse((init as RequestInit).body as string) as {
      messages: { topic: string; event: string; private?: boolean }[];
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      topic: "fixture:fx-1",
      event: "state_changed",
      private: true,
    });
    expect(body.messages[1]).toMatchObject({
      topic: "fixture:fx-1",
      event: "state_changed",
    });
    expect(body.messages[1]).not.toHaveProperty("private");
  });
});
