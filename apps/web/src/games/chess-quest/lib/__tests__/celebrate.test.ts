// W2 — celebrate() gains the file-based "solve" cue alongside its existing
// fanfare + confetti (see celebrate.ts's header for why it lives here rather
// than in GameShell directly). sfx/fx are mocked so this stays a pure
// wiring test — sfx.fanfare()/fx.burst() already have their own coverage
// elsewhere (or none, pre-existing), this only asserts celebrate() calls all
// three collaborators.
import { describe, expect, it, vi } from "vitest";

const { fanfare, burst, playSfx } = vi.hoisted(() => ({
  fanfare: vi.fn(),
  burst: vi.fn(),
  playSfx: vi.fn(),
}));
vi.mock("../sfx", () => ({ sfx: { fanfare } }));
vi.mock("../fx", () => ({ burst }));
vi.mock("../useSfx", () => ({ playSfx }));

import { celebrate } from "../celebrate";

describe("celebrate", () => {
  it("plays the fanfare tone, the file-based solve cue, and the confetti burst", () => {
    const origin = {} as Element;
    celebrate(origin);
    expect(fanfare).toHaveBeenCalledTimes(1);
    expect(playSfx).toHaveBeenCalledWith("solve");
    expect(burst).toHaveBeenCalledWith(origin);
  });

  it("works with no origin element", () => {
    celebrate();
    expect(playSfx).toHaveBeenCalledWith("solve");
    expect(burst).toHaveBeenCalledWith(undefined);
  });
});
