// Opening Trainer + Coin Hop as a learner plays them (ESLint L3). Opening
// Trainer's glow and status used to be set from a ply-driven effect, and its
// completion ran there too; they are now derived from the ply (the learner's
// own taps tagged with theirs), the reply plays from its timer, and the line
// finishes from whatever move completed it. Coin Hop's board used to be an
// empty board that a mount effect dealt; it is dealt in a lazy initial state
// and from the events that re-deal. Pinned in sequence, with expected squares
// and SAN taken from the OPENINGS book, never from the component:
//   - a white line: hint → select → move → "watch the reply" → reply → … →
//     complete (opponent-ending), with a mistake on the way, then Play again;
//   - a learner-ending line (London) completes on the learner's own move;
//   - a black line: the trainer moves first, then the learner's hint;
//   - Restart during a pending reply cancels it (never a double move);
//   - Coin Hop: a dealt board at once, New coins re-deals, the same piece
//     changes nothing, another piece re-deals with that piece.
// One sport by nature (chess); every opening's line is swept by the e2e
// walkthroughs in e2e/games.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const progress = vi.hoisted(() => ({ stars: [] as [string, number][] }));
vi.mock("../../lib/progress", () => ({
  useProgress: () => ({ setGameStars: (g: string, n: number) => progress.stars.push([g, n]) }),
}));
vi.mock("../../lib/celebrate", () => ({ celebrate: () => {} }));
vi.mock("../../lib/sfx", () => ({ sfx: { move: () => {}, bad: () => {}, coin: () => {} } }));
vi.mock("../../lib/voice", () => ({ voice: { say: () => {} } }));

import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { OPENINGS } from "../../content/openings";
import { fileOf, rankRow, sqIdx } from "../../engine";
import { Board } from "../Board";
import { GameShell } from "../GameShell";
import { OpeningTrainer } from "../games/OpeningTrainer";
import { CoinHop } from "../games/CoinHop";

