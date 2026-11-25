// REALTIME_PUBLISH=off silences every server-side broadcast without touching
// the Supabase URL/key (storage uploads still need them). Local servers set it
// because .env.local points at the STG project (2026-11-03, ~370k/day).
//
// The value is read the way a person writes it: the repo's own .env.local
// carries `REALTIME_PUBLISH=Off`, and an exact `=== "off"` read that as "on",
// so every local server published to stg anyway (realtime push-nudges T0.2
// review, m5). Case and surrounding whitespace do not matter; any other value,
// or none, publishes.
//
// Applies to another sport: N/A (no sport rules).
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
    // vitest loads the repo's .env.local, which sets this: every case starts from unset, never from the file.
    delete process.env.REALTIME_PUBLISH;
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

  // "Off" is the spelling the repo's .env.local actually carries.
  it.each(["off", "Off", " OFF "])("%j: none of the four publishers calls fetch", async (value) => {
    process.env.REALTIME_PUBLISH = value;
    const p = await publishers();
    const names = Object.keys(p);
    expect(names).toHaveLength(4); // anti-vacuity: all four were exercised
    for (const n of names) await p[n as keyof typeof p]();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["on", "on"],
  ] as const)("%s: the same publishers DO reach fetch (the off cases are not vacuous)", async (_label, value) => {
    if (value !== undefined) process.env.REALTIME_PUBLISH = value;
    expect(process.env.REALTIME_PUBLISH).toBe(value);
    const p = await publishers();
    await p.publishFixtureUpdate();
    await p.publishDivisionUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.supabase.co/realtime/v1/api/broadcast");
  });
});
