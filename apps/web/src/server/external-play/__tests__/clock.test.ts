import { describe, expect, it } from "vitest";
import { mapBoardgameClockToLichess } from "../clock";

describe("mapBoardgameClockToLichess", () => {
  it("maps Fischer 600+5", () => {
    expect(mapBoardgameClockToLichess({ base: 600, increment: 5 })).toEqual({
      ok: true,
      clock: { limit: 600, increment: 5 },
    });
  });

  it("rejects delay", () => {
    const mapped = mapBoardgameClockToLichess({ base: 300, delay: 3 });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toBe("delay_unsupported");
  });

  it("sudden death uses increment 0", () => {
    expect(mapBoardgameClockToLichess({ base: 900 })).toEqual({
      ok: true,
      clock: { limit: 900, increment: 0 },
    });
  });

  it("rejects missing clock", () => {
    const mapped = mapBoardgameClockToLichess(undefined);
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toBe("missing_clock");
  });

  it("rejects delay even when increment is also set", () => {
    const mapped = mapBoardgameClockToLichess({ base: 600, increment: 5, delay: 2 });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.reason).toBe("delay_unsupported");
  });
});
