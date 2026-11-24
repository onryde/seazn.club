// Realtime push nudges, Task 13: one realtime client per token FAMILY.
//
// `realtime.setAuth(token)` is socket-wide (realtime-js `RealtimeClient.setAuth`
// pushes the new token to every joined channel and into every join payload).
// So a page holding a fixture token and a division token on ONE client has each
// family overwrite the other, and the loser's channels rejoin with a token its
// policy refuses. `realtimeClient(family)` gives each family its own client.
//
// `@supabase/supabase-js` is mocked at `createClient` only: every client the
// code makes is recorded, with its options, and records its own `setAuth`
// calls. The producers under test are REAL: the division door module
// (`lib/division-realtime-auth.ts`) and the scorer pad's fixture connector
// (`use-fixture-stream.ts`'s `supabaseRealtimeConnector`).
//
// Applies to another sport: N/A (no sport rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => {
  interface FakeClient {
    url: string;
    key: string;
    options: { auth?: Record<string, unknown> } | undefined;
    setAuth: string[];
    topics: { topic: string; private: boolean }[];
    realtime: { setAuth: (token: string) => Promise<void> };
    channel: (topic: string, params?: { config?: { private?: boolean } }) => unknown;
  }
  const made: FakeClient[] = [];
  const createClient = (url: string, key: string, options?: FakeClient["options"]) => {
    const client: FakeClient = {
      url,
      key,
      options,
      setAuth: [],
      topics: [],
      realtime: {
        setAuth: async (token: string) => {
          client.setAuth.push(token);
        },
      },
      channel(topic, params) {
        client.topics.push({ topic, private: params?.config?.private === true });
        const ch = {
          on: () => ch,
          subscribe: () => ch,
          unsubscribe: async () => "ok",
        };
        return ch;
      },
    };
    made.push(client);
    return client;
  };
  return { made, createClient };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: sb.createClient }));

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const COMP = "0b6a3d3e-2f5c-4e43-9b1f-0d6a5c3b9e01";
const DIV = "7c1f0d2a-6b4e-4a3c-8d2f-1e0a9b8c7d01";
const DIVISION_TOKEN = "division.jwt.sentinel-A";
const FIXTURE_TOKEN = "fixture.jwt.sentinel-B";

function doorFetch() {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          token: DIVISION_TOKEN,
          divisionIds: [DIV],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          url: "https://proj.supabase.co",
          apikey: "anon",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fn, calls };
}

beforeEach(() => {
  vi.resetModules();
  sb.made.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (URL_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = URL_ENV;
  if (KEY_ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = KEY_ENV;
});

const FAMILIES = ["fixture", "division", "lobby"] as const;

describe("realtimeClient(family)", () => {
  it("each family has its own client, and the same family always gets the same one", async () => {
    const { realtimeClient } = await import("../supabase-browser");
    const first = FAMILIES.map((f) => realtimeClient(f));
    const again = FAMILIES.map((f) => realtimeClient(f));

    let checked = 0;
    for (let i = 0; i < FAMILIES.length; i += 1) {
      expect(again[i], `${FAMILIES[i]} is memoised`).toBe(first[i]);
      for (let j = i + 1; j < FAMILIES.length; j += 1) {
        expect(first[i], `${FAMILIES[i]} vs ${FAMILIES[j]}`).not.toBe(first[j]);
        checked += 1;
      }
    }
    // Anti-vacuity: three families, three distinct pairs, three clients made.
    expect(checked).toBe(3);
    expect(sb.made).toHaveLength(3);
    expect(realtimeClient("division")).not.toBe(realtimeClient("fixture"));
  });

  it("a family client keeps no session and has its own storage key", async () => {
    const { realtimeClient } = await import("../supabase-browser");
    for (const f of FAMILIES) realtimeClient(f);
    const keys = sb.made.map((c) => c.options?.auth?.storageKey);
    expect(new Set(keys).size).toBe(FAMILIES.length);
    for (const c of sb.made) {
      expect(c.url).toBe("https://proj.supabase.co");
      expect(c.options?.auth?.persistSession).toBe(false);
      expect(c.options?.auth?.autoRefreshToken).toBe(false);
    }
  });

  it("is not the legacy shared client (supabaseBrowser stays as it was for its callers)", async () => {
    const { realtimeClient, supabaseBrowser } = await import("../supabase-browser");
    const legacy = supabaseBrowser();
    expect(supabaseBrowser()).toBe(legacy);
    for (const f of FAMILIES) expect(realtimeClient(f)).not.toBe(legacy);
  });

  it("missing env throws, and a later call with env set makes the client (nothing half-cached)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { realtimeClient } = await import("../supabase-browser");
    expect(() => realtimeClient("division")).toThrow(/not configured/);
    expect(sb.made).toHaveLength(0);
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    expect(realtimeClient("division")).toBe(sb.made[0]);
  });

  // Another surface: a page that mounts the scorer pad's fixture stream AND a
  // division subscriber (the board beside a pad). Two clients, and each one is
  // handed exactly its own family's token — one `setAuth` each. On a shared
  // client the second `setAuth` would replace the first.
  it("a page mounting the fixture and division families keeps two clients and two setAuth calls, one token each", async () => {
    const door = doorFetch();
    vi.stubGlobal("fetch", door.fn);
    const { supabaseRealtimeConnector } = await import("@/components/v2/scorepad/use-fixture-stream");
    const { acquireDivisionRealtime, _resetDivisionRealtimeAuth } = await import("../division-realtime-auth");
    _resetDivisionRealtimeAuth();

    const sub = supabaseRealtimeConnector.connect({
      token: FIXTURE_TOKEN,
      channel: "fixture:f1",
      onSignal: () => {},
      onStatus: () => {},
    });
    const session = await acquireDivisionRealtime(COMP);
    // The connector's join is fire-and-forget; let it settle.
    await vi.waitFor(() => expect(sb.made.find((c) => c.topics.length > 0)).toBeTruthy());

    expect(session).not.toBeNull();
    expect(door.calls).toEqual([`/api/v1/public/competitions/${COMP}/realtime-token`]);
    expect(sb.made).toHaveLength(2);
    const fixtureClient = sb.made.find((c) => c.options?.auth?.storageKey === "sb-realtime-fixture");
    const divisionClient = sb.made.find((c) => c.options?.auth?.storageKey === "sb-realtime-division");
    expect(fixtureClient?.setAuth).toEqual([FIXTURE_TOKEN]);
    expect(divisionClient?.setAuth).toEqual([DIVISION_TOKEN]);
    expect(fixtureClient?.topics).toEqual([{ topic: "fixture:f1", private: true }]);

    sub.unsubscribe();
    session?.release();
  });
});
