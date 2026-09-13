// publishFixtureUpdate fans out private + public — scorepad is private;
// spectator overlay falls back to public when the minted JWT fails auth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";

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

describe("mintPublicFixtureToken", () => {
  afterEach(() => {
    delete process.env.SUPABASE_JWT_PRIVATE_KEY;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_KID;
    vi.restoreAllMocks();
  });

  it("mints ES256 with kid when SUPABASE_JWT_PRIVATE_KEY is a private JWK", async () => {
    vi.resetModules();
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const jwk = await exportJWK(privateKey);
    jwk.kid = "test-kid-es256";
    jwk.alg = "ES256";
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-kid-es256";
    publicJwk.alg = "ES256";
    process.env.SUPABASE_JWT_PRIVATE_KEY = JSON.stringify(jwk);
    delete process.env.SUPABASE_JWT_SECRET;

    const { mintPublicFixtureToken } = await import("../realtime");
    const token = await mintPublicFixtureToken("fx-1", 60);
    const { payload, protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: [publicJwk] }),
      { audience: "authenticated" },
    );
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe("test-kid-es256");
    expect(payload.fixture_id).toBe("fx-1");
    expect(payload.role).toBe("authenticated");
  });

  it("falls back to HS256 for a non-UUID shared secret", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_JWT_PRIVATE_KEY;
    process.env.SUPABASE_JWT_SECRET = "a-long-shared-secret-not-a-uuid";

    const { mintPublicFixtureToken } = await import("../realtime");
    const token = await mintPublicFixtureToken("fx-2", 60);
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode("a-long-shared-secret-not-a-uuid"),
      { audience: "authenticated" },
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.fixture_id).toBe("fx-2");
  });
});
