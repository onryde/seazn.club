// REALTIME_PUBLISH=off silences every server-side broadcast without touching
// the Supabase URL/key (storage uploads still need them). Local servers set it
// because .env.local points at the STG project (2026-11-03, ~370k/day).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("REALTIME_PUBLISH kill switch", () => {
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
    delete process.env.REALTIME_PUBLISH;
  });

  const publishers = async () => {
    const m = await import("../realtime");
    return {
      publishFixtureUpdate: () => m.publishFixtureUpdate("fx-1", "event"),
      publishDivisionUpdate: () => m.publishDivisionUpdate("dv-1", "score"),
      publishExternalPlayLobby: () => m.publishExternalPlayLobby("fx-1"),
      publishRoomBroadcast: () => m.publishRoomBroadcast("fx-1", { kind: "state" } as never),
    };
  };

  it("off: none of the four publishers calls fetch", async () => {
    process.env.REALTIME_PUBLISH = "off";
    const p = await publishers();
    const names = Object.keys(p);
    expect(names).toHaveLength(4); // anti-vacuity: all four were exercised
    for (const n of names) await p[n as keyof typeof p]();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unset: the same publishers DO reach fetch (the off test is not vacuous)", async () => {
    const p = await publishers();
    await p.publishFixtureUpdate();
    await p.publishDivisionUpdate();
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.supabase.co/realtime/v1/api/broadcast");
  });
});
