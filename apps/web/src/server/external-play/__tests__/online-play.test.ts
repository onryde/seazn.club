import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import {
  assertOnlinePlayValue,
  readOnlinePlay,
  applyOnlinePlayToConfig,
} from "../online-play";

describe("online-play config helpers", () => {
  it("readOnlinePlay defaults to off", () => {
    expect(readOnlinePlay(null)).toBe("off");
    expect(readOnlinePlay({ scoring: { win: 2 } })).toBe("off");
    expect(readOnlinePlay({ onlinePlay: "lichess" })).toBe("lichess");
  });

  it("assertOnlinePlayValue allows lichess on boardgame", () => {
    expect(assertOnlinePlayValue("boardgame", "lichess")).toBe("lichess");
    expect(assertOnlinePlayValue("boardgame", "off")).toBe("off");
  });

  it("assertOnlinePlayValue rejects lichess on other sports", () => {
    expect(() => assertOnlinePlayValue("cricket", "lichess")).toThrow(HttpError);
    try {
      assertOnlinePlayValue("cricket", "lichess");
    } catch (err) {
      expect((err as HttpError).code).toBe("ONLINE_PLAY_SPORT");
    }
  });

  it("applyOnlinePlayToConfig sets or clears the key", () => {
    const cfg: Record<string, unknown> = { variant: "classical" };
    applyOnlinePlayToConfig(cfg, "lichess");
    expect(cfg.onlinePlay).toBe("lichess");
    applyOnlinePlayToConfig(cfg, "off");
    expect(cfg.onlinePlay).toBeUndefined();
  });
});