beforeEach(() => {
  vi.useFakeTimers();
  progress.stars.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

type Island = { tree: () => ReactElement[] };
const board = (i: Island) => propsOf(i.tree().find((e) => e.type === Board)!) as {
  position: string[];
  highlights: Record<number, string>;
  coins?: Set<number>;
  onTap: (idx: number) => void;
};
const shell = (i: Island) => propsOf(i.tree().find((e) => e.type === GameShell)!);
const status = (i: Island) => String(shell(i).status);
const tap = (i: Island, sq: string) => board(i).onTap(sqIdx(sq));
const control = (i: Island) => textOf(shell(i).controls as ReactElement);
const press = (i: Island) => (propsOf(shell(i).controls as ReactElement).onClick as () => void)();

describe("Opening Trainer", () => {
  it("a white line, opponent-ending: hint, select, move, reply, a mistake, completion, Play again", () => {
    const op = OPENINGS.italian;
    expect(op.learnerSide).toBe("white");
    expect(op.line.length % 2, "anti-vacuity: ends on the opponent's move").toBe(0);
    const t = renderIsland(OpeningTrainer, { opening: "italian" });

    expect(board(t).highlights).toEqual({ [sqIdx(op.line[0].from)]: "hint" });
    expect(status(t)).toContain(`<strong>${op.line[0].san}</strong>`);

    tap(t, op.line[0].from);
    expect(board(t).highlights[sqIdx(op.line[0].from)], "selected (and still the book square)").toBe("hint");
    expect(Object.values(board(t).highlights)).toContain("move");
    tap(t, op.line[0].to);
    expect(board(t).position[sqIdx(op.line[0].to)]).toBe("P");
    expect(board(t).highlights, "the reply's beat glows nothing").toEqual({});
    expect(status(t)).toContain("watch the reply");

    vi.advanceTimersByTime(550);
    expect(board(t).position[sqIdx(op.line[1].to)]).toBe("p");
    expect(board(t).highlights).toEqual({ [sqIdx(op.line[2].from)]: "hint" });
    expect(status(t)).toContain(`<strong>${op.line[2].san}</strong>`);

    // A legal move that is not the book move: the mistake is named, the hint stays.
    tap(t, "g1");
    tap(t, "h3");
    expect(status(t)).toContain("Not the book move");
    expect(board(t).highlights).toEqual({ [sqIdx(op.line[2].from)]: "hint" });

    for (let ply = 2; ply < op.line.length; ply += 2) {
      tap(t, op.line[ply].from);
      tap(t, op.line[ply].to);
      expect(progress.stars, "not finished before the last reply").toEqual([]);
      vi.advanceTimersByTime(550);
    }
    expect(status(t)).toContain("you played the whole line");
    expect(progress.stars).toHaveLength(1);
    expect(board(t).highlights).toEqual({});
    expect(control(t)).toBe("Play again");

    press(t);
    expect(board(t).highlights).toEqual({ [sqIdx(op.line[0].from)]: "hint" });
    expect(board(t).position[sqIdx(op.line[0].from)]).toBe("P");
    expect(control(t)).toBe("Restart");
  });

  it("a learner-ending line completes on the learner's own move", () => {
    const op = OPENINGS.london;
    expect(op.line.length % 2, "anti-vacuity: ends on the learner's move").toBe(1);
    const t = renderIsland(OpeningTrainer, { opening: "london" });
    for (let ply = 0; ply < op.line.length; ply += 2) {
      tap(t, op.line[ply].from);
      tap(t, op.line[ply].to);
      vi.advanceTimersByTime(550);
    }
    expect(status(t)).toContain("you played the whole line");
    expect(progress.stars).toEqual([["openingTrainer", expect.any(Number)]]);
  });

  it("a black line: the trainer plays first, then the learner's hint", () => {
    const op = OPENINGS.scandinavian;
    expect(op.learnerSide).toBe("black");
    const t = renderIsland(OpeningTrainer, { opening: "scandinavian" });
    expect(status(t)).toContain("watch the reply");
    expect(board(t).highlights).toEqual({});
    vi.advanceTimersByTime(550);
    expect(board(t).position[sqIdx(op.line[0].to)]).toBe("P");
    expect(board(t).highlights).toEqual({ [sqIdx(op.line[1].from)]: "hint" });
  });

  it("Restart while a reply is pending cancels it — the reply never lands on the fresh board", () => {
    const op = OPENINGS.italian;
    const t = renderIsland(OpeningTrainer, { opening: "italian" });
    tap(t, op.line[0].from);
    tap(t, op.line[0].to);
    press(t); // Restart, mid-beat
    vi.advanceTimersByTime(2000);
    expect(board(t).position[sqIdx(op.line[1].from)], "black's pawn never moved").toBe("p");
    expect(board(t).position[sqIdx(op.line[1].to)]).toBe("");
    expect(board(t).highlights).toEqual({ [sqIdx(op.line[0].from)]: "hint" });
  });
});

describe("Coin Hop", () => {
  const dealt = (i: Island) => {
    const { position, coins } = board(i);
    const at = position.findIndex((p) => p !== "");
    return { piece: position[at], at, coins: [...(coins ?? [])].sort((a, b) => a - b) };
  };
  const chips = (i: Island) => {
    const picker = shell(i).picker as { children: ReactElement } | undefined;
    return (propsOf(picker!.children).children as ReactElement[]).map((c) => ({
      label: textOf(c),
      pick: propsOf(c).onClick as () => void,
    }));
  };

  it("deals a real board at once: the piece around the middle, six coins off its square", () => {
    const { piece, at, coins } = dealt(renderIsland(CoinHop, { pieces: ["N"] }));
    expect(piece).toBe("N");
    expect(at).toBeGreaterThanOrEqual(27);
    expect(at).toBeLessThanOrEqual(36);
    expect(coins).toHaveLength(6);
    expect(coins).not.toContain(at);
  });

  it("a bishop's coins all sit on its own colour", () => {
    const { at, coins } = dealt(renderIsland(CoinHop, { pieces: ["B"] }));
    const colour = (i: number) => (fileOf(i) + rankRow(i)) % 2;
    expect(coins.map(colour)).toEqual(coins.map(() => colour(at)));
  });

  it("New coins re-deals; the piece in play changes nothing; another piece re-deals with it", () => {
    let n = 0;
    // Deterministic but distinct deals: a different random stream per deal.
    vi.spyOn(Math, "random").mockImplementation(() => ((n = (n * 9301 + 49297) % 233280) / 233280));
    const t = renderIsland(CoinHop, { pieces: ["N", "R"] });
    const first = dealt(t);

    press(t);
    expect(dealt(t), "New coins").not.toEqual(first);
    const second = dealt(t);

    chips(t).find((c) => c.label.includes("Knight"))!.pick();
    expect(dealt(t), "the knight is already in play").toEqual(second);

    chips(t).find((c) => c.label.includes("Rook"))!.pick();
    expect(dealt(t).piece).toBe("R");
    vi.restoreAllMocks();
  });
});
