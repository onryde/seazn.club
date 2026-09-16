import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLichessAdapter } from "../lichess/adapter";
import { LichessHttpError } from "../types";
import { LICHESS_TIMEOUT_MS } from "../window";

const raw = (f: string) => readFileSync(join(__dirname, "../__fixtures__/lichess", f), "utf8");

/** Shape of the raw export fixtures, trimmed per __fixtures__/lichess/README.md. */
type RawExport = {
  id: string;
  rated: boolean;
  status: string;
  winner?: "white" | "black";
  players: {
    white: { user: { id: string; name: string } };
    black: { user: { id: string; name: string } };
  };
};
const rawFixture = (f: string) => JSON.parse(raw(f)) as RawExport;

describe("createOpenChallenge", () => {
  it("POSTs /api/challenge/open with users White-first, seconds clock, expiresAt ms, unrated, no auth, shared timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "abcd1234", url: "https://lichess.org/abcd1234",
      urlWhite: "https://lichess.org/abcd1234?color=white", urlBlack: "https://lichess.org/abcd1234?color=black",
    }), { status: 200 }));
    const adapter = createLichessAdapter({ fetch, baseUrl: "https://li.test" });
    const expiresAt = new Date("2026-10-01T19:20:00.000Z");
    const out = await adapter.createOpenChallenge({
      whiteUsername: "Alice", blackUsername: "Bob", clock: { limit: 900, increment: 10 }, expiresAt,
    });
    expect(out).toEqual({
      challengeId: "abcd1234",
      urlWhite: "https://lichess.org/abcd1234?color=white",
      urlBlack: "https://lichess.org/abcd1234?color=black",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/challenge/open");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("users")).toBe("Alice,Bob");
    expect(body.get("clock.limit")).toBe("900");
    expect(body.get("clock.increment")).toBe("10");
    expect(body.get("rated")).toBe("false");
    expect(body.get("expiresAt")).toBe(String(expiresAt.getTime()));
    expect(body.get("rules")).toBe("noRematch");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(LICHESS_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it("throws LichessHttpError on 401", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 401 }));
    const adapter = createLichessAdapter({ fetch });
    await expect(
      adapter.createOpenChallenge({
        whiteUsername: "Alice",
        blackUsername: "Bob",
        clock: { limit: 60, increment: 0 },
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(LichessHttpError);
    await expect(
      adapter.createOpenChallenge({
        whiteUsername: "Alice",
        blackUsername: "Bob",
        clock: { limit: 60, increment: 0 },
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("throws LichessHttpError on 429", async () => {
    const fetch = vi.fn(async () => new Response("slow", { status: 429 }));
    const adapter = createLichessAdapter({ fetch });
    await expect(
      adapter.createOpenChallenge({
        whiteUsername: "Alice",
        blackUsername: "Bob",
        clock: { limit: 60, increment: 0 },
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("throws LichessHttpError 502 on a 200 response missing id", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      urlWhite: "https://lichess.org/abcd1234?color=white",
      urlBlack: "https://lichess.org/abcd1234?color=black",
    }), { status: 200 }));
    const adapter = createLichessAdapter({ fetch });
    const call = adapter.createOpenChallenge({
      whiteUsername: "Alice",
      blackUsername: "Bob",
      clock: { limit: 60, increment: 0 },
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await expect(call).rejects.toBeInstanceOf(LichessHttpError);
    await expect(
      adapter.createOpenChallenge({
        whiteUsername: "Alice",
        blackUsername: "Bob",
        clock: { limit: 60, increment: 0 },
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws LichessHttpError 502 on a 200 response missing urlBlack", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "abcd1234",
      urlWhite: "https://lichess.org/abcd1234?color=white",
    }), { status: 200 }));
    const adapter = createLichessAdapter({ fetch });
    const call = adapter.createOpenChallenge({
      whiteUsername: "Alice",
      blackUsername: "Bob",
      clock: { limit: 60, increment: 0 },
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await expect(call).rejects.toBeInstanceOf(LichessHttpError);
    await expect(
      adapter.createOpenChallenge({
        whiteUsername: "Alice",
        blackUsername: "Bob",
        clock: { limit: 60, increment: 0 },
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("fetchGame", () => {
  it("parses a real finished (mate, White wins) export — derived from the recorded fixture", async () => {
    const g1 = rawFixture("export-mate-white.json");
    // Pin: this fixture must actually be the finished-by-mate, White-wins
    // case it exists to test, so the test can't pass on a mis-picked sample.
    expect(g1.status).toBe("mate");
    expect(g1.winner).toBe("white");

    const fetch = vi.fn(async () => new Response(raw("export-mate-white.json"), { status: 200 }));
    const game = await createLichessAdapter({ fetch }).fetchGame(g1.id);
    expect(game).toEqual({
      id: g1.id,
      status: g1.status,
      winner: g1.winner,
      players: {
        white: { userId: g1.players.white.user.id },
        black: { userId: g1.players.black.user.id },
      },
    });
  });

  it("parses a real in-progress export — no winner yet — derived from the recorded fixture", async () => {
    const g1 = rawFixture("export-started.json");
    // Pin: this fixture must actually be the in-progress case (no winner
    // key at all — Lichess omits it, never sends null while unresolved).
    expect(g1.status).toBe("started");
    expect(g1.winner).toBeUndefined();

    const fetch = vi.fn(async () => new Response(raw("export-started.json"), { status: 200 }));
    const game = await createLichessAdapter({ fetch }).fetchGame(g1.id);
    expect(game).toEqual({
      id: g1.id,
      status: g1.status,
      winner: undefined,
      players: {
        white: { userId: g1.players.white.user.id },
        black: { userId: g1.players.black.user.id },
      },
    });
  });

  it("returns null on 404 (challenge not yet accepted)", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    expect(await createLichessAdapter({ fetch }).fetchGame("nope")).toBeNull();
  });

  it("uses the shared timeout constant", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => new Response(raw("export-created.json"), { status: 200 }));
    await createLichessAdapter({ fetch }).fetchGame("x");
    expect(spy).toHaveBeenCalledWith(LICHESS_TIMEOUT_MS);
    spy.mockRestore();
  });
});
