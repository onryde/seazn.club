// T17B fix 2, D24 (re-review I1) — the zero report reads the player's OWN face. A move dropped in time is never a clock at
// zero: while the optimistic guess applies, the face reads the guess (the clock as the drop left it, plus the
// increment), so the report that would otherwise go to the server the instant the SERVER's number reaches 0 is held.
// clock-optimistic.test.ts proves the pure faces; what nothing proved is the hook's own choice of WHICH face the zero
// test reads (use-clock-faces.ts) — replacing it with the server's number kept every suite green. This drives the REAL
// hook through the harness (real useServerNow tick, real effect) with an onZero spy and fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { useClockFaces } from "../use-clock-faces";
import { OPTIMISTIC_CLOCK_MAX_MS, type OptimisticClock } from "../clock-math";
import type { Colour, RoomGame, RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const c = new Chess();
for (const m of ["e2e4", "e7e5"]) c.move({ from: m.slice(0, 2), to: m.slice(2, 4) });

/** Two plies on the board, White to move, White's clock as at T0 and running (the clocks run from ply 2). */
const game = (whiteMs: number): RoomGame => ({
  gameId: "g1",
  moves: ["e2e4", "e7e5"],
  fen: c.fen(),
  lastMove: ["e7", "e5"],
  turn: "white",
  whiteMs,
  blackMs: 300_000,
  clockAsOf: new Date(T0).toISOString(),
  clockRunning: true,
  drawOfferBy: null,
  over: false,
});
const SNAP = { you: { colour: "white", name: "Bo Lind", checkedIn: true }, result: null } as unknown as Pick<RoomSnapshot, "you" | "result">;
/** The guess a move dropped at T0 leaves on a 0.5 s clock with a +3 increment: 0.5 + 3 = 3.5 s, true until ply 3 is on the ledger. */
const GUESS: OptimisticClock = { gameId: "g1", ply: 3, ms: 3_500, at: T0 };

type Props = { game: RoomGame; optimistic: OptimisticClock | null; onZero: () => void };
function Slot({ faces }: { faces: Record<Colour, number> }) {
  void faces; // read back through its props, never rendered
  return null;
}
function Probe({ game: g, optimistic, onZero }: Props) {
  return <Slot faces={useClockFaces({ game: g, snap: SNAP, skewMs: 0, optimistic, onZero })} />;
}
const facesOf = (island: ReturnType<typeof renderIsland<Props>>): Record<Colour, number> => {
  const slot = island.tree().find((el) => el.type === Slot);
  if (!slot) throw new Error("the probe rendered no slot");
  return propsOf(slot).faces as Record<Colour, number>;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("useClockFaces: the clock-at-zero report reads the face the player sees", () => {
  it("the empty case first: a clock with time on it reports nothing, with a guess or without", () => {
    for (const optimistic of [null, GUESS]) {
      const onZero = vi.fn();
      renderIsland<Props>(Probe, { game: game(60_000), optimistic, onZero });
      vi.advanceTimersByTime(5_000);
      expect(onZero, optimistic === null ? "no guess" : "a guess").not.toHaveBeenCalled();
    }
  });

  it("0.5 s on the server's clock, a move dropped at once (guess 3.5 s): +800 ms is past the server's zero and the report is NOT sent", () => {
    const onZero = vi.fn();
    const island = renderIsland<Props>(Probe, { game: game(500), optimistic: GUESS, onZero });
    vi.advanceTimersByTime(800);
    expect(facesOf(island).white, "premise: the face is the guess, frozen at what the drop left").toBe(3_500);
    expect(onZero, "a move dropped in time is not a clock at zero").not.toHaveBeenCalled();
  });

  it("the pair: the same clock with NO guess reports once the server's number is zero — and not a tick before", () => {
    const onZero = vi.fn();
    const island = renderIsland<Props>(Probe, { game: game(500), optimistic: null, onZero });
    vi.advanceTimersByTime(400);
    expect(facesOf(island).white, "premise: 0.1 s left at +400 ms").toBeGreaterThan(0);
    expect(onZero, "still above zero: nothing yet").not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(facesOf(island).white, "premise: past zero").toBe(0);
    expect(onZero, "the report goes").toHaveBeenCalled();
  });

  it("a guess is not a standing suppression: once it expires (a move Lichess never confirmed), the server's zero is reported", () => {
    const onZero = vi.fn();
    const island = renderIsland<Props>(Probe, { game: game(500), optimistic: GUESS, onZero });
    vi.advanceTimersByTime(OPTIMISTIC_CLOCK_MAX_MS - 100);
    expect(onZero, "inside the guess's life").not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(facesOf(island).white, "premise: the guess is gone, the server's number stands").toBe(0);
    expect(onZero, "the report returns with it").toHaveBeenCalled();
  });

  it("a guess that applies to the OTHER colour's clock does not hold the report (Black's drop never rescues White's zero)", () => {
    const onZero = vi.fn();
    // The viewer is Black; White's clock (the side to move) reaches zero. A guess for Black's own clock exists but the
    // side to move is White, so the zero test reads White's server number.
    const blackView = { you: { colour: "black", name: "Ada", checkedIn: true }, result: null } as unknown as Pick<RoomSnapshot, "you" | "result">;
    function BlackProbe({ onZero: z }: { onZero: () => void }) {
      return <Slot faces={useClockFaces({ game: game(500), snap: blackView, skewMs: 0, optimistic: { gameId: "g1", ply: 3, ms: 9_000, at: T0 }, onZero: z })} />;
    }
    renderIsland(BlackProbe, { onZero });
    vi.advanceTimersByTime(800);
    expect(onZero, "the mover's own server clock is what ran out").toHaveBeenCalled();
  });
});
