// publishFixtureUpdate sends ONE private message on the fixture topic (review
// 2026-09-14, I1) — every subscriber in this codebase joins private, and a
// non-private twin was joinable by anyone holding the public anon key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from "jose";

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

  it("posts exactly one PRIVATE message on the fixture topic — no public twin", async () => {
    const { publishFixtureUpdate } = await import("../realtime");
    await publishFixtureUpdate("fx-1", "event");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.supabase.co/realtime/v1/api/broadcast");
    const body = JSON.parse((init as RequestInit).body as string) as {
      messages: { topic: string; event: string; private?: boolean }[];
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      topic: "fixture:fx-1",
      event: "state_changed",
      private: true,
    });
  });

  // Review m1 (player-stats refresh): a caller that awaits a broadcast must not
  // be held by a realtime endpoint that never answers.
  it.each(["publishFixtureUpdate", "publishDivisionUpdate"] as const)(
    "%s aborts a broadcast that never answers after BROADCAST_TIMEOUT_MS, and resolves",
    async (fn) => {
      const realtime = await import("../realtime");
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
          }),
      );
      let settled = false;
      const sent =
        fn === "publishFixtureUpdate"
          ? realtime.publishFixtureUpdate("fx-1", "event")
          : realtime.publishDivisionUpdate("div-1", "score");
      void sent.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(timeout).toHaveBeenCalledWith(realtime.BROADCAST_TIMEOUT_MS);
      expect(settled, "still waiting on the endpoint").toBe(false);

      controller.abort();
      await sent;
      expect(settled).toBe(true);
      timeout.mockRestore();
      warn.mockRestore();
    },
  );
});

describe("mintPublicFixtureToken", () => {
  afterEach(() => {
    delete process.env.SUPABASE_JWT_PRIVATE_KEY;
    delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_KID;
    delete process.env.SUPABASE_JWT_ALG;
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

  it("mints ES256 from SUPABASE_JWT_SIGNING_KEY_B64 when the raw key is unset", async () => {
    vi.resetModules();
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const jwk = await exportJWK(privateKey);
    jwk.kid = "test-kid-b64";
    jwk.alg = "ES256";
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-kid-b64";
    publicJwk.alg = "ES256";
    delete process.env.SUPABASE_JWT_PRIVATE_KEY;
    process.env.SUPABASE_JWT_SIGNING_KEY_B64 = Buffer.from(
      JSON.stringify(jwk),
      "utf8",
    ).toString("base64");
    delete process.env.SUPABASE_JWT_SECRET;

    const { mintPublicFixtureToken } = await import("../realtime");
    const token = await mintPublicFixtureToken("fx-b64", 60);
    const { protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: [publicJwk] }),
      { audience: "authenticated" },
    );
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe("test-kid-b64");
  });

  it("falls back to HS256 for a non-UUID shared secret", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_JWT_PRIVATE_KEY;
    delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
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

  // Review 2026-09-14, I7a — a malformed JWK JSON string used to throw a raw
  // SyntaxError straight out of mintPublicFixtureToken (500ing the token
  // route). The fix wraps JSON.parse in try/catch and throws a clear,
  // prefixed message instead.
  it("throws a clear error for malformed JWK JSON, not a raw SyntaxError", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_JWT_PRIVATE_KEY = "{not valid json";

    const { mintPublicFixtureToken } = await import("../realtime");
    await expect(mintPublicFixtureToken("fx-3", 60)).rejects.toThrow(
      /SUPABASE_JWT_PRIVATE_KEY is not valid JWK JSON/,
    );
  });

  // Review 2026-09-14, I7c — an unrecognized jwk.alg (ES512, EdDSA, …) used to
  // be silently coerced to ES256 rather than rejected, so the minted token's
  // header would lie about the algorithm that actually signed it.
  it("throws a clear error for a JWK with an unsupported alg, rather than silently minting ES256", async () => {
    vi.resetModules();
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    jwk.alg = "ES512"; // declared, but not one this function can mint with
    delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_JWT_PRIVATE_KEY = JSON.stringify(jwk);

    const { mintPublicFixtureToken } = await import("../realtime");
    await expect(mintPublicFixtureToken("fx-4", 60)).rejects.toThrow(
      /unsupported alg "ES512"/,
    );
  });

  // Review 2026-09-14, I7b — RS256 detection sniffed for the PKCS1
  // "BEGIN RSA PRIVATE KEY" header, but importPKCS8 requires PKCS8
  // ("BEGIN PRIVATE KEY"), which carries no algorithm signal in its header
  // text. A real RS256 PKCS8 PEM was therefore never detected as RS256 and
  // got imported as ES256, which throws from jose. SUPABASE_JWT_ALG=RS256 is
  // the fix — proved here against a REAL generated RSA keypair, not a stub.
  it("mints RS256 from a PKCS8 PEM when SUPABASE_JWT_ALG=RS256 names it", async () => {
    vi.resetModules();
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
      modulusLength: 2048,
    });
    const pem = await exportPKCS8(privateKey);
    delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_JWT_PRIVATE_KEY = pem;
    process.env.SUPABASE_JWT_ALG = "RS256";
    process.env.SUPABASE_JWT_KID = "test-kid-rs256";

    const { mintPublicFixtureToken } = await import("../realtime");
    const token = await mintPublicFixtureToken("fx-5", 60);
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      audience: "authenticated",
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe("test-kid-rs256");
    expect(payload.fixture_id).toBe("fx-5");
  });

  // Sibling of the above: without SUPABASE_JWT_ALG (and no PKCS1 header —
  // real RSA PKCS8 keys never carry one), the same RS256 PEM is misdetected
  // as ES256 and jose throws rather than minting silently-wrong output.
  it("without SUPABASE_JWT_ALG, an RS256 PKCS8 PEM is misdetected as ES256 and throws", async () => {
    vi.resetModules();
    const { privateKey } = await generateKeyPair("RS256", {
      extractable: true,
      modulusLength: 2048,
    });
    const pem = await exportPKCS8(privateKey);
    delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_ALG;
    process.env.SUPABASE_JWT_PRIVATE_KEY = pem;

    const { mintPublicFixtureToken } = await import("../realtime");
    await expect(mintPublicFixtureToken("fx-6", 60)).rejects.toThrow();
  });
});
