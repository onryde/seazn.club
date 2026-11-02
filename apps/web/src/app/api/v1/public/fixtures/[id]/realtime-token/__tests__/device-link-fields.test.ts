// The realtime-token answer also carries `url` and `apikey` — the PUBLIC project URL and anon key the browser already ships —
// so the phone's Remote Scoring configures its Realtime client from the server and bakes nothing in (owner, 2026-11-01).
// Real route, real device link (the phone's door); the JWT mint is a spy (the signature is not under test). The values are
// literals the test stubs into the environment, never read back from the route. Skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/realtime")>()),
  mintPublicFixtureToken: async (fixtureId: string) => `token:${fixtureId}`,
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => null, // a phone holds a link, not a session
}));

import { createDeviceLink } from "@/server/usecases/device-links";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { fixturesOf, seedStage } from "@/server/usecases/__tests__/_sheets-rig";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

async function ask(fixtureId: string, secret: string) {
  const res = await GET(
    new Request(`https://test.local/api/v1/public/fixtures/${fixtureId}/realtime-token`, {
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ id: fixtureId }) },
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; data: Record<string, unknown> } };
}

describe.skipIf(!HAS_DB)("realtime-token answers url and apikey beside token and channel", () => {
  it("a valid dl_ link for the fixture gets all four, the public values from the environment", async () => {
    const { auth } = await seedOrg();
    const { stage } = await seedStage(auth, "league", ["Ada", "Bea"]);
    const [f] = await fixturesOf(stage.id);
    const link = await createDeviceLink(auth, f!.id, null);
    // After seeding: a set URL would make the seed's own broadcasts dial it.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj-abc.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-literal-123");
    const r = await ask(f!.id, link.secret);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data).toEqual({
      token: `token:${f!.id}`,
      channel: `fixture:${f!.id}`,
      url: "https://proj-abc.supabase.test",
      apikey: "anon-key-literal-123",
    });
  });

  it("a deployment without the public values answers null for them, never undefined or an error", async () => {
    const { auth } = await seedOrg();
    const { stage } = await seedStage(auth, "league", ["Ada", "Bea"]);
    const [f] = await fixturesOf(stage.id);
    const link = await createDeviceLink(auth, f!.id, null);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const r = await ask(f!.id, link.secret);
    expect(r.status).toBe(200);
    expect(r.body.data.token).toBe(`token:${f!.id}`);
    expect(r.body.data.channel).toBe(`fixture:${f!.id}`);
    expect(r.body.data.url).toBeNull();
    expect(r.body.data.apikey).toBeNull();
  });
});
