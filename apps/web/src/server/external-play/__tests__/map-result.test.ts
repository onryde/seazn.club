import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapLichessGameToBoardgameResult } from "../map-result";
import type { LichessGameSnapshot } from "../types";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/lichess");

function loadGame(name: string): LichessGameSnapshot {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as LichessGameSnapshot;
}

const ids = {
  homeEntrantId: "entrant-home",
  awayEntrantId: "entrant-away",
  homeLichessId: "lichess-home",
  awayLichessId: "lichess-away",
};

describe("mapLichessGameToBoardgameResult", () => {
  it("maps white mate to home winner when home is white on Lichess", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-mate-white.json"),
      ...ids,
    });
    expect(mapped).toEqual({
      ok: true,
      type: "boardgame.result",
      payload: { winner: "entrant-home", method: "checkmate" },
    });
  });

  it("maps resign with white winner to home", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-resign-white-wins.json"),
      ...ids,
    });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.payload).toEqual({ winner: "entrant-home", method: "resign" });
    }
  });

  it("maps outoftime black win to away + time", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-timeout-black-wins.json"),
      ...ids,
    });
    expect(mapped).toEqual({
      ok: true,
      type: "boardgame.result",
      payload: { winner: "entrant-away", method: "time" },
    });
  });

  it("maps draw to null winner + agreement", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-draw.json"),
      ...ids,
    });
    expect(mapped).toEqual({
      ok: true,
      type: "boardgame.result",
      payload: { winner: null, method: "agreement" },
    });
  });

  it("rejects when lichess ids do not match linked accounts", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-mismatch.json"),
      ...ids,
    });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toBe("account_mismatch");
  });

  it("returns abort as not ok", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-abort.json"),
      ...ids,
    });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toBe("abort");
  });

  it("returns unfinished when status is started", () => {
    const mapped = mapLichessGameToBoardgameResult({
      game: loadGame("game-started.json"),
      ...ids,
    });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toBe("unfinished");
  });
});
