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

  // T1.1 review m2: divisionTopic refuses a blank id, and publishDivisionUpdate is still fire-and-forget — it resolves,
  // sends nothing and warns in broadcast()'s own shape. Its callers `void` it, so a rejection would go unhandled.
  it("publishDivisionUpdate with a blank division id resolves, sends nothing and warns once", async () => {
    const { publishDivisionUpdate } = await import("../realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(publishDivisionUpdate(" ", "score")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["[realtime] division   broadcast failed (Error)"]]);
    warn.mockRestore();
  });

  // Review m1 (player-stats refresh): a caller that awaits a broadcast must not
  // be held by a realtime endpoint that never answers. The lobby publisher had
  // no timeout until it moved onto broadcast() (realtime push-nudges T0.1).
  it.each(["publishFixtureUpdate", "publishDivisionUpdate", "publishExternalPlayLobby"] as const)(
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
          : fn === "publishDivisionUpdate"
            ? realtime.publishDivisionUpdate("div-1", "score")
            : realtime.publishExternalPlayLobby("fx-1");
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

// T16 (controller ruling, T10 carry; design §3.4 step 3) — an accepted move
// reaches SPECTATORS by push, not by their poll: the same request that tells
// both players carries a spectator-safe copy on the public fixture topic (the
// one the public realtime token is minted for, V403's policy). The copy holds
// the board alone — never the draw offer, a participant or a token.
describe("publishRoomBroadcast", () => {
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

  const BODY = {
    // After 1.e4 e5 2.Nf3 — Black to move, fullmove 2.
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
    lastMove: "g1f3",
    turn: "black" as const,
    whiteMs: 590_000,
    blackMs: 595_000,
    status: "started" as const,
    drawOfferBy: "white" as const,
  };
  type Sent = { messages: { topic: string; event: string; payload: Record<string, unknown>; private?: boolean }[] };
  const sent = (): Sent => JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Sent;

  it("one request: the players' room state, AND the spectators' board on the public fixture topic, both private", async () => {
    const { publishRoomBroadcast } = await import("../realtime");
    await publishRoomBroadcast("fx-1", BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { messages } = sent();
    expect(messages.map((m) => [m.topic, m.event, m.private])).toEqual([
      ["external-play:fx-1", "room_state", true],
      ["fixture:fx-1", "board_state", true],
    ]);
    expect(messages[0]!.payload).toEqual(BODY);
  });

  it("the spectators' copy is the board alone: position, last move, turn, ply, clocks, over — no draw offer", async () => {
    const { publishRoomBroadcast } = await import("../realtime");
    await publishRoomBroadcast("fx-1", BODY);
    const spectator = sent().messages[1]!.payload;
    // toEqual on the whole object: a key added later (a participant, a token, the offer) fails here.
    expect(spectator).toEqual({
      fen: BODY.fen,
      lastMove: "g1f3",
      turn: "black",
      ply: 3,
      whiteMs: 590_000,
      blackMs: 595_000,
      over: false,
    });
    expect(JSON.stringify(spectator)).not.toContain("drawOffer");
  });

  it("a board the spectators' copy cannot read costs the spectators one push — the players still get theirs", async () => {
    const { publishRoomBroadcast } = await import("../realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await publishRoomBroadcast("fx-1", { ...BODY, fen: "not a fen" });
    expect(sent().messages.map((m) => m.event)).toEqual(["room_state"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("over on the spectators' copy exactly when Lichess's status has ended the game — every declared status", async () => {
    const { publishRoomBroadcast } = await import("../realtime");
    const { LICHESS_STATUSES } = await import("@/server/external-play/types");
    // The rulebook (lila Status.scala): created and started are the only statuses of a game still on.
    const ON = new Set(["created", "started"]);
    let checked = 0;
    for (const status of LICHESS_STATUSES) {
      fetchMock.mockClear();
      await publishRoomBroadcast("fx-1", { ...BODY, status });
      expect(sent().messages[1]!.payload.over, status).toBe(!ON.has(status));
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared status").toBe(LICHESS_STATUSES.length);
  });
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

  // Push nudges T5 review (m5): V8's JSON.parse message QUOTES the input for some malformations ("Unexpected token 'S',
  // "{"d":SECRET…}" is not valid JSON"), and the mint error reaches a log line and Sentry (the capture beat's
  // realtime_mint report). So the error names the parse error by NAME only. Both env sources, both minters.
  it("a malformed JWK's error carries no fragment of the key — raw or base64, the fixture mint or the capture mint", async () => {
    const FRAGMENT = "KEYFRAG7Zx";   // short: V8 quotes a window of ~10 characters either side of the bad token
    const malformed = `{"kty":"EC","d":${FRAGMENT}}`;
    let parseMessage = "";
    try {
      JSON.parse(malformed);
    } catch (err) {
      parseMessage = (err as Error).message;
    }
    expect(parseMessage, "PREMISE: this engine's JSON.parse message quotes the input").toContain(FRAGMENT);
    let checked = 0;
    for (const source of ["raw", "b64"] as const) {
      for (const minter of ["fixture", "capture"] as const) {
        vi.resetModules();
        delete process.env.SUPABASE_JWT_PRIVATE_KEY;
        delete process.env.SUPABASE_JWT_SIGNING_KEY_B64;
        delete process.env.SUPABASE_JWT_SECRET;
        if (source === "raw") process.env.SUPABASE_JWT_PRIVATE_KEY = malformed;
        else process.env.SUPABASE_JWT_SIGNING_KEY_B64 = Buffer.from(malformed, "utf8").toString("base64");
        const m = await import("../realtime");
        const minted = minter === "fixture" ? m.mintPublicFixtureToken("fx-5", 60) : m.mintCaptureToken("pairing-5", new Date(Date.now() + 60_000));
        const err = await minted.then(() => null, (e: unknown) => e);
        expect(err, `${source}/${minter}: refused`).toBeInstanceOf(Error);
        const e = err as Error;
        expect(e.message, `${source}/${minter}: the refusal names the variable`).toMatch(/SUPABASE_JWT_PRIVATE_KEY is not valid JWK JSON/);
        for (const text of [e.message, e.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e))]) {
          expect(text.includes(FRAGMENT), `${source}/${minter}: a key fragment in the error`).toBe(false);
        }
        expect(e.message, `${source}/${minter}: the parse error by name`).toContain("SyntaxError");
        checked++;
      }
    }
    expect(checked).toBe(4);
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

// Realtime push-nudges T0.1, commit a — the four existing publishers delegate
// to ONE transport, `broadcast()`, and must stay byte-identical on the wire.
// Every literal below was COPIED from the bodies today's code put on the wire
// (captured at 964ee72479, before the delegation), with the clock frozen so
// `v` and `at` are fixed. They are never generated by the new code: a change
// to key order, an added `private`, a dropped field or a split request fails
// here. Applies to another sport: N/A (no sport rules).
describe("golden wire bodies (byte-identical across the broadcast() delegation)", () => {
  const fetchMock = vi.fn();
  /** 2026-11-24T10:00:00.123Z — the frozen clock every literal was captured at. */
  const FROZEN_MS = 1795514400123;
  const URL = "https://example.supabase.co/realtime/v1/api/broadcast";
  const HEADERS = { "Content-Type": "application/json", Authorization: "Bearer service-role", apikey: "service-role" };

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_MS });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  /** The one request the publisher made: URL, method, headers (with their order) and the raw body string. */
  const onlyRequest = () => {
    expect(fetchMock, "exactly one POST per publish").toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toStrictEqual(HEADERS);
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(Object.keys(HEADERS));
    return init;
  };

  it("publishFixtureUpdate: one private state_changed on fixture:{id}", async () => {
    const { publishFixtureUpdate } = await import("../realtime");
    await publishFixtureUpdate("fx-1", "event");
    const init = onlyRequest();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(
      '{"messages":[{"topic":"fixture:fx-1","event":"state_changed","payload":{"v":1795514400123,"reason":"event","at":"2026-11-24T10:00:00.123Z"},"private":true}]}',
    );
  });

  it("publishDivisionUpdate score: state_changed on division:{id}, NO private key (public until the §4 dual window)", async () => {
    const { publishDivisionUpdate } = await import("../realtime");
    await publishDivisionUpdate("dv-1", "score");
    const init = onlyRequest();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(
      '{"messages":[{"topic":"division:dv-1","event":"state_changed","payload":{"v":1795514400123,"reason":"score","at":"2026-11-24T10:00:00.123Z"}}]}',
    );
  });

  it("publishDivisionUpdate schedule: schedule_changed on division:{id}", async () => {
    const { publishDivisionUpdate } = await import("../realtime");
    await publishDivisionUpdate("dv-1", "schedule");
    const init = onlyRequest();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(
      '{"messages":[{"topic":"division:dv-1","event":"schedule_changed","payload":{"v":1795514400123,"reason":"schedule","at":"2026-11-24T10:00:00.123Z"}}]}',
    );
  });

  it("publishRoomBroadcast: room_state and board_state in ONE request, both private", async () => {
    const { publishRoomBroadcast } = await import("../realtime");
    await publishRoomBroadcast("fx-1", {
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      lastMove: "g1f3",
      turn: "black",
      whiteMs: 590_000,
      blackMs: 595_000,
      status: "started",
      drawOfferBy: "white",
    });
    const init = onlyRequest();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(
      '{"messages":[{"topic":"external-play:fx-1","event":"room_state","payload":{"fen":"rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2","lastMove":"g1f3","turn":"black","whiteMs":590000,"blackMs":595000,"status":"started","drawOfferBy":"white"},"private":true},{"topic":"fixture:fx-1","event":"board_state","payload":{"fen":"rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2","lastMove":"g1f3","turn":"black","ply":3,"whiteMs":590000,"blackMs":595000,"over":false},"private":true}]}',
    );
  });

  it("publishExternalPlayLobby: one private lobby_changed whose payload is the version alone", async () => {
    const { publishExternalPlayLobby } = await import("../realtime");
    await publishExternalPlayLobby("fx-1");
    const init = onlyRequest();
    expect(init.signal, "the lobby publish carries the 3 s timeout too").toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(
      '{"messages":[{"topic":"external-play:fx-1","event":"lobby_changed","payload":{"v":1795514400123},"private":true}]}',
    );
  });

  // Sequence: a second publish is its own request carrying only its own message
  // (the transport keeps no buffer between calls).
  it("a second publish is an independent request with its own body", async () => {
    const { publishFixtureUpdate } = await import("../realtime");
    await publishFixtureUpdate("fx-1", "event");
    await publishFixtureUpdate("fx-2", "finalize");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(
      '{"messages":[{"topic":"fixture:fx-2","event":"state_changed","payload":{"v":1795514400123,"reason":"finalize","at":"2026-11-24T10:00:00.123Z"},"private":true}]}',
    );
  });
});
