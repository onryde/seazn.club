// Quick match plan 2, Task 2 (pre-flight amendments D1, A2, A3, B2, C2): the setup screen's every match count and
// knockout draw, computed on the server and handed to the setup island as a prop, so the number on the Start button is
// a lookup — never a fetch that can land stale or out of order.
//
// No DB. ONE table for every sport: the draw is the stage kind's, not the sport's. The engine's generators take no sport
// (spec §7.3: a league is `generateRoundRobin({ entrants, seeds, config: { legs } })`, a knockout `generateSingleElim`),
// the create builds its stage from `quickMatchStageInput` and its count from `quickMatchPreview`, neither of which takes
// a sport — the type test below pins both inputs, so adding one reds here before a per-sport table is needed — and plan
// 1's probe (`_quick-match-probe.ts` step 3) crosses the preview's count with real creates in every offered sport.
//
// Expected values come from the rulebook, never from running the code: a round robin plays n(n−1)/2 pairs × plays; a
// knockout pads to the next power of two S with the byes to the top seeds, seed i meets seed S+1−i (lib/format-
// templates.ts:104-107), the halves of an 8-draw are (1v8, 4v5) and (3v6, 2v7), and every match but the final sends one
// side home, so a knockout of n plays n − 1 matches. Spec §7.3 step 3 names who sits out.
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { previewStageDraw, type PreviewDrawFixture } from "../stages";
import {
  quickMatchPreview,
  quickMatchPreviewTable,
  quickMatchStageInput,
  type QuickMatchDrawSeat,
  type QuickMatchFormat,
  type QuickMatchKnockoutCell,
  type QuickMatchPreviewTable,
} from "../quick-match-preview";

/** The rulebook's ranges (CreateQuickMatch: 2..6 sides, 1..2 plays — Once | Twice, owner 2026-11-12; C16: two sides is
 *  always a league). */
const LEAGUE_KEYS = [2, 3, 4, 5, 6].flatMap((n) => [1, 2].map((p) => `league:${n}:${p}`));
const KNOCKOUT_KEYS = [3, 4, 5, 6].map((n) => `knockout:${n}:1`);

const knockout = (t: QuickMatchPreviewTable, n: number): QuickMatchKnockoutCell => {
  const cell = t[`knockout:${n}:1`];
  if (!cell) throw new Error(`no knockout cell for ${n} sides`);
  return cell;
};

/** A seat in words the rulebook uses: a seed's number, or W(<the pair it is the winner of>). */
function seatWords(cell: QuickMatchKnockoutCell, seat: QuickMatchDrawSeat): string {
  if ("seed" in seat) return String(seat.seed);
  const pair = cell.rounds[seat.winnerOf.round - 1]?.pairs[seat.winnerOf.pair - 1];
  if (!pair) throw new Error(`winnerOf ${JSON.stringify(seat.winnerOf)} names no pair`);
  return `W(${pairWords(cell, pair)})`;
}
const pairWords = (cell: QuickMatchKnockoutCell, pair: [QuickMatchDrawSeat, QuickMatchDrawSeat]) =>
  pair.map((s) => seatWords(cell, s)).sort().join("v");

