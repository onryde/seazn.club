import { describe, expect, it, vi } from "vitest";
import { createLichessAdapter } from "../lichess/adapter";
import { LichessHttpError } from "../types";

describe("createLichessAdapter", () => {
  it("POSTs challenge as white with unrated clock fields", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "chal1",
        url: "https://lichess.org/chal1",
        status: "created",
      }),
    );

    const adapter = createLichessAdapter({ fetch: fetchMock as unknown as typeof fetch });
    const result = await adapter.createChallenge({
      whiteAccessToken: "tok-white",
      blackLichessUsername: "blackPlayer",
      clock: { limit: 600, increment: 5 },
      rated: false,
    });

    expect(result).toEqual({
      challengeId: "chal1",
      whitePlayUrl: "https://lichess.org/chal1",
      blackPlayUrl: "https://lichess.org/chal1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://lichess.org/api/challenge/blackPlayer");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-white");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("rated")).toBe("false");
    expect(body.get("color")).toBe("white");
    expect(body.get("clock.limit")).toBe("600");
    expect(body.get("clock.increment")).toBe("5");
  });

  it("throws LichessHttpError on 401", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const adapter = createLichessAdapter({ fetch: fetchMock as unknown as typeof fetch });
    await expect(
      adapter.createChallenge({
        whiteAccessToken: "bad",
        blackLichessUsername: "x",
        clock: { limit: 60, increment: 0 },
        rated: false,
      }),
    ).rejects.toBeInstanceOf(LichessHttpError);
    await expect(
      adapter.createChallenge({
        whiteAccessToken: "bad",
        blackLichessUsername: "x",
        clock: { limit: 60, increment: 0 },
        rated: false,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("throws LichessHttpError on 429", async () => {
    const fetchMock = vi.fn(async () => new Response("slow", { status: 429 }));
    const adapter = createLichessAdapter({ fetch: fetchMock as unknown as typeof fetch });
    await expect(
      adapter.createChallenge({
        whiteAccessToken: "tok",
        blackLichessUsername: "x",
        clock: { limit: 60, increment: 0 },
        rated: false,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("fetchGame maps export JSON to LichessGameSnapshot", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "g1",
        status: "mate",
        winner: "white",
        players: {
          white: { user: { id: "w1" } },
          black: { user: { id: "b1" } },
        },
      }),
    );
    const adapter = createLichessAdapter({ fetch: fetchMock as unknown as typeof fetch });
    const game = await adapter.fetchGame("g1");
    expect(game).toEqual({
      id: "g1",
      status: "mate",
      winner: "white",
      players: {
        white: { userId: "w1" },
        black: { userId: "b1" },
      },
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/game/export/g1");
    expect(String(url)).toContain("pgnInJson=true");
  });
});
