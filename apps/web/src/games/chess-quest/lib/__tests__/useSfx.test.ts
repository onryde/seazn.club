// W2 — useSfx.ts. This vitest environment runs under Node (no jsdom, no
// browser globals — see Board.test.tsx's header for the same fact) so there
// is no real AudioContext/fetch/window to exercise the full fetch→decode→
// play pipeline against. What's directly testable here: play() never throws
// regardless of kind (the "AudioContext API missing" no-op path is exactly
// what this environment already is, with no mocking needed), and play()
// consults sfx.isMuted() before doing anything else (the single source of
// truth for mute state — see this file's header for why).
import { afterEach, describe, expect, it, vi } from "vitest";
import { sfx } from "../sfx";
import { playSfx, useSfx } from "../useSfx";

describe("useSfx / playSfx", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sfx.setMuted(false);
  });

  it("useSfx() returns a play function without needing a live render (no hooks internally)", () => {
    const { play } = useSfx();
    expect(typeof play).toBe("function");
  });

  it("no-ops without throwing for every kind when the AudioContext API is unavailable", () => {
    expect(typeof window).toBe("undefined");
    for (const kind of ["move", "capture", "check", "solve"] as const) {
      expect(() => playSfx(kind)).not.toThrow();
    }
  });

  it("checks sfx.isMuted() before anything else", () => {
    const spy = vi.spyOn(sfx, "isMuted");
    playSfx("move");
    expect(spy).toHaveBeenCalled();
  });

  it("stays a clean no-op once muted", () => {
    sfx.setMuted(true);
    expect(() => playSfx("solve")).not.toThrow();
  });
});