describe("quickMatchPreviewTable — the cells", () => {
  it("holds exactly the 10 league cells (2..6 sides × 1..2 plays) and the 4 knockout cells (3..6 sides)", () => {
    const keys = Object.keys(quickMatchPreviewTable());
    expect(keys.length).toBe(14); // anti-vacuity: an empty table is a failure, not a pass
    expect(new Set(keys)).toEqual(new Set([...LEAGUE_KEYS, ...KNOCKOUT_KEYS]));
  });

  it("every league cell counts plays × n(n−1)/2 matches (round robin)", () => {
    const t = quickMatchPreviewTable();
    let checked = 0;
    for (let n = 2; n <= 6; n++)
      for (let plays = 1; plays <= 2; plays++) {
        expect(t[`league:${n}:${plays}`]?.matchCount, `league ${n}×${plays}`).toBe((plays * n * (n - 1)) / 2);
        checked++;
      }
    expect(checked).toBe(10);
  });

  it("every knockout cell counts n − 1 matches, and the top seeds sit out round one (spec §7.3 step 3)", () => {
    const t = quickMatchPreviewTable();
    const holders: Record<number, number[]> = { 3: [1], 4: [], 5: [1, 2, 3], 6: [1, 2] };
    let checked = 0;
    for (const n of [3, 4, 5, 6]) {
      const cell = knockout(t, n);
      expect(cell.matchCount, `knockout of ${n}`).toBe(n - 1);
      // a bye is no match: the pairs are the matches, and nothing else is
      expect(cell.rounds.flatMap((r) => r.pairs)).toHaveLength(n - 1);
      expect([...cell.byes].sort(), `knockout of ${n}`).toEqual(holders[n]);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // Hand-derived from the padded draw: 3 → S 4 (1v4 is a bye); 4 → S 4; 5 → S 8 (1v8, 2v7, 3v6 are byes); 6 → S 8
  // (1v8, 2v7 are byes). A bye holder takes the seat its bye line feeds, so round two names a SIDE, never "the winner"
  // of a match nobody plays — and with 5 sides, seeds 2 and 3 meet in a semi-final everyone can see coming.
  it.each([
    [3, [["2v3"], ["1vW(2v3)"]]],
    [4, [["1v4", "2v3"], ["W(1v4)vW(2v3)"]]],
    [5, [["4v5"], ["1vW(4v5)", "2v3"], ["W(1vW(4v5))vW(2v3)"]]],
    [6, [["3v6", "4v5"], ["1vW(4v5)", "2vW(3v6)"], ["W(1vW(4v5))vW(2vW(3v6))"]]],
  ])("the knockout of %i draws %j, round by round", (n, rounds) => {
    const cell = knockout(quickMatchPreviewTable(), n);
    // the PAIRING is the assertion, not the order of the pairs in a round
    expect(cell.rounds.map((r) => new Set(r.pairs.map((p) => pairWords(cell, p))))).toEqual(rounds.map((r) => new Set(r)));
  });

  // The rulebook names a knockout round by its distance from the final; S has log2(S) rounds.
  it.each([
    [3, ["semi_final", "final"]],
    [4, ["semi_final", "final"]],
    [5, ["quarter_final", "semi_final", "final"]],
    [6, ["quarter_final", "semi_final", "final"]],
  ])("the knockout of %i names its rounds %j", (n, roles) => {
    expect(knockout(quickMatchPreviewTable(), n).rounds.map((r) => r.role?.kind)).toEqual(roles);
  });

  it("a winner's seat only ever names an EARLIER round's pair (no loop, no forward reference)", () => {
    const t = quickMatchPreviewTable();
    let seats = 0;
    for (const n of [3, 4, 5, 6]) {
      const cell = knockout(t, n);
      cell.rounds.forEach((r, i) =>
        r.pairs.flat().forEach((s) => {
          if ("winnerOf" in s) expect(s.winnerOf.round, `knockout of ${n}, round ${i + 1}`).toBeLessThan(i + 1);
          seats++;
        }),
      );
    }
    // two seats per match: 2 × (2 + 3 + 4 + 5)
    expect(seats).toBe(28);
  });
});

describe("quickMatchPreviewTable — the exhaustive differential against the direct calls", () => {
  // Every cell against `quickMatchPreview` called directly, and every knockout seat against the generator's own RAW
  // draw (`previewStageDraw`), which carries each fixture's explicit seq — so a feeder is resolved here by lookup on
  // (round, seq), independently of the table's walk over the fold's ordered lines.
  it("every cell's count, every knockout round's role, bye and pair, and every seat equal the direct calls", () => {
    const t = quickMatchPreviewTable();
    let cells = 0;
    let seats = 0;
    for (const key of Object.keys(t)) {
      const [format, sides, plays] = key.split(":") as [QuickMatchFormat, string, string];
      const input = { format, sides: Number(sides), plays: Number(plays) };
      const direct = quickMatchPreview(input);
      cells++;
      if (format === "league") {
        expect(t[key as `league:${number}:${number}`], key).toEqual({ matchCount: direct.matchCount });
        continue;
      }
      const cell = knockout(t, input.sides);
      expect(cell.matchCount, key).toBe(direct.matchCount);
      expect(cell.rounds.map((r) => r.role), key).toEqual(direct.rounds.map((r) => r.role));
      expect(cell.byes, key).toEqual(direct.rounds.flatMap((r) => r.lines.filter((l) => l.bye).map((l) => l.home.seed)));

      const raw = previewStageDraw(quickMatchStageInput({ format: "knockout", plays: 1, name: "x" }), input.sides);
      const at = (round: number, seq: number): PreviewDrawFixture => {
        const f = raw.find((x) => x.roundNo === round && x.seqInRound === seq);
        if (!f) throw new Error(`${key}: no raw fixture R${round}·${seq}`);
        return f;
      };
      // a raw fixture's place among its round's matches (byes skipped), in seq order: its 1-based pair number
      const pairNo = (f: PreviewDrawFixture) =>
        raw.filter((x) => x.roundNo === f.roundNo && !x.bye && x.seqInRound <= f.seqInRound).length;
      const expectedSeat = (seed: number | null, from: PreviewDrawFixture["homeFrom"]): QuickMatchDrawSeat => {
        if (seed !== null) return { seed };
        const src = at(from!.round, from!.seq);
        return src.bye ? { seed: src.homeSeed! } : { winnerOf: { round: src.roundNo, pair: pairNo(src) } };
      };
      for (const f of raw.filter((x) => !x.bye)) {
        const pair = cell.rounds[f.roundNo - 1]?.pairs[pairNo(f) - 1];
        expect(pair, `${key} R${f.roundNo}·${f.seqInRound}`).toEqual([
          expectedSeat(f.homeSeed, f.homeFrom),
          expectedSeat(f.awaySeed, f.awayFrom),
        ]);
        seats += 2;
      }
      expect(cell.rounds.flatMap((r) => r.pairs), key).toHaveLength(raw.filter((x) => !x.bye).length);
    }
    expect(cells).toBe(14); // anti-vacuity
    expect(seats).toBe(28); // 2 × (2 + 3 + 4 + 5)
  });
});

describe("quickMatchPreviewTable — ONE table for every sport, and small enough to ship in the page", () => {
  it("neither the table nor the preview and stage input it is built from take a sport", () => {
    // Compile-time only (vitest runs no assertion here): tsc checks these, scoped locally and in CI. A sport parameter
    // added to any of the three reds here — mutated once, an optional `sport` on two of them gave TS2741 on both lines —
    // which is the moment a per-sport table would be owed.
    expectTypeOf(quickMatchPreviewTable).parameters.toEqualTypeOf<[]>();
    expectTypeOf<Parameters<typeof quickMatchPreview>[0]>().toEqualTypeOf<{ format: QuickMatchFormat; sides: number; plays: number }>();
    expectTypeOf<Parameters<typeof quickMatchStageInput>[0]>().toEqualTypeOf<{ format: QuickMatchFormat; plays: number; name: string }>();
  });

  it("serializes inside a 2 KiB budget, and its shape holds exactly 104 keys", () => {
    // The table rides in every /play page payload: the budget is the requirement.
    const t = quickMatchPreviewTable();
    expect(JSON.stringify(t).length).toBeLessThanOrEqual(2048);
    // The shape's tripwire: every object key in the table, NOT descending into `role` (the engine's RoundRole may grow
    // a field without the table changing shape). Hand count: 14 cell keys + 10 league `matchCount` + 4 knockout cells ×
    // 3 (matchCount, byes, rounds) + 10 rounds (2 + 2 + 3 + 3) × 2 (role, pairs) + 28 seats × 1 (seed | winnerOf) +
    // 10 winnerOf seats (every match but the final feeds one: n − 2 for n = 3..6) × 2 (round, pair) = 104.
    const keysIn = (v: unknown): number =>
      Array.isArray(v)
        ? v.reduce((n: number, x) => n + keysIn(x), 0)
        : v !== null && typeof v === "object"
          ? Object.entries(v).reduce((n, [k, x]) => n + 1 + (k === "role" ? 0 : keysIn(x)), 0)
          : 0;
    expect(keysIn(t)).toBe(104);
  });
});

describe("quickMatchPreviewTable — a knockout seat it cannot name is refused, never shown blank or mislabeled", () => {
  afterEach(() => {
    vi.doUnmock("../stages");
    vi.resetModules();
  });

  const r1 = { roundNo: 1, role: null, homeFrom: null, awayFrom: null };
  const holder = { ...r1, seqInRound: 1, homeSeed: 1, awaySeed: null, bye: true };
  const match = { ...r1, seqInRound: 2, homeSeed: 2, awaySeed: 3, bye: false };
  const final = { roundNo: 2, seqInRound: 1, homeSeed: null, awaySeed: null, bye: false, role: null };
  const winner = (round: number, seq: number) => ({ round, seq, side: "winner" });

  it.each([
    ["a bye whose holder is no seed", [{ ...holder, homeSeed: null, homeFrom: winner(1, 2) }, match, { ...final, homeFrom: winner(1, 1), awayFrom: winner(1, 2) }]],
    ["a seat fed by a match that is not in the draw", [holder, match, { ...final, homeFrom: winner(1, 1), awayFrom: winner(1, 9) }]],
    ["a seat that is both seeded and fed", [holder, match, { ...final, homeSeed: 4, homeFrom: winner(1, 1), awayFrom: winner(1, 2) }]],
  ])("refuses %s", async (_label, drawn) => {
    // The real generator draws none of these (the sweeps above); a stub draw reaches the guard. The next test is its
    // positive pair: the same stub with well-formed seats is accepted.
    vi.resetModules();
    vi.doMock("../stages", () => ({ previewStageDraw: () => drawn }));
    const { quickMatchPreviewTable: fresh } = await import("../quick-match-preview");
    expect(() => fresh()).toThrow(/^quickMatchPreviewTable cannot name /);
  });

  it("the stubbed path accepts a well-formed draw (so the refusals above are the seat's, not the stub's)", async () => {
    vi.resetModules();
    const drawn = [holder, match, { ...final, homeFrom: winner(1, 1), awayFrom: winner(1, 2) }];
    vi.doMock("../stages", () => ({ previewStageDraw: () => drawn }));
    const { quickMatchPreviewTable: fresh } = await import("../quick-match-preview");
    // the bye holder takes the final's home seat; the away seat is the winner of the one real match
    expect(fresh()["knockout:4:1"]).toEqual({
      matchCount: 2,
      byes: [1],
      rounds: [
        { role: null, pairs: [[{ seed: 2 }, { seed: 3 }]] },
        { role: null, pairs: [[{ seed: 1 }, { winnerOf: { round: 1, pair: 1 } }]] },
      ],
    });
  });
});
